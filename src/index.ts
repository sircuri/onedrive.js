import * as fs from 'fs';
import * as path from 'path';
import _ from 'lodash';
import { Config } from './config/config';
import { OneDriveApi } from './onedrive';
import { IncomingHttpHeaders } from 'http';
import yargs = require('yargs')

const type = require('easytype');

var argv = yargs
    .usage('Usage: $0 <command> [options]')
    .command('upload', 'Upload files to OneDrive')
    .example('$0 upload -p /users/me/upload', 'upload files in the given path')
    .example('$0 upload -p /users/me/upload --pattern "/\.pdf$/"', 'upload only files with extension .pdf in the given path')

    .alias('f', 'file')
    .nargs('f', 1)
    .describe('f', 'Config file')
    .alias('w', 'workdir')
    .nargs('w', 1)
    .describe('w', 'Workdir')
    .alias('d', 'dir')
    .nargs('d', 1)
    .describe('d', 'Filepath to upload')
    .demandOption(['w', 'f', 'd'])

    .help('h')
    .alias('h', 'help')
    .epilog('copyright 2019')
    .argv;

const configfile = argv.f as string;
const workdir = argv.w as string;
const basedir = argv.d as string;

const config = new Config(configfile);
const api = new OneDriveApi(config);

export interface FileObject {
    isFile: boolean;
    size: number;
    filename: string;
    dirName: string;
    baseDir: string;
    absoluteBaseDir: string;
    absolutePath: string;
}

enum Mode {
    Both,
    File,
    Directory,
}

function assertFilePath(fullPath: string): void {
    const fileFormat = /[\/\\*<>?:|]/;
    const filename = path.basename(fullPath);
    if (fileFormat.test(filename) || filename.startsWith(' ') || filename.endsWith('.')) {
        throw new Error(`Illegal filename '${fullPath}'`);
    }

    fs.accessSync(fullPath, fs.constants.R_OK);
}

function expand(...paths: string[]): string {
    return path.join(workdir, ...paths);
}

function* files(baseDir: string, filePath: string, options?: { mode?: Mode }): Generator<FileObject> {
    const mode: Mode = options !== undefined ? (options.mode !== undefined ? options.mode : Mode.Both) : Mode.Both;
    const expanded = expand(baseDir, filePath);
    const stat: fs.Stats = fs.statSync(expanded);

    try {
        if (stat.isDirectory()) {
            var filename = path.basename(filePath);
            if ((mode == Mode.Both || mode == Mode.Directory) && filename != '') {
                var fileObject = {
                    isFile: false,
                    size: 0,
                    filename: filename,
                    dirName: path.dirname(filePath),
                    baseDir: baseDir,
                    absoluteBaseDir: workdir,
                    absolutePath: expanded
                };
                yield fileObject;
            }

            const _files = fs.readdirSync(expanded);
            for (const file of _files) {
                yield* files(baseDir, path.join(filePath, file), options);
            }
        } else if (stat.isFile() && (mode == Mode.Both || mode == Mode.File)) {
            assertFilePath(expanded);
            var fileObject = {
                isFile: true,
                size: stat.size,
                filename: path.basename(filePath),
                dirName: path.dirname(filePath),
                baseDir: baseDir,
                absoluteBaseDir: workdir,
                absolutePath: expanded
            };
            yield fileObject;
        }
    } catch (err) {
        console.error(err.name + ': ' + err.message);
    }
}

export interface JobData {
    id: number;
    retryCount: number;
    delay: number;
    name: string;
    current: number;
    total: number;
    data: any;
}

export class Queue {
    private noop = () => undefined;

    private jobIds: number;
    private maxTasks: number;
    private retries: number;
    private paused: boolean;
    private renderer: any;
    private saturated: boolean;
    private buffer: number;
    private worker: (job: any, progress: (args: {name?: string, current?: number, total?: number}) => void, callback:(err?: any, ...args: any[]) => void) => void;

    private waiting: JobData[] = [];
    private active: JobData[] = [];
    private failed: JobData[] = [];
    private finished: JobData[] = [];

    private drain: () => void = this.noop;

    constructor() {
        this.retries = 0;
        this.jobIds = 0;
        this.buffer = 0;
        this.maxTasks = 3;
        this.waiting = [];
        this.active = [];
        this.failed = [];
        this.finished = [];
    }

    public concurrent(max: number): Queue {
        this.maxTasks = max;
        this.buffer = Math.floor(max / 4);
        return this;
    }

    public retry(count: number): Queue {
        this.retries = count;
        return this;
    }

    public withRenderer(options: any): Queue {
        this.renderer = options;
        return this;
    }

    public withWorker(worker: (job: any, progress:(args: {name?: string, current?: number, total?: number}) => void, callback:(err?: any, ...args: any[]) => void) => void) {
        this.worker = worker;
        return this;
    }

    public pause() {
        this.paused = true;
    }

    public resume() {
        this.paused = false;
        this._startJob();
    }

    public onDrain(fn: () => void) {
        this.drain = fn;
        return this;
    }

    private log(job: JobData, message?: string) {
        var jobs = `${this.jobIds}`;
        var jobIndicator = `${job.id}/${jobs}`;
        while (jobIndicator.length < (2 * jobs.length) + 1) jobIndicator = ' ' + jobIndicator;

        var info = '';
        if (message) {
            info = message;
            if (info.length > 10) info = info.slice(0, 10);
        } else {
            info = Math.ceil(job.current / job.total * 100) + ' %';
        }

        while (info.length < 10) info = ' ' + info;

        console.log(`[${jobIndicator}] : ${info} - ${job.name}`);
    }

    private _startJob() {
        if(this.waiting.length === 0 && this.active.length === 0) {
            this.drain();
        };
        if(this.paused || this.active.length >= this.maxTasks || this.waiting.length === 0) return;

        const job = this.waiting.shift() !;
        this.active.push(job);

        //if(this.waiting.length === 0) onEmpty(); // no more waiting tasks
        if(this.active.length === this.maxTasks && !this.saturated){
            this.saturated = true;
            //onSaturated();
        }

        let doneCalled = false;
        let delay = job.retryCount > 0 ? Math.floor(Math.random() * 3) + job.delay : 0;

        setTimeout(this.worker.bind(this), delay, job.data, (args: {name?: string, current?: number, total?: number}) => {
            if (args.name) job.name = args.name;
            if (args.current) job.current = args.current;
            if (args.total) job.total = args.total;

            this.log(job);
    
        }, (err?: any, ...args: any[]) => {
            if(doneCalled){
                throw new Error('Callback can only be called once in the worker');
            } else {
                doneCalled = true;
            }

            this.active = this.active.filter(v => v !== job);
            const delay = typeof err === 'number' ? err : 0;
            if(typeof err !== 'undefined') {
                if (job.retryCount < this.retries) {
                    job.retryCount++;
                    job.delay = delay;
                    this.log(job, `<ERR|${job.retryCount}/${this.retries}>`);
                    this.waiting.unshift(job);
                } else {
                    this.log(job, '<FAILED>');
                    this.failed.push(job);
                }
            } else {
                this.finished.push(job);
                this.log(job, '<FINISHED>');
                // if(err) onError.call(job.data, err, ...args);
                // if(!err) onSuccess.call(job.data, ...args);
            }

            if(this.active.length <= this.maxTasks - this.buffer && this.saturated){
                this.saturated = false;
                //onUnsaturated();
            }
            this._startJob();
        });

        this._startJob();
    }

    public enqueue(job: any) {
        if(type.isFunction(job) || type.isUndefined(job)) throw new TypeError(`Unable to add ${type(job)} to queue`);

        const jobData = {
            data: job,
            id: ++this.jobIds,
            retryCount: 0,
            delay: 0,
            name: "...",
            current: 0,
            total: 1
        };

        this.waiting.push(jobData);

        setTimeout(this._startJob.bind(this), 0);
    }
}

var process = require('process')
process.on('SIGINT', () => {
  console.info("Interrupted");
  process.exit(0);
});

(async () => {

    async function upload(file: FileObject, progress: (args: {name?: string, current?: number, total?: number}) => void) {
        if (file.isFile) {
            await api.uploadFile(file, progress);
        } else {
            await api.createFolder(file, progress);
        }
    }

    var errors = new Object();
    errors[429] = "Too Many Requests";
    errors[500] = "Internal Server Error";
    errors[503] = "Service Unavailable";
    errors[507] = "Insufficient Storage";
    errors[509] = "Bandwidth Limit Exceeded";

    function handleStatus(statusCode: number, headers: IncomingHttpHeaders) {
        switch(statusCode) {
            case 507: // Insufficient Storage
                return {
                    delay: 0,
                    reason: errors[statusCode],
                    abort: true
                }
            case 429: // Too Many Requests
            case 500: // Internal Server Error
            case 503: // Service Unavailable
            case 509: // Bandwidth Limit Exceeded
                if ('Retry-After' in headers) {
                    return {
                        delay: parseInt(headers['Retry-After'] as string),
                        reason: errors[statusCode],
                        abort: false
                    };
                } else {
                    return {
                        delay: 0,
                        reason: errors[statusCode],
                        abort: false
                    };
                }
            default:
                return {
                    delay: 5,
                    reason: `Unknown error ${statusCode}. Just delay for 5 seconds.`,
                    abort: false
                };
        }
    }

    async function go() {
        return new Promise<void>((resolve) => {
            // create a queue object with worker and concurrency 2
            const queue = new Queue()
                .concurrent(10)
                .retry(3)
                .withRenderer({
                    format: ''
                })
                .withWorker((data, progress, done) => {
                    upload(data, progress)
                        .then(() => done())
                        .catch(reason => {
                            console.log(`Could not handle '${data.absolutePath}'`);
                            console.log(reason);

                            if ('statusCode' in reason) {
                                var result = handleStatus(reason.statusCode, reason.headers);
                                if (result.abort) {
                                    // somehow abort this whole queue thingy 
                                } else {
                                    done(result.delay);
                                }
                            }
                            else {
                                done(5);
                            }
                        });
                })
                .onDrain(() => {
                    resolve();
                });

            var _folders = files(path.dirname(basedir), basedir, { mode: Mode.Directory });
            for(var folder of _folders) {
                queue.enqueue(folder);
            }

            var _files = files(path.dirname(basedir), basedir, { mode: Mode.File });
            for(var file of _files) {
                queue.enqueue(file);
            }
        });
    }

    await api.loadAccessToken()
        .then(() => go());

})().then(() => {
    console.log('Finished uploading all files');
}).catch(e => {
    // Deal with the fact the chain failed
    console.log(e);
});
