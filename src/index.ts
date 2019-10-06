import * as fs from 'fs';
import * as path from 'path';
import { Config } from './config/config';
import { OneDriveApi } from './onedrive';
import { IncomingHttpHeaders } from 'http';

const type = require('easytype');

function relativePath(basePath: string, absolutePath: string) {
    if (absolutePath.startsWith(basePath)) {
        let _path = absolutePath.substring(basePath.length);
        if (_path.length == 0) _path = path.sep;
        return _path;
    } else {
        return path.relative(basePath, absolutePath);
    }
}

function convertbytes(bytes: number): string {
    if (bytes > 1073741824) return `${Math.floor(bytes / 1073741824)}.${Math.floor(bytes % 1073741824 / 10000000)}G`;
    if (bytes > 1048576) return `${Math.floor(bytes / 1048576)}.${Math.floor(bytes % 1048576 / 10000)}M`;
    if (bytes > 1024) return `${Math.floor(bytes / 1024)}.${Math.floor(bytes % 1024 / 100)}K`;
    else return `${bytes}`;
}

export interface FileObject {
    isFile: boolean;
    filename: string;
    size: number;
    path: string;
    basedir: string;
    absolutePath: string;
}

enum Mode {
    Both,
    File,
    Directory,
}

function* dirsAndFiles(baseDir: string, dir: string, options?: { pattern?: RegExp, mode?: Mode }): Generator<FileObject> {
    const filePattern: RegExp | undefined = options !== undefined ? options.pattern : undefined;
    const mode: Mode = options !== undefined ? (options.mode !== undefined ? options.mode : Mode.Both) : Mode.Both;

    const fileFormat = /[\/\\*<>?:|]/;
    const files = fs.readdirSync(dir);
    for (const file of files) {
        if (filePattern !== undefined && !filePattern.test(file))
            continue;

        const filepath = path.join(dir, file);

        try {
            if (fileFormat.test(file) || file.endsWith('.')) {
                throw new Error(`Illegal filename '${filepath}'`);
            }

            fs.accessSync(filepath, fs.constants.R_OK);

            const stat: fs.Stats = fs.statSync(filepath);
            if ( (mode == Mode.Both && (stat.isFile() || stat.isDirectory()) ) ||
                 (mode == Mode.File && stat.isFile()) ||
                 (mode == Mode.Directory && stat.isDirectory()) ) {
                const _relpath = relativePath(baseDir, dir);
                var fileObject = {
                    isFile: stat.isFile(),
                    filename: file,
                    size: stat.size,
                    path: path.join(_relpath, file),
                    basedir: _relpath,
                    absolutePath: filepath
                };
                yield fileObject;
            }
            if (stat.isDirectory()) {
                yield* dirsAndFiles(baseDir, filepath, options);
            }
        } catch (err) {
            console.error(err.name + ': ' + err.message);
        }
    }
}

export class Mutex {
    private mutex = Promise.resolve();

    lock(): PromiseLike<() => void> {
        let begin: (unlock: () => void) => void = unlock => { };

        this.mutex = this.mutex.then(() => {
            return new Promise(begin);
        });

        return new Promise(res => {
            begin = res;
        });
    }

    async dispatch(fn: (() => Promise<any>) | (() => PromiseLike<any>)): Promise<any> {
        const unlock = await this.lock();
        try {
            return await Promise.resolve(fn());
        } finally {
            unlock();
        }
    }
}

export interface JobData {
    data: any,
    retryCount: number;
    delay: number;
}

export class Queue {
    private noop = () => undefined;

    private maxTasks: number;
    private retries: number;
    private paused: boolean;
    private saturated: boolean;
    private buffer: number;
    private worker: (job: any, callback:(err?: any, ...args: any[]) => void) => void;

    private waiting: JobData[] = [];
    private active: JobData[] = [];
    private failed: JobData[] = [];
    private finished: JobData[] = [];

    private drain: () => void = this.noop;

    constructor() {
        this.retries = 0;
        this.buffer = 0;
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

    public withWorker(worker: (job: any, callback:(err?: any, ...args: any[]) => void) => void) {
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

    private _startJob() {
        if(this.waiting.length === 0 && this.active.length === 0) this.drain();
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

        setTimeout(this.worker.bind(this), delay, job.data, (err?: any, ...args: any[]) => {
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
                    this.waiting.unshift(job);
                } else {
                    this.failed.push(job);
                }
            } else {
                this.finished.push(job);
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
            retryCount: 0,
            delay: 0
        };

        this.waiting.push(jobData);

        setTimeout(this._startJob.bind(this), 0);
    }
}

(async () => {

    const config = new Config();
    const api = new OneDriveApi(config);

    async function upload(file: FileObject) {
        if (file.isFile) {
            await api.uploadFile('/Users/arjen/Downloads', file.path);
        } else {
            await api.createFolder(file.basedir, file.filename);
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


    async function goNew() {
        return new Promise<void>((resolve) => {
            // create a queue object with worker and concurrency 2
            const queue = new Queue()
                .concurrent(10)
                .retry(3)
                .withWorker((data, done) => {
                    upload(data)
                        .then(() => done())
                        .catch((reason) => {
                            console.log(`Could not handle '${data.basedir}/${data.filename}'`);
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
                                done();
                            }
                        });
                })
                .onDrain(() => {
                    resolve();
                });

            var folders = dirsAndFiles("/Users/arjen/Downloads", "/Users/arjen/Downloads", { mode: Mode.Directory, pattern: /\.pdf$/ });
            for(var file of folders) {
                queue.enqueue(file);
            }

            var files = dirsAndFiles("/Users/arjen/Downloads", "/Users/arjen/Downloads", { mode: Mode.File, pattern: /\.pdf$/ });
            for(var file of files) {
                queue.enqueue(file);
            }
        });
    }

    await api.loadAccessToken()
        .then(() => goNew());

})().then(() => {
    console.log("done");
}).catch(e => {
    // Deal with the fact the chain failed
    console.log(e);
});
