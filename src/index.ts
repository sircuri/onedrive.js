import * as fs from 'fs';
import * as path from 'path';
import { Config } from './config/config';
import { OneDriveApi } from './onedrive';
import tress = require('tress');

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

export interface QueueItem {
    value: () => PromiseLike<void>;
    next?: QueueItem;
    previous?: QueueItem;
}

export class Queue {
    private limit: number;
    private head: QueueItem | undefined;
    private tail: QueueItem | undefined;

    private collectionMutex = new Mutex();
    private count: number = 0;

    constructor() { }

    public maxTasks(max: number): Queue {
        this.limit = max;
        return this;
    }

    public async enqueue(fn: () => PromiseLike<void>) {
        return await this.collectionMutex.dispatch(async () => {
            if (this.head === undefined)
                this.head = { value: fn };
            else {
                var link = this.head;
                this.head = {
                    value: fn,
                    next: link
                }
                link.previous = this.head;
            }
            if (this.tail === undefined) {
                this.tail = this.head;
            }
            this.count++;
        });
    }

    public async dequeue(): Promise<() => PromiseLike<void>> {
        return await this.collectionMutex.dispatch(async () => {
            var _tail: QueueItem | undefined = undefined;
            if (this.tail !== undefined) {
                _tail = this.tail;
                this.tail = this.tail.previous;
                this.count--;
            }
            else
                this.head = undefined;
            
            return _tail !== undefined ? _tail.value : undefined;
        });
    }

    public async run(runner: (queue: Queue) => void) {
        return new Promise<void>(async (resolve, reject) => {
            var i = 0;

            await runner(this);

            var tasks: ((() => PromiseLike<void>) | undefined)[] = new Array(this.limit).fill(undefined);
            console.log(this.count);
            
            // while (this.tail !== undefined) {
            //     for(var i = 0; i < this.limit; i++) {
            //         if (tasks[i] === undefined) {
            //             var task = await this.dequeue(); 
            //             tasks[i] = task;
            //             task().then(() => tasks[i] = undefined);
            //             break;
            //         }
            //     }
            //     console.log(tasks);
            // }
            resolve();
        });
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

    async function go() {
        return new Promise<void>((resolve, reject) => {
            // create a queue object with worker and concurrency 2
            var q = tress(function(job, done) {
                var a: any = job.file;
                var fileObject: FileObject = a;
                upload(fileObject)
                    .then(() => done(null))
//                    .catch((reason) => done(reason));
                    .catch((reason) => {
                        console.log(`Could not handle '${fileObject.basedir}/${fileObject.filename}'`);
                        console.log(reason);
                        done(true);
                    });
            }, 10);

            // assign a callbacks
            q.drain = function() {
                resolve();
                console.log('Finished');
            };

            q.error = function(err) {
                console.log(err);
            };

            q.success = function(data) {
                // console.log('Job ' + this + ' successfully finished. Result is ' + data);
            }

            var folders = dirsAndFiles("/Users/arjen/Downloads", "/Users/arjen/Downloads", { mode: Mode.Directory });
            for(var file of folders) {
                q.push({file: file});
            }

            var files = dirsAndFiles("/Users/arjen/Downloads", "/Users/arjen/Downloads", { mode: Mode.File });
            for(var file of files) {
                q.push({file: file});
            }
        });
    }
    await api.loadAccessToken();
    await go();

    // await api.loadAccessToken()
    //     .then(async () => { // , { pattern: /DeepL\.dmg$/ }
    //         var files = dirsAndFiles("/Users/arjen/Downloads", "/Users/arjen/Downloads");
    //         var file = files.next();

    //         while (!file.done) {
    //             await upload(file.value);
    //             file = files.next();
    //         }
    //     })
    //     .catch((error) => console.log(error));

})().then(() => {
    console.log("done");
}).catch(e => {
    // Deal with the fact the chain failed
    console.log(e);
});
