/**
 * Copyright (c) Microsoft Corporation
 * All rights reserved.
 *
 * MIT License
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
 * to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED *AS IS*, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 * BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

'use strict';

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as component from '../../common/component';
import { getExperimentId, getPlatform } from '../../common/experimentStartupInfo';
import { getLogger, Logger } from '../../common/log';
import { NNIManagerIpConfig, TrainingService, TrialJobApplicationForm, TrialJobMetric, TrialJobStatus } from '../../common/trainingService';
import { delay, getLogLevel, getVersion, uniqueString, getExperimentRootDir } from '../../common/utils';
import { CONTAINER_INSTALL_NNI_SHELL_FORMAT } from '../common/containerJobData';
import { TrialConfig } from '../common/trialConfig';
import { TrialConfigMetadataKey } from '../common/trialConfigMetadataKey';
import { validateCodeDir, execCopydir, execMkdir } from '../common/util';
import { EnvironmentInformation, EnvironmentService, RunnerSettings } from './environment';
import { JobRestServer } from './jobRestServer';
import { StorageService } from './storageService';
import { TrialDetail, TrialService } from './trial';

/**
 * It uses to manage jobs on training platforms 
 * and expose trial as trial job to upper level.
**/
@component.Singleton
class TrialDispatcher implements TrainingService {

    private readonly log: Logger;
    private readonly isDeveloping: boolean = false;
    private stopping: boolean = false;

    private jobRestServer: JobRestServer;
    private readonly metricsEmitter: EventEmitter;
    private versionCheck: boolean = true;
    private readonly experimentId: string;
    private readonly experimentRootDir: string;

    private trialConfig: TrialConfig | undefined;
    private runnerSettings: RunnerSettings;

    private readonly trials: Map<string, TrialDetail>;
    private readonly environments: Map<string, EnvironmentInformation>;

    constructor() {
        this.log = getLogger();
        this.trials = new Map<string, TrialDetail>();
        this.environments = new Map<string, EnvironmentInformation>();
        this.metricsEmitter = new EventEmitter();
        this.jobRestServer = new JobRestServer(this.metricsEmitter);
        this.experimentId = getExperimentId();
        this.experimentRootDir = getExperimentRootDir();

        this.runnerSettings = new RunnerSettings();
        this.runnerSettings.experimentId = this.experimentId;
        this.runnerSettings.platform = getPlatform();

        const logLevel = getLogLevel();

        this.log.debug(`current folder ${__dirname}`);
        // different source folder in Linux and Windows
        if (logLevel == "debug" && (fs.existsSync("../../../src/nni_manager") || __dirname.endsWith("src\\nni_manager\\dist\\training_service\\reusable"))) {
            this.log.debug("log level is debug, and exist code folder, so set to developing mode.");
            this.isDeveloping = true;
            this.runnerSettings.enableGpuCollector = true;
        }
    }

    public async listTrialJobs(): Promise<TrialDetail[]> {
        const trials: TrialDetail[] = [];

        for (const key of this.trials.keys()) {
            trials.push(await this.getTrialJob(key));
        }

        return trials;
    }

    public async getTrialJob(trialJobId: string): Promise<TrialDetail> {
        const trial: TrialDetail | undefined = this.trials.get(trialJobId);
        if (trial === undefined) {
            throw new Error(`trial job ${trialJobId} not found`);
        }

        return trial;
    }

    public async submitTrialJob(form: TrialJobApplicationForm): Promise<TrialDetail> {
        if (this.trialConfig === undefined) {
            throw new Error(`trialConfig not initialized!`);
        }

        const trialId: string = uniqueString(5);

        const environmentService = component.get<EnvironmentService>(EnvironmentService);
        let trialWorkingFolder: string = "";
        if (environmentService.hasStorageService) {
            const storageService = component.get<StorageService>(StorageService);
            trialWorkingFolder = storageService.joinPath('trials', trialId);
        }
        const trialJobDetail: TrialDetail = new TrialDetail(trialId, "WAITING", Date.now(), trialWorkingFolder, form);

        this.trials.set(trialId, trialJobDetail);

        return trialJobDetail;
    }

    // to support multi phase
    public async updateTrialJob(trialJobId: string, form: TrialJobApplicationForm): Promise<TrialDetail> {
        const trialDetail = await this.getTrialJob(trialJobId);

        const trialService = component.get<TrialService>(TrialService);
        await trialService.updateTrial(trialDetail, form);

        return trialDetail;
    }

    public async cancelTrialJob(trialJobId: string, isEarlyStopped?: boolean | undefined): Promise<void> {
        const trial = await this.getTrialJob(trialJobId);
        switch (trial.status) {
            case "RUNNING":
            case "WAITING":
            case "UNKNOWN":
                {
                    const environment = trial.environment;
                    if (environment) {
                        const trialService = component.get<TrialService>(TrialService);
                        await trialService.stopTrial(trial);
                        trial.isEarlyStopped = isEarlyStopped;
                        trial.status = trial.isEarlyStopped === true ?
                            'EARLY_STOPPED' : 'USER_CANCELED';
                        this.releaseEnvironment(trial);
                    }
                }
                break;
        }
    }

    public async run(): Promise<void> {

        await this.jobRestServer.start();
        this.jobRestServer.setEnableVersionCheck = this.versionCheck;
        this.log.info(`Environment Manager rest server listening on: ${this.jobRestServer.endPoint}`);
        this.runnerSettings.nniManagerPort = this.jobRestServer.clusterRestServerPort;

        if (this.trialConfig === undefined) {
            throw new Error(`trial config shouldn't be undefined in run()`);
        }

        const environmentService = component.get<EnvironmentService>(EnvironmentService);
        if (environmentService.hasStorageService) {
            this.log.info(`Environment Manager copying code and settings.`);
            const storageService = component.get<StorageService>(StorageService);
            // Copy the compressed file to remoteDirectory and delete it
            const codeDir = path.resolve(this.trialConfig.codeDir);
            const envDir = storageService.joinPath("envs");
            const codeFileName = await storageService.copyDirectory(codeDir, envDir, true);
            storageService.rename(codeFileName, "nni-code.tar.gz");

            const installFileName = storageService.joinPath(envDir, 'install_nni.sh');
            await storageService.save(CONTAINER_INSTALL_NNI_SHELL_FORMAT, installFileName);

            const runnerSettings = storageService.joinPath(envDir, "settings.json");
            await storageService.save(JSON.stringify(this.runnerSettings), runnerSettings);

            if (this.isDeveloping) {
                let trialToolsPath = path.join(__dirname, "../../../../../tools/nni_trial_tool");
                if (false === fs.existsSync(trialToolsPath)) {
                    trialToolsPath = path.join(__dirname, "..\\..\\..\\..\\..\\tools\\nni_trial_tool");
                }
                await storageService.copyDirectory(trialToolsPath, envDir, true);
            }
        }

        this.log.info(`Environment Manager run loop started.`);
        await Promise.all([
            this.environmentMaintenanceLoop(),
            this.trialManagementLoop(),
        ]);
    }

    public addTrialJobMetricListener(listener: (metric: TrialJobMetric) => void): void {
        this.metricsEmitter.on('metric', listener);
    }

    public removeTrialJobMetricListener(listener: (metric: TrialJobMetric) => void): void {
        this.metricsEmitter.off('metric', listener);
    }

    public get isMultiPhaseJobSupported(): boolean {
        return true;
    }

    public async setClusterMetadata(key: string, value: string): Promise<void> {
        switch (key) {
            case TrialConfigMetadataKey.NNI_MANAGER_IP:
                this.runnerSettings.nniManagerIP = (<NNIManagerIpConfig>JSON.parse(value)).nniManagerIp;
                break;
            case TrialConfigMetadataKey.VERSION_CHECK:
                this.versionCheck = (value === 'true' || value === 'True');
                this.runnerSettings.nniManagerVersion = this.versionCheck ? await getVersion() : '';
                break;
            case TrialConfigMetadataKey.LOG_COLLECTION:
                this.runnerSettings.logCollection = value;
                break;
            case TrialConfigMetadataKey.TRIAL_CONFIG:
                // TODO to support more storage types by better parameters.
                this.trialConfig = <TrialConfig>JSON.parse(value);

                this.runnerSettings.command = this.trialConfig.command;
                // Validate to make sure codeDir doesn't have too many files
                await validateCodeDir(this.trialConfig.codeDir);
                break;
        }
        const environmentService = component.get<EnvironmentService>(EnvironmentService);
        await environmentService.config(key, value);
    }

    public getClusterMetadata(_key: string): Promise<string> {
        throw new Error('Not implemented!');
    }

    public async cleanUp(): Promise<void> {
        this.stopping = true;
        const environmentService = component.get<EnvironmentService>(EnvironmentService);
        const environments = [...this.environments.values()];
        for (let index = 0; index < environments.length; index++) {
            const environment = environments[index];
            if (environment.isAlive === true) {
                this.log.info(`stopping environment ${environment.id}...`);
                await environmentService.stopEnvironment(environment);
                this.log.info(`stopped environment ${environment.id}.`);
            }
        }

        try {
            await this.jobRestServer.stop();
            this.log.info('Rest server stopped successfully.');
        } catch (error) {
            this.log.error(`Rest server stopped failed, error: ${error.message}`);
        }
    }

    private async environmentMaintenanceLoop(): Promise<void> {
        const environmentService = component.get<EnvironmentService>(EnvironmentService);
        while (!this.stopping) {
            const environments: EnvironmentInformation[] = [];
            this.environments.forEach((environment) => {
                if (environment.isAlive === true) {
                    environments.push(environment);
                }
            });
            await environmentService.refreshEnvironmentsStatus(environments);

            environments.forEach((environment) => {
                const oldIsAlive = environment.isAlive;
                switch (environment.status) {
                    case 'WAITING':
                    case 'RUNNING':
                    case 'UNKNOWN':
                        environment.isAlive = true;
                        break;
                    default:
                        environment.isAlive = false;
                        break;
                }
                if (oldIsAlive !== environment.isAlive) {
                    this.log.debug(`set environment ${environment.id} isAlive from ${oldIsAlive} to ${environment.isAlive} due to status is ${environment.status}.`);
                }
            });
            await delay(5000);
        }
    }

    private async trialManagementLoop(): Promise<void> {
        while (!this.stopping) {
            await delay(2000);

            const toRefreshedTrials: TrialDetail[] = [];
            for (const trial of this.trials.values()) {
                if (trial.status === "RUNNING" || trial.status === "WAITING" || trial.status === "UNKNOWN") {
                    toRefreshedTrials.push(trial);
                }
            }

            if (toRefreshedTrials.length == 0) {
                continue;
            }

            const trialService = component.get<TrialService>(TrialService);
            trialService.refreshTrialsStatus(toRefreshedTrials);

            const waitingTrials: TrialDetail[] = [];
            let liveTrialsCount = 0;
            for (const trial of toRefreshedTrials) {
                const currentStatus = trial.status;
                switch (currentStatus) {
                    case "RUNNING":
                        {
                            const environment = trial.environment;

                            if (environment === undefined) {
                                this.log.error(`found running trial ${trial.id} has no environment, set trial to UNKNOWN.`);
                                trial.status = "UNKNOWN";
                                liveTrialsCount++;
                                continue;
                            }
                            const environmentStatus = environment.status;

                            // any node exit, then make sure the whole trial stopped.
                            if (trial.nodeExitResults.length > 0) {
                                const completedCount = trial.nodeExitResults.length;
                                let finalStatus: TrialJobStatus = "SUCCEEDED";
                                this.log.debug(`found ${completedCount} completed trial node(s), nodeCount: ${environment.nodeCount}`);

                                // if some trial processes doesn't exit, kill it for next one.
                                // for example, in horovod, it's just sleep command, has no impact on trial result.
                                if (environment.nodeCount > completedCount) {
                                    this.log.info(`stop partial completed trial ${trial.id}`);
                                    const trialService = component.get<TrialService>(TrialService);
                                    await trialService.stopTrial(trial);
                                }
                                for (const nodeStatus of trial.nodeExitResults) {
                                    if (nodeStatus == "FAILED") {
                                        finalStatus = "FAILED";
                                    }
                                }
                                trial.status = finalStatus;
                                this.releaseEnvironment(trial);
                            } else if (environmentStatus !== "RUNNING") {
                                this.log.error(`found running trial ${trial.id} on '${environment.jobId}' with '${environmentStatus}', set trial to environment status.`);
                                this.releaseEnvironment(trial);
                                trial.status = environmentStatus;
                            } else {
                                liveTrialsCount++;
                            }
                        }
                        break;
                    case "WAITING":
                    case "UNKNOWN":
                        // deal it later, if there is free environment.
                        waitingTrials.push(trial);
                        liveTrialsCount++;
                        break;
                }
            }

            let liveEnvironmentsCount = 0;
            const idleEnvironments: EnvironmentInformation[] = [];
            this.environments.forEach((environment) => {
                if (environment.isAlive === true) {
                    liveEnvironmentsCount++;
                    if (environment.status === "RUNNING" && environment.isIdle) {
                        idleEnvironments.push(environment);
                    }
                }
            });

            while (idleEnvironments.length > 0 && waitingTrials.length > 0) {
                const trial = waitingTrials.shift();
                const idleEnvironment = idleEnvironments.shift();
                if (trial !== undefined && idleEnvironment != undefined) {
                    await this.assignEnvironment(trial, idleEnvironment);
                }
            }

            if (liveEnvironmentsCount < liveTrialsCount) {
                this.log.info(`request new environment, since live trials ${liveTrialsCount} ` +
                    `is more than live environments ${liveEnvironmentsCount}`);
                for (let index = 0; index < liveTrialsCount - liveEnvironmentsCount; index++) {
                    await this.requestEnvironment();
                }
            }
        }
    }

    private async requestEnvironment(): Promise<void> {
        const environmentService = component.get<EnvironmentService>(EnvironmentService);
        const envId = uniqueString(5);
        const name = `nni_exp_${this.experimentId}_env_${envId}`;
        const environment = new EnvironmentInformation(envId, name);

        if (this.trialConfig === undefined) {
            throw new Error(`trial config shouldn't be undefined in run()`);
        }

        environment.command = `sh ../install_nni.sh && python3 -m nni_trial_tool.trial_runner`;

        if (this.isDeveloping) {
            environment.command = "mkdir ./nni_trial_tool && tar -xof ../nni_trial_tool.tar.gz -C ./nni_trial_tool &&" + environment.command;
        }

        if (environmentService.hasStorageService) {
            const storageService = component.get<StorageService>(StorageService);
            environment.workingFolder = storageService.joinPath("envs", envId);
            await storageService.createDirectory(environment.workingFolder);
        } else {
            //write configuration to local folder, for AML
            let environmentLocalTempFolder = path.join(this.experimentRootDir, this.experimentId, "environment-temp", envId);
            await execMkdir(environmentLocalTempFolder);
            const runnerSettingsPath = path.join(environmentLocalTempFolder, "settings.json");
            await fs.promises.writeFile(runnerSettingsPath, JSON.stringify(this.runnerSettings), { encoding: 'utf8' });
            const installFilePath = path.join(environmentLocalTempFolder, "install_nni.sh");
            await fs.promises.writeFile(installFilePath, CONTAINER_INSTALL_NNI_SHELL_FORMAT, { encoding: 'utf8' });
            environment.command = `import os\nos.system('sh install_nni.sh && python3 -m nni_trial_tool.trial_runner')`;
            environment.environmentLocalTempFolder = environmentLocalTempFolder;
            let environmentLocalTempTrialFolder = path.join(environmentLocalTempFolder, 'code');
            await execMkdir(environmentLocalTempTrialFolder);
            await execCopydir(this.trialConfig.codeDir, environmentLocalTempTrialFolder);
        }

        this.environments.set(environment.id, environment);
        await environmentService.startEnvironment(environment);

        if (environment.status === "FAILED") {
            environment.isIdle = false;
            environment.isAlive = false;
            throw new Error(`error on request environment ${environment.jobId}, please check log for more details.`);
        } else {
            environment.isIdle = true;
            environment.isAlive = true;
        }
        this.log.info(`requested environment ${environment.id} and job id is ${environment.jobId}.`);
    }

    private async assignEnvironment(trial: TrialDetail, environment: EnvironmentInformation): Promise<void> {
        if (trial.environment) {
            throw new Error(`trial ${trial.id} has assigned environment ${trial.environment.id} already, not assign to ${environment.id}!`);
        }
        if (environment.isIdle == false) {
            throw new Error(`environment ${environment.id} is not idle, and cannot be assigned again!`);
        }
        this.log.info(`assigning environment ${environment.id} to trial ${trial.id}.`);

        environment.isIdle = false;
        trial.environment = environment;
        trial.settings = {
            trialId: trial.id,
            sequenceId: trial.form.sequenceId,
            parameter: trial.form.hyperParameters,
        }
        trial.startTime = Date.now();
        trial.status = "RUNNING";
        const trialService = component.get<TrialService>(TrialService);
        await trialService.startTrial(trial);
    }

    private releaseEnvironment(trial: TrialDetail): void {
        if (!trial.environment) {
            throw new Error(`environment is not assigned to trial ${trial.id}, and cannot be released!`);
        }
        if (trial.environment.isIdle) {
            throw new Error(`environment ${trial.environment.id} is idle already!`);
        }
        trial.environment.isIdle = true;
        trial.environment = undefined;
    }
}

export { TrialDispatcher };
