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

import * as assert from 'assert';
import * as cpp from 'child-process-promise';
import { getLogger, Logger } from '../../common/log';
import { KubernetesJobType, KubernetesTrialJobDetail, FrameworkControllerJobType} from '../kubernetes/kubernetesData';
import { NNIError, NNIErrorNames } from '../../common/errors';
import { TrialJobStatus } from '../../common/trainingService';
import { KubernetesCRDClient } from '../kubernetes/kubernetesApiClient';
import { KubernetesJobInfoCollector } from '../kubernetes/kubernetesJobInfoCollector';

/**
 * Collector Kubeflow jobs info from Kubernetes cluster, and update kubeflow job status locally
 */
export class KubeflowJobInfoCollector extends KubernetesJobInfoCollector{
    constructor(jobMap: Map<string, KubernetesTrialJobDetail>) {
        super(jobMap);
    }

    protected async retrieveSingleTrialJobInfo(kubernetesCRDClient: KubernetesCRDClient | undefined, 
        kubernetesTrialJob : KubernetesTrialJobDetail) : Promise<void> {
        if (!this.statusesNeedToCheck.includes(kubernetesTrialJob.status)) {
            return Promise.resolve();
        }

        if(kubernetesCRDClient === undefined) {
            return Promise.reject('operatorClient is undefined');
        }

        let kubernetesJobInfo: any;
        try {
            kubernetesJobInfo = await kubernetesCRDClient.getKubernetesJob(kubernetesTrialJob.kubeflowJobName);            
        } catch(error) {
            this.log.error(`Get job ${kubernetesTrialJob.kubeflowJobName} info failed, error is ${error}`);
            return Promise.resolve();
        }

        if(kubernetesJobInfo.status && kubernetesJobInfo.status.conditions) {
            const latestCondition = kubernetesJobInfo.status.conditions[kubernetesJobInfo.status.conditions.length - 1];
            const tfJobType : KubernetesJobType = <KubernetesJobType>latestCondition.type;
            switch(tfJobType) {
                case 'Created':
                    kubernetesTrialJob.status = 'WAITING';
                    kubernetesTrialJob.startTime = Date.parse(<string>latestCondition.lastUpdateTime);                    
                    break; 
                case 'Running':
                kubernetesTrialJob.status = 'RUNNING';
                    if(!kubernetesTrialJob.startTime) {
                        kubernetesTrialJob.startTime = Date.parse(<string>latestCondition.lastUpdateTime);
                    }
                    break;
                case 'Failed':
                    kubernetesTrialJob.status = 'FAILED';
                    kubernetesTrialJob.endTime = Date.parse(<string>latestCondition.lastUpdateTime);                    
                    break;
                case  'Succeeded':
                    kubernetesTrialJob.status = 'SUCCEEDED';
                    kubernetesTrialJob.endTime = Date.parse(<string>latestCondition.lastUpdateTime);                    
                    break;
                default:
                    break;
            }
        }
        return Promise.resolve();
    }
}