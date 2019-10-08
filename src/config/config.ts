import * as fs from 'fs';
const pkinfo = require('../../package.json');

export interface IHttpSection {
    port: number,
    host: string
}

export interface IOneDriveSection {
    authentication: IAuthenticationSection;
    fragmentSizeMB: number;
    destinationPath: string;
}

export interface IAuthenticationSection {
    clientId: string,
    clientSecret: string,
    tokenFilePath: string
}

export interface IConfigFile {
    http: IHttpSection,
    onedrive: IOneDriveSection
}

export interface IConfig {
    http(): IHttpSection,
    onedrive(): IOneDriveSection,
    version(): string
}

// config.ts
export class Config implements IConfig {
    private _config: IConfigFile;
    private _env: string;
    private _version: string;

    constructor(configFile: string = "config.json") {
        //this._env = process.env.NODE_ENV || "development";

        //var buffer = fs.readFileSync("config." + this._env + ".json");
        var buffer = fs.readFileSync(configFile);
        this._config = JSON.parse(buffer.toString());
        this._version = pkinfo.version;

        this.envConfig();
    }

    private envConfig(): void {
        if (process.env.APP_VERSION) this._version = process.env.APP_VERSION;
    }

    http(): IHttpSection {
        return this._config.http;
    }

    onedrive(): IOneDriveSection {
        return this._config.onedrive;
    }

    version(): string {
        return this._version;
    }
}
