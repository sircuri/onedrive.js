import * as fs from 'fs';
import { Config } from './config/config';
import { OnedriveServer } from './server';
import { create, AccessToken } from 'simple-oauth2';

(async () => {

    const config = new Config();
    const credentials = {
        client: {
            id: config.authentication().clientId,
            secret: config.authentication().clientSecret
        },
        auth: {
            tokenHost: 'https://login.microsoftonline.com',
            authorizePath: 'common/oauth2/v2.0/authorize',
            tokenPath: 'common/oauth2/v2.0/token'
        }
    };
    const oauth2Client = create(credentials);

    if (fs.existsSync("token.json")) {
        var buffer = fs.readFileSync("token.json");
        var tokenObject = JSON.parse(buffer.toString());
        var accessToken = oauth2Client.accessToken.create(tokenObject.token);

        const EXPIRATION_WINDOW_IN_SECONDS = 300;
        const { token } = accessToken;
        const expirationTimeInSeconds = token.expires_at.getTime() / 1000;
        const expirationWindowStart = expirationTimeInSeconds - EXPIRATION_WINDOW_IN_SECONDS;
        const nowInSeconds = (new Date()).getTime() / 1000;
        const shouldRefresh = nowInSeconds >= expirationWindowStart;
        if (shouldRefresh) {
            try {
                accessToken = await accessToken.refresh();
                fs.writeFile('token.json', JSON.stringify(accessToken, null, 2), (e) => {
                    if (e) { console.log(e); throw e; }
                    console.log('Token refreshed')
                })
            } catch (error) {
                console.log('Error refreshing access token: ', error.message);
                throw error;
            }
        }
    } else {
        console.log("Missing token. Point your browser to 'http://" + config.http().host + ":" + config.http().port + "/auth");
        const server = new OnedriveServer(config, oauth2Client);
        server.start();
    }

    /*
    1. Verify access token
        2. No token found
            3. Start webserver
            4. Ask user to open url localhost/auth
            5. Get token
            6. End application
        7. Token expired
            8. Refresh token
    9. Start copy files to onedrive
    */
})().catch(e => {
    // Deal with the fact the chain failed
    console.log(e);
});

