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
    .alias('p', 'path')
    .nargs('p', 1)
    .describe('p', 'Path to upload')
    .demandOption(['p', 'f'])
    .alias('e', 'pattern')
    .nargs('e', 1)
    .describe('e', 'RegEx pattern on files to upload')

    .help('h')
    .alias('h', 'help')
    .epilog('copyright 2019')
    .argv;

function relativePath(basePath: string, absolutePath: string) {
    if (absolutePath.startsWith(basePath)) {
        let _path = absolutePath.substring(basePath.length);
        if (_path.length == 0) _path = path.sep;
        return _path;
    } else {
        return path.relative(basePath, absolutePath);
    }
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

interface ProgressBar {
    id: number;
    name: string;
    current: number;
    total: number;
    completed: boolean;
    _status: number;
}

export interface IProgress {
    start(name: string, current: number, total: number): number;
    update(id: number, current: number): void;
}

class ProgressComponent implements IProgress {
    bars: ProgressBar[] = [];
    timer: NodeJS.Timeout;
    options = {};

    constructor(private size: number) {
        for(var idx = 0; idx < size; idx++) {
            this.bars.push({
                id: idx,
                name: '<none>',
                current: 0,
                total: 0,
                completed: true,
                _status: 0
            });
        }

        this.timer = setTimeout(this.render.bind(this), 1000);
    }

    setOptions(options: {}) {
        this.options = options;
    }

    render() {
        const status: string[] = [' ', '|', '/', '-', '\\'];
        const runningTasks = this.size - _.filter(this.bars, 'completed').length;
        console.log(`Tasks active (${runningTasks} / ${this.size})`);

        _.forEach(this.bars, (bar) => {
            var perc = (bar.completed ? '-' : Math.ceil(bar.current / bar.total * 100)) + ' %';
            while (perc.length < 5) perc = ' ' + perc;

            const fields = {
                'task-id': bar.id,
                'flow': status[bar._status],
                'perc': perc,
                'name': bar.name
            };

            const finalFields = {...fields, ...this.options};

            console.log(`${bar.id}: ${perc} (${status[bar._status]}) || ${bar.name}`);
        });

        this.timer = setTimeout(this.render.bind(this), 1000);
    }

    complete() {
        clearTimeout(this.timer);
    }

    start(name: string, current: number, total: number): number {
        if (_.filter(this.bars, 'completed').length == 0) {
            throw new Error("No room for new progress bar");
        }

        const elem = _.find(this.bars, 'completed') as ProgressBar;
        elem.completed = false;
        elem.current = current;
        elem.total = total;
        elem.name = name;

        return elem.id;
    }

    update(id: number, current: number) {
        this.bars[id].current = current;
        this.bars[id].completed = (current == this.bars[id].total);

        if (this.bars[id].completed) {
            this.bars[id].name = '<none>';
            this.bars[id]._status = 0;
        } else {
            this.bars[id]._status++;
            if (this.bars[id]._status > 4) this.bars[id]._status = 1;
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
    private renderer: any;
    private progress: ProgressComponent;
    private worker: (job: any, progress: IProgress, callback:(err?: any, ...args: any[]) => void) => void;

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
        this.progress = new ProgressComponent(max);

        return this;
    }

    public retry(count: number): Queue {
        this.retries = count;
        return this;
    }

    public withRenderer(options: any): Queue {
        this.renderer = options;
        this.progress.setOptions(options);
        return this;
    }

    public withWorker(worker: (job: any, progress: IProgress, callback:(err?: any, ...args: any[]) => void) => void) {
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
        if(this.waiting.length === 0 && this.active.length === 0)
        {
            this.progress.complete();
            this.drain();
        }
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

        setTimeout(this.worker.bind(this), delay, job.data, this.progress, (err?: any, ...args: any[]) => {
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

var process = require('process')
process.on('SIGINT', () => {
  console.info("Interrupted")
  process.exit(0)
});

(async () => {

    const basedir = argv.p as string;
    const configfile = argv.f as string;
    var pattern: RegExp | undefined = undefined;

    if (argv.e !== undefined) {
        pattern = str2Regex(argv.e as string);
    }

    const config = new Config(configfile);
    const api = new OneDriveApi(config);

    async function upload(basedir: string, file: FileObject, progress: IProgress) {
        if (file.isFile) {
            await api.uploadFile(basedir, file.path, progress);
        } else {
            await api.createFolder(file.basedir, file.filename, progress);
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

    function str2Regex(s) {
        return new RegExp(s.match(/\/(.+)\/.*/)[1], s.match(/\/.+\/(.*)/)[1]);
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
                    upload(basedir, data, progress)
                        .then(() => done())
                        .catch((reason) => {
                            console.log(`Could not handle '${path.join(data.basedir, data.filename)}'`);
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

            var folders = dirsAndFiles(basedir, basedir, { mode: Mode.Directory, pattern: pattern });
            for(var file of folders) {
                queue.enqueue(file);
            }

            var files = dirsAndFiles(basedir, basedir, { mode: Mode.File, pattern: pattern });
            for(var file of files) {
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
