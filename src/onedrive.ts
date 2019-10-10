import * as fs from 'fs';
import _ from 'lodash';
import request = require('request');
import { Transform, TransformOptions, TransformCallback } from 'stream';
import { AccessToken, OAuthClient } from "simple-oauth2";
import { IConfig, IOneDriveSection } from './config/config';
import { create } from 'simple-oauth2';
import { OAuthClientCallback } from './oauth-helper';
import { basename, join } from 'path';
import { IProgress } from '.';

const crypto = require('crypto');
const isDate = require('date-fns/isDate');
const parseISO = require('date-fns/parseISO');

export class UploadSession {
    expirationDateTime: Date;
    nextExpectedRanges: string[] = [];
    uploadUrl: string;
    bar: number;
    sha256HexHash: string;
    resumable: boolean = false;

    constructor(private filename: string) {
        const hash = crypto.createHash('sha256');
        hash.update(filename);
        this.sha256HexHash = hash.digest('hex');

        if (fs.existsSync('/tmp/onedrive/' + this.sha256HexHash)) {
            var buffer = fs.readFileSync('/tmp/onedrive/' + this.sha256HexHash);
            this.setData(JSON.parse(buffer.toString()), false);
            this.resumable = true;
        }
    }

    setData(data: any, store: boolean = true) {
        if ('expirationDateTime' in data) {
            if (!isDate(data.expirationDateTime)) {
                this.expirationDateTime = parseISO(data.expirationDateTime);
            } else {
                this.expirationDateTime = data.expirationDateTime;
            }
        }
        if ('nextExpectedRanges' in data) {
            this.nextExpectedRanges = data.nextExpectedRanges as string[]; 
        }
        if ('uploadUrl' in data) {
            this.uploadUrl = data.uploadUrl;
        }

        if (store) {
            if (!fs.existsSync('/tmp/onedrive')) {
                fs.mkdirSync('/tmp/onedrive', {
                    recursive: true
                });
            }

            fs.writeFileSync('/tmp/onedrive/' + this.sha256HexHash, JSON.stringify(this, null, 2));
        }
    }

    startPosition(): number {
        if (this.nextExpectedRanges.length > 0) {
            const pos = parseInt(this.nextExpectedRanges[0].split("-")[0]);
            if (pos > 0) {
                console.log(this.nextExpectedRanges);
            }
            return pos;
        }

        return 0;
    }

    finish() {
        if (fs.existsSync('/tmp/onedrive/' + this.sha256HexHash)) {
            try {
                fs.unlinkSync('/tmp/onedrive/' + this.sha256HexHash)
                //file removed
            } catch (err) {
                console.error(err)
            }
        }
    }

    start(totalValue: number, progress: IProgress) {
        if (this.filename.length > 25) this.filename = this.filename.substr(0, 25);
        else while (this.filename.length < 25) this.filename += ' ';

        this.bar = progress.start(this.filename, this.startPosition(), totalValue);
    }

    update(newValue: number, progress: IProgress) {
        progress.update(this.bar, newValue);
    }
}

export class FixedChunkSizeTransform extends Transform {
    private _buffer: Buffer;
    private _length: number;

    constructor(private chunkSize: number, options?: TransformOptions | undefined) {
        super(options);
        this._buffer = Buffer.alloc(chunkSize);
        this._length = 0;
    }

    private handleChunk(chunk: Buffer, callback: TransformCallback) {
        if (chunk.length == 0) {
            callback();
            return;
        }

        // bytes that fit in buffer
        let bytesThatFitInBuffer = this.chunkSize - this._length;
        // sub buffer from incoming chunk that fits
        let bufferThatFits = chunk.slice(0, bytesThatFitInBuffer);

        // store remaining bytes in internal buffer
        bufferThatFits.copy(this._buffer, this._length);
        this._length += bufferThatFits.length;
        // if buffer is full. Emit it and reset internal buffer to empty
        if (this._length == this.chunkSize) {
            let bufCopy = Buffer.allocUnsafe(this._buffer.length)
            this._buffer.copy(bufCopy)
            this.push(bufCopy);
            this._length = 0;

            this.handleChunk(chunk.slice(bufferThatFits.length), callback);
        } else {
            callback();
        }
    }

    _transform(chunk: Buffer, _: string, callback: TransformCallback) {
        this.handleChunk(chunk, callback);
    }

    _flush(callback: TransformCallback) {
        let bufCopy = Buffer.allocUnsafe(this._length)
        this._buffer.copy(bufCopy, 0, 0, this._length)
        this.push(bufCopy);
        callback();
    }
}

export class OneDriveApi {
    private oauth2Client: OAuthClient;
    private tokenFilePath: string;
    private accessToken: AccessToken;
    private oneDriveConfig: IOneDriveSection;
    private offsetSize: number;

    private itemByPathUrl: string = "https://graph.microsoft.com/v1.0/me/drive/root";
    private destinationPath: string;

    constructor(private config: IConfig) {
        this.oneDriveConfig = this.config.onedrive();
        this.tokenFilePath = this.oneDriveConfig.authentication.tokenFilePath;
        this.destinationPath = this.oneDriveConfig.destinationPath;
        this.offsetSize = this.closestFragmentSize(this.oneDriveConfig.fragmentSizeMB * 1024 * 1024, 320 * 1024);
        const credentials = {
            client: {
                id: this.oneDriveConfig.authentication.clientId,
                secret: this.oneDriveConfig.authentication.clientSecret
            },
            auth: {
                tokenHost: 'https://login.microsoftonline.com',
                authorizePath: 'common/oauth2/v2.0/authorize',
                tokenPath: 'common/oauth2/v2.0/token'
            }
        };
        this.oauth2Client = create(credentials);

        console.log(`Using fragment size of ${this.offsetSize} bytes`);
    }

    public async loadAccessToken() {
        if (this.accessToken === undefined && fs.existsSync(this.tokenFilePath)) {
            var buffer = fs.readFileSync(this.tokenFilePath);
            var tokenObject = JSON.parse(buffer.toString());
            this.accessToken = this.oauth2Client.accessToken.create(tokenObject.token);
        } else {
            const clientCallback = new OAuthClientCallback(this.config, this.oauth2Client);
            this.accessToken = await clientCallback.getAccessToken();
        }
    }

    private async verifyAccessToken() {
        const EXPIRATION_WINDOW_IN_SECONDS = 300;
        const { token } = this.accessToken;
        const expirationTimeInSeconds = token.expires_at.getTime() / 1000;
        const expirationWindowStart = expirationTimeInSeconds - EXPIRATION_WINDOW_IN_SECONDS;
        const nowInSeconds = (new Date()).getTime() / 1000;
        const shouldRefresh = nowInSeconds >= expirationWindowStart;
        if (shouldRefresh) {
            try {
                this.accessToken = await this.accessToken.refresh();
                fs.writeFile(this.tokenFilePath, JSON.stringify(this.accessToken, null, 2), (e) => {
                    if (e) { console.log(e); throw e; }
                    console.log('Token refreshed: ' + this.accessToken)
                })
            } catch (error) {
                throw error;
            }
        }
    }

    public async getMeta(path: string): Promise<any> {
        return new Promise((resolve, reject) => {
            const options = {
                url: this.itemByPathUrl + ':' + encodeURI(path),
                headers: {
                    'Authorization': this.accessToken.token.access_token
                }
            };

            this.get(options)
                .then(data => resolve(JSON.parse(data)))
                .catch(reason => reject(reason))
        });
    }

    private isSuccess(response: request.Response): boolean {
        return response.statusCode >= 200 && response.statusCode < 300;
    }

    public async get(options: (request.UriOptions & request.CoreOptions) | (request.UrlOptions & request.CoreOptions)): Promise<any> {
        return new Promise((resolve, reject) => {
            this.verifyAccessToken()
                .then(() => {
                    request.get(options, (error, response, data) => {
                        if (error) reject(error);
                        else if (!this.isSuccess(response)) reject({
                            statusCode: response.statusCode,
                            headers: response.headers,
                            data: data
                        });
                        else resolve(data);
                    });
                })
                .catch(error => reject(error));
        });
    }

    public async post(options: (request.UriOptions & request.CoreOptions) | (request.UrlOptions & request.CoreOptions)): Promise<any> {
        return new Promise((resolve, reject) => {
            this.verifyAccessToken()
                .then(() => {
                    request.post(options, (error, response, data) => {
                        if (error) reject(error);
                        else if (!this.isSuccess(response)) reject({
                            statusCode: response.statusCode,
                            headers: response.headers,
                            data: data
                        });
                        else resolve(data);
                    });
                })
                .catch(error => reject(error));
        });
    }

    public async put(options: (request.UriOptions & request.CoreOptions) | (request.UrlOptions & request.CoreOptions)): Promise<any> {
        return new Promise((resolve, reject) => {
            this.verifyAccessToken()
                .then(() => {
                    request.put(options, (error, response, data) => {
                        if (error) reject(error);
                        else if (!this.isSuccess(response)) reject({
                            statusCode: response.statusCode,
                            headers: response.headers,
                            data: data
                        });
                        else resolve(data);
                    });
                })
                .catch(error => reject(error));
        });
    }

    public async createUploadSession(filePath: string, fileSystemInfo: any) {
        // TODO: Store upload session for resume
        return new Promise<UploadSession>((resolve, reject) => {
            var session = new UploadSession(filePath);
            if (!session.resumable) {
                const options = {
                    url: this.itemByPathUrl + ':' + this.destinationPath + '/' + encodeURI(filePath) + ':/createUploadSession',
                    headers: {
                        'Authorization': this.accessToken.token.access_token,
                    },
                    json: {
                        "item": {
                            "@odata.type": "microsoft.graph.driveItemUploadableProperties",
                            "@microsoft.graph.conflictBehavior": "replace",
                            "name": basename(filePath),
                            "fileSystemInfo": fileSystemInfo
                        }
                    }
                };
                this.post(options)
                    .then(data => {
                        session.setData(data);
                        resolve(session);
                    })
                    .catch(reason => reject(reason));
            } else {
                const options = {
                    url: session.uploadUrl,
                    headers: {
                        'Authorization': this.accessToken.token.access_token,
                    }
                };
                this.get(options)
                    .then(data => {
                        session.setData(JSON.parse(data));
                        resolve(session);
                    })
                    .catch(reason => reject(reason));
            }
        });
    }

    private async uploadFragment(uploadUrl: string, offset: number, offsetSize: number, chunk: Buffer, totalFileSize: number) {
        return new Promise<number>((resolve, reject) => {
            var rangeTill = Math.min(offset + offsetSize - 1, totalFileSize - 1);
            const options = {
                url: uploadUrl,
                headers: {
                    'Authorization': this.accessToken.token.access_token,
                    'Content-Range': 'bytes ' + offset + '-' + rangeTill + '/' + totalFileSize
                },
                body: chunk
            };
            this.put(options)
                .then((_) => resolve(chunk.length))
                .catch((reason) => {
                    console.log(options);
                    reject(reason);
                });
        });
    }

    private closestFragmentSize(closestTo: number, divisibleBy: number) {
        const q = Math.floor(closestTo / divisibleBy);
        const n1 = q * divisibleBy;
        const n2 = (closestTo * divisibleBy) > 0 ? (divisibleBy * (q + 1)) : (divisibleBy * (q - 1));
        return Math.abs(closestTo - n1) < Math.abs(closestTo - n2) ? n1 : n2;
    }

    private async uploadFileToSession(uploadSession: UploadSession, fullPath: string, stats: fs.Stats, progress: IProgress) {
        uploadSession.start(stats.size, progress);

        var offset = uploadSession.startPosition();
        var readStream = fs.createReadStream(fullPath, { start: offset });
        var fixedSizeTransform = new FixedChunkSizeTransform(this.offsetSize);
        readStream.pipe(fixedSizeTransform);

        var bytesWritten = offset;
        for await (const chunk of fixedSizeTransform) {
            bytesWritten += await this.uploadFragment(uploadSession.uploadUrl, offset, this.offsetSize, chunk, stats.size);
            uploadSession.update(bytesWritten, progress);
            offset += this.offsetSize;
        }
        uploadSession.finish();
        // console.log(`Uploaded '${fullPath}': ${this.convertbytes(bytesWritten)}`)

        return bytesWritten;
    }

    public async uploadSingleFile(fullPath: string, filePath: string, totalSize: number, progress: IProgress) {
        return new Promise<number>((resolve, reject) => {
            var filename = basename(filePath);
            if (filename.length > 25) filename = filename.substr(0, 25);
            else while (filename.length < 25) filename += ' ';

            const id = progress.start(filename, 0, totalSize);
    
            fs.readFile(fullPath, (err, data) => {
                if (err) reject(err);

                const options = {
                    url: this.itemByPathUrl + ':' + this.destinationPath + '/' + encodeURI(filePath) + ':/content',
                    headers: {
                        'Authorization': this.accessToken.token.access_token,
                    },
                    body: data
                };
    
                this.put(options)
                    .then(data => {
                        var result = JSON.parse(data);
                        //console.log(`Uploaded '${fullPath}': ${this.convertbytes(result.size)}`)
                        progress.update(id, result.size);
                        resolve(result.size as number);
                    })
                    .catch(reason => reject(reason));
            });

        });
    }

    private convertbytes(bytes: number): string {
        if (bytes > 1073741824) return `${Math.floor(bytes / 1073741824)}.${Math.floor(bytes % 1073741824 / 10000000)}G`;
        if (bytes > 1048576) return `${Math.floor(bytes / 1048576)}.${Math.floor(bytes % 1048576 / 10000)}M`;
        if (bytes > 1024) return `${Math.floor(bytes / 1024)}.${Math.floor(bytes % 1024 / 100)}K`;
        else return `${bytes}`;
    }
    
    public async uploadFile(basePath: string, filePath: string, progress: IProgress) {
        return new Promise<number>((resolve, reject) => {
            const maxUploadSize = 4 * 1024 * 1024;
            const fullPath = join(basePath, filePath);
            const stats = fs.statSync(fullPath);

            if (stats.size < maxUploadSize) {
                this.verifyAccessToken()
                    .then(() => this.uploadSingleFile(fullPath, filePath, stats.size, progress))
                    .then(bytesWritten => resolve(bytesWritten))
                    .catch(reason => reject(reason))
            } else {
                this.verifyAccessToken()
                    .then(() => this.createUploadSession(filePath, {
                        "@odata.type": "microsoft.graph.fileSystemInfo",
                        "createdDateTime": stats.ctime,
                        "lastAccessedDateTime": stats.atime,
                        "lastModifiedDateTime": stats.mtime
                    }))
                    .then(uploadSession => this.uploadFileToSession(uploadSession, fullPath, stats, progress))
                    .then(bytesWritten => resolve(bytesWritten))
                    .catch(reason => reject(reason))
            }
        });
    }

    public async createFolder(parentPath: string, folderName: string, progress: IProgress) {
        const fullPath = join(this.destinationPath, parentPath);
        return new Promise((resolve, reject) => {
            const id = progress.start(`<${folderName}>`, 0, 100);
            const url = fullPath == '/' ? '/' : ':' + encodeURI(fullPath) + ':';
            const options = {
                url: this.itemByPathUrl + url + '/children',
                headers: {
                    'Authorization': this.accessToken.token.access_token
                },
                json: {
                    "name": folderName,
                    "folder": {},
                    "@microsoft.graph.conflictBehavior": "replace"
                }
            };
            this.post(options)
                .then(data => {
                    //console.log(`Created folder '${fullPath}/${folderName}'`)
                    progress.update(id, 100);
                    resolve(data);
                })
                .catch((reason) => reject(reason))
        });
    }
}