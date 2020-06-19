# Copyright (c) Microsoft Corporation.
# Licensed under the MIT license.

import argparse
import json
import os
import random
import re
import sys
import threading
import time
import traceback
from datetime import datetime, timedelta

import pkg_resources

from .gpu import collect_gpu_usage

idle_timeout_seconds = 10 * 60
gpu_refressh_interval_seconds = 5
regular = re.compile('v?(?P<version>[0-9](\.[0-9]){0,1}).*')
trial_runner_syslogger = None


def main_loop(args):
    '''main loop logic for trial runner'''
    idle_last_time = datetime.now()
    gpu_refresh_last_time = datetime.now() - timedelta(minutes=1)

    # init command channel
    command_channel = None
    if args.command_channel == "api":
        command_channel = FileChannel(args)
    else:
        command_channel = FileChannel(args)
    nni_log(LogType.Info, "command channel is {}, actual type is {}".format(args.command_channel, type(command_channel)))
    args.command_channel = command_channel

    trial = None

    try:
        # command loop
        while True:
            command_type, command_data = command_channel.receive()
            if command_type == CommandType.NewTrialJob:
                if trial is not None:
                    if trial.is_running():
                        raise Exception('trial %s is running already, cannot start a new one' % trial.id)
                    else:
                        trial = None
                trial = Trial(args, command_data)
                trial.run()
            elif command_type == CommandType.KillTrialJob:
                if trial is not None:
                    trial.kill(command_data)
            elif command_type is not None:
                raise Exception("unknown command %s" % command_type)

            if trial is not None and trial.is_running():
                idle_last_time = datetime.now()
            else:
                trial = None

            if (datetime.now() - idle_last_time).seconds > idle_timeout_seconds:
                nni_log(LogType.Info, "trial runner is idle more than {0} seconds, so exit.".format(
                    idle_timeout_seconds))
                break

            if args.enable_gpu_collect and (datetime.now() - gpu_refresh_last_time).seconds > gpu_refressh_interval_seconds:
                # collect gpu information
                gpu_info = collect_gpu_usage(args.node_id)
                command_channel.send(CommandType.ReportGpuInfo, gpu_info)
                gpu_refresh_last_time = datetime.now()
            time.sleep(0.5)
    except Exception:
        traceback.print_exc()
    finally:
        nni_log(LogType.Info, "main_loop exits.")
        if trial is not None:
            trial.kill()
        command_channel.close()


def trial_runner_help_info(*args):
    print('please run --help to see guidance')


def check_version(args):
    try:
        trial_runner_version = pkg_resources.get_distribution('nni').version
    except pkg_resources.ResolutionError as err:
        # package nni does not exist, try nni-tool package
        nni_log(LogType.Error, 'Package nni does not exist!')
        os._exit(1)
    if not args.nni_manager_version:
        # skip version check
        nni_log(LogType.Warning, 'Skipping version check!')
    else:
        try:
            trial_runner_version = regular.search(trial_runner_version).group('version')
            nni_log(LogType.Info, '{0}: runner_version is {1}'.format(args.runner_name, trial_runner_version))
            nni_manager_version = regular.search(args.nni_manager_version).group('version')
            nni_log(LogType.Info, '{0}: nni_manager_version is {1}'.format(args.runner_name, nni_manager_version))
            log_entry = {}
            if trial_runner_version != nni_manager_version:
                nni_log(LogType.Error, '{0}: Version does not match!'.format(args.runner_name))
                error_message = '{0}: NNIManager version is {1}, Trial runner version is {2}, NNI version does not match!'.format(
                    args.runner_name, nni_manager_version, trial_runner_version)
                log_entry['tag'] = 'VCFail'
                log_entry['msg'] = error_message
                rest_post(gen_send_version_url(args.nnimanager_ip, args.nnimanager_port, args.runner_id), json.dumps(log_entry), 10,
                          False)
                os._exit(1)
            else:
                nni_log(LogType.Info, '{0}: Version match!'.format(args.runner_name))
                log_entry['tag'] = 'VCSuccess'
                rest_post(gen_send_version_url(args.nnimanager_ip, args.nnimanager_port, args.runner_id), json.dumps(log_entry), 10,
                          False)
        except AttributeError as err:
            nni_log(LogType.Error, '{0}: {1}'.format(args.runner_name, err))


def fetch_parameter_file(args):
    class FetchThread(threading.Thread):
        def __init__(self, args):
            super(FetchThread, self).__init__()
            self.args = args

        def run(self):
            uri = gen_parameter_meta_url(self.args.nnimanager_ip, self.args.nnimanager_port)
            nni_log(LogType.Info, uri)

            while True:
                res = rest_get(uri, 10)
                nni_log(LogType.Debug, 'status code: {}'.format(res.status_code))
                if res.status_code != 200:
                    nni_log(LogType.Warning, 'rest response: {}'.format(str(res)))
                time.sleep(2)

    fetch_file_thread = FetchThread(args)
    fetch_file_thread.start()


if __name__ == '__main__':

    '''NNI Trial Runner main function'''
    PARSER = argparse.ArgumentParser()
    PARSER.set_defaults(func=trial_runner_help_info)
    PARSER.add_argument('--trial_command', type=str, help='Command to launch trial process')
    PARSER.add_argument('--nnimanager_ip', type=str, help='NNI manager rest server IP')
    PARSER.add_argument('--nnimanager_port', type=str, help='NNI manager rest server port')
    PARSER.add_argument('--nni_manager_version', type=str, help='the nni version transmitted from nniManager')
    PARSER.add_argument('--log_collection', type=str, help='set the way to collect log in trial runner')
    PARSER.add_argument('--node_count', type=int, help='number of nodes, it determines how to consume command and save code file')
    args, unknown = PARSER.parse_known_args()

    setting_file = "settings.json"
    if not os.path.exists(setting_file):
        setting_file = "../{}".format(setting_file)
    if os.path.exists(setting_file):
        with open(setting_file, 'r') as fp:
            settings = json.load(fp)
        print("setting is {}".format(settings))
    else:
        print("not found setting file")

    args.exp_id = settings["experimentId"]
    args.platform = settings["platform"]
    # runner_id is unique runner in experiment, and will be updated if it's multi-nodes
    args.runner_id = "runner_"+os.path.basename(os.path.realpath(os.path.curdir))
    args.enable_gpu_collect = settings["enableGpuCollector"]
    args.command_channel = settings["commandChannel"]

    if args.trial_command is None:
        args.trial_command = settings["command"]
    if args.nnimanager_ip is None:
        args.nnimanager_ip = settings["nniManagerIP"]
    if args.nnimanager_port is None:
        args.nnimanager_port = settings["nniManagerPort"]
    if args.nni_manager_version is None:
        args.nni_manager_version = settings["nniManagerVersion"]
    if args.log_collection is None:
        args.log_collection = settings["logCollection"]
    if args.node_count is None:
        # default has only one node.
        args.node_count = 1

    os.environ['NNI_OUTPUT_DIR'] = os.curdir + "/nnioutput"
    os.environ['NNI_PLATFORM'] = args.platform
    os.environ['NNI_SYS_DIR'] = os.curdir
    os.environ['NNI_EXP_ID'] = args.exp_id
    os.environ['MULTI_PHASE'] = "true"
    os.environ['NNI_TRIAL_JOB_ID'] = "runner"

    from .log_utils import LogType, RemoteLogger, StdOutputType, nni_log
    from .rest_utils import rest_get, rest_post
    from .url_utils import gen_parameter_meta_url, gen_send_version_url
    from .trial import Trial
    from .file_channel import FileChannel
    from .base_channel import CommandType

    is_multi_node = args.node_count > 1

    if (is_multi_node):
        # for multiple nodes, create a file to get a unique id.
        while True:
            node_id = random.randint(0, 10000)
            unique_check_file_name = "node_%s" % (node_id)
            if not os.path.exists(unique_check_file_name):
                break
        with open(unique_check_file_name, "w") as unique_check_file:
            unique_check_file.write("%s" % (int(datetime.now().timestamp() * 1000)))
        args.node_id = node_id
        args.runner_name = "%s_%s" % (args.runner_id, node_id)
    else:
        # node id is unique in the runner
        args.node_id = None
        # runner_name is unique node in experiment, and will be updated if it's multi-nodes
        args.runner_name = args.runner_id

    trial_runner_syslogger = RemoteLogger(args.nnimanager_ip, args.nnimanager_port, 'runner',
                                          StdOutputType.Stdout, args.log_collection, args.runner_id)
    sys.stdout = sys.stderr = trial_runner_syslogger
    nni_log(LogType.Info, "{}: merged args is {}".format(args.runner_name, args))

    if args.trial_command is None:
        nni_log(LogType.Error, "{}: no command is found.".format(args.runner_name))
        os._exit(1)
    check_version(args)
    try:
        main_loop(args)
    except SystemExit as se:
        nni_log(LogType.Info, '{}: NNI trial runner exit with code {}'.format(args.runner_name, se.code))
        os._exit(se.code)
    finally:
        if trial_runner_syslogger is not None:
            if trial_runner_syslogger.pipeReader is not None:
                trial_runner_syslogger.pipeReader.set_process_exit()
            trial_runner_syslogger.close()

    # the process doesn't exit even main loop exit. So exit it explictly.
    os._exit(0)
