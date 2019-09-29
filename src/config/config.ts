import * as fs from 'fs';
const pkinfo = require('../../package.json');

export interface IHttpSection {
    port: number,
    host: string
}

export interface IAuthenticationSection {
    clientId: string,
    clientSecret: string
}

export interface IConfigFile {
    http: IHttpSection,
    authentication: IAuthenticationSection
}

export interface IConfig {
    http(): IHttpSection,
    authentication(): IAuthenticationSection,
    version(): string
}

// config.ts
export class Config implements IConfig {
    private _config: IConfigFile;
    private _env: string;
    private _version: string;

    constructor() {
        this._env = process.env.NODE_ENV || "development";

        var buffer = fs.readFileSync("config." + this._env + ".json");
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

    authentication(): IAuthenticationSection {
        return this._config.authentication;
    }

    version(): string {
        return this._version;
    }
}
