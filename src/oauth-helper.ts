import _ from 'lodash';
import * as fs from 'fs';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { IConfig } from './config/config';
import { OAuthClient, AccessToken } from 'simple-oauth2';

export class OAuthClientCallback {
  constructor(private config: IConfig, private oauthClient: OAuthClient) {

  }

  public async getAccessToken(): Promise<AccessToken> {
    return new Promise((resolve, reject) => {
      var lastSocketKey = 0;
      var socketMap = {};
      const app = express();
      const server = createServer(app);
      app.use(cors());
      const router = express.Router();

      router.get('/auth', (req, res) => {
        const authorizationUri = this.oauthClient.authorizationCode.authorizeURL({
          redirect_uri: this.config.http().external + '/callback',
          scope: ['Files.ReadWrite', 'Files.ReadWrite.all', 'Sites.ReadWrite.All', 'offline_access']
        });
        res.redirect(authorizationUri);
      });

      router.get('/callback', async (req, res) => {
        const auth_code: string = req.query.code;
        if (auth_code) {
          try {
            var result = await this.oauthClient.authorizationCode.getToken({
              code: auth_code,
              redirect_uri: this.config.http().external + '/callback',
            });
  
            const token = this.oauthClient.accessToken.create(result);
            fs.writeFile(this.config.onedrive().authentication.tokenFilePath, JSON.stringify(token, null, 2), (e) => {
              if (e) { console.log(e); throw e; }
  
              res.json({ message: 'Token written to file.' });

              Object.keys(socketMap).forEach(function(socketKey){
                socketMap[socketKey].destroy();
              });

              listener.close((err) => reject(err));

              resolve(token);
            });
          } catch (error) {
            res.status(500);
            res.json({ message: error });

            reject(error);
          }
        } else {
          // Otherwise complain
          var message = 'Authorization error: Missing code parameter';
          res.status(500);
          res.json({ message: message });

          reject(message);
        }
      });
  
      app.use('/', router);

      const port = this.config.http().port;
      var listener = server.listen(port, () => {
        console.log('Running callback OAuthClient on port %s', port);
        console.log('Point your browser to ' + this.config.http().external + '/auth');
      });

      listener.on('connection', (socket) => {
          var socketKey = ++lastSocketKey;
          socketMap[socketKey] = socket;
          socket.on('close', () => {
              delete socketMap[socketKey];
          });
      });
    });
  }
}
