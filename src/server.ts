import _ from 'lodash';
import * as fs from 'fs';
import express from 'express';
import cors from 'cors';
import { createServer, Server } from 'http';
import { IConfig } from './config/config';
import { OAuthClient } from 'simple-oauth2';

export class OnedriveServer {
  private app: express.Application;
  private server: Server;

  constructor(private config: IConfig, private oauthClient: OAuthClient) {
    this.createApp();
    this.createServer();
    this.setupCors();
    this.mountRoutes();
  }

  private createApp(): void {
    this.app = express();
  }

  private createServer(): void {
    this.server = createServer(this.app);
  }

  private setupCors(): void {
    this.app.use(cors());
  }

  public start(): void {
    var port = this.config.http().port;

    this.server.listen(port, () => {
      console.log('Running server on port %s', port);
    });
  }

  private mountRoutes(): void {
    const router = express.Router();

    router.get('/auth', (req, res) => {

      // Authorization oauth2 URI
      const authorizationUri = this.oauthClient.authorizationCode.authorizeURL({
        redirect_uri: 'http://' + this.config.http().host + ':' + this.config.http().port + '/callback',
        scope: ['Files.ReadWrite', 'Files.ReadWrite.all', 'Sites.ReadWrite.All', 'offline_access']
      });

      res.redirect(authorizationUri);
    });

    router.get('/callback', async (req, res) => {
      // Get auth code
      const auth_code: string = req.query.code;

      // If code is present, use it
      if (auth_code) {
        try {
          var result = await this.oauthClient.authorizationCode.getToken({
            code: auth_code,
            redirect_uri: 'http://' + this.config.http().host + ':' + this.config.http().port + '/callback',
          });

          const token = this.oauthClient.accessToken.create(result);
          fs.writeFile('token.json', JSON.stringify(token, null, 2), (e) => {
            if (e) { console.log(e); throw e; }
            console.log('Token written to file.')

            res.json({ message: 'Token written to file. Restart application.' });
          });
        } catch (error) {
          console.log(error);
          res.status(500);
          res.json({ message: error });
          throw error;
        }
      } else {
        // Otherwise complain
        console.log('Authorization error: Missing code parameter');
        res.status(500);
        res.json({ message: 'Authorization error: Missing code parameter' });
      }
    });

    this.app.use('/', router);
  }
}
