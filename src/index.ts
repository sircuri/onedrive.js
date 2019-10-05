import * as fs from 'fs';
import * as path from 'path';
import { Config } from './config/config';
import { OneDriveApi } from './onedrive';

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
    if (bytes > 1073741824) return `${Math.floor(bytes/1073741824)}.${Math.floor(bytes%1073741824/10000000)}G`;
    if (bytes > 1048576) return `${Math.floor(bytes/1048576)}.${Math.floor(bytes%1048576/10000)}M`;
    if (bytes > 1024) return `${Math.floor(bytes/1024)}.${Math.floor(bytes%1024/100)}K`;
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

function *dirsAndFiles (baseDir: string, dir: string, options?: { pattern?: RegExp }): Generator<FileObject> {
    const files = fs.readdirSync(dir);
    for (const file of files) {

        if (options !== undefined && options.pattern !== undefined && !options.pattern.test(file))
            continue;

        const filepath = path.join(dir, file);

        try {
            fs.accessSync(filepath, fs.constants.R_OK);

            const stat: fs.Stats = fs.statSync(filepath);
            if (stat.isFile() || stat.isDirectory()) {
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
                yield *dirsAndFiles(baseDir, filepath, options);
            }
        } catch (err) {
            console.error('Could not read ' + filepath);
        }
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

    await api.loadAccessToken()
        .then(async () => { // , { pattern: /DeepL\.dmg$/ }
            var files = dirsAndFiles("/Users/arjen/Downloads", "/Users/arjen/Downloads");
            var file = files.next();

            while (!file.done) {
                await upload(file.value);
                file = files.next();
            }
        })
        .catch((error) => console.log(error));

})().then(() => {
    console.log("done");
}).catch(e => {
    // Deal with the fact the chain failed
    console.log(e);
});
