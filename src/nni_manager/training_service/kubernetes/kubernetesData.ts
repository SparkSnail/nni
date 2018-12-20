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

import { JobApplicationForm, TrialJobDetail, TrialJobStatus  } from '../../common/trainingService';

/**
 * KubeflowTrialJobDetail
 */
// tslint:disable-next-line:max-classes-per-file
export class KubernetesTrialJobDetail implements TrialJobDetail {
    public id: string;
    public status: TrialJobStatus;
    public submitTime: number;
    public startTime?: number;
    public endTime?: number;
    public tags?: string[];
    public url?: string;
    public workingDirectory: string;
    public form: JobApplicationForm;
    public kubernetesJobName: string;
    public sequenceId: number;
    public queryJobFailedCount: number;

    constructor(id: string, status: TrialJobStatus, submitTime: number,
                workingDirectory: string, form: JobApplicationForm, 
                kubernetesJobName: string, sequenceId: number, url: string) {
        this.id = id;
        this.status = status;
        this.submitTime = submitTime;
        this.workingDirectory = workingDirectory;
        this.form = form;
        this.kubernetesJobName = kubernetesJobName;
        this.sequenceId = sequenceId;
        this.tags = [];
        this.queryJobFailedCount = 0;
        this.url = url;
    }
}

export const KUBERNETES_RUNSCRIPT_FORMAT: string =
`#!/bin/bash
export NNI_PLATFORM=kubeflow
export NNI_SYS_DIR=$PWD/nni/{0}
export NNI_OUTPUT_DIR={1}
export MULTI_PHASE=false
export NNI_TRIAL_JOB_ID={2}
export NNI_EXP_ID={3}
export NNI_CODE_DIR={4}
export NNI_TRIAL_SEQ_ID={5}
{6}
mkdir -p $NNI_SYS_DIR
mkdir -p $NNI_OUTPUT_DIR
cp -rT $NNI_CODE_DIR $NNI_SYS_DIR
cd $NNI_SYS_DIR
sh install_nni.sh # Check and install NNI pkg
python3 -m nni_trial_tool.trial_keeper --trial_command {7} --nnimanager_ip {8} --nnimanager_port {9} 1>$NNI_OUTPUT_DIR/trialkeeper_stdout 2>$NNI_OUTPUT_DIR/trialkeeper_stderr
`;
