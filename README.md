# Onedrive.js

This is a very limited implementation of the OneDrive API. It only supports uploading files (single or a folder recursivly).

There was a need to be able to backup files to Onedrive during the night from my Ubuntu server and Raspberry PI.

## Prepare

1. Copy the file __config.json.example__ to __config.json__
2. __destinationPath__ should point to the folder on Onedrive where the uploaded files need to go
3. __http.external__ and __http.port__ are the call back settings used by the Onedrive authentication and authorization step

## Register application with Microsoft

1. Go to your [Microsoft Azure AD Admin](https://portal.azure.com) page
2. Go to __Azure Active Directory__ / __App registrations__ and __add__ a new registration
3. Enter a __Name__ for your new app
4. Enter a __Redirect URI__ for your app to call back to. ie: http://localhost:8000

`Note: A redirect may be http://localhost:port. Otherwise it must be a HTTPS url. Any other URI is not allowed.`

5. Click __Register__
6. Copy the value from _'Application (client) ID'_ and use that as __clientId__ in the config file
7. Go to __Certificates & Secrets__
8. Click __+ New client secret__
9. Enter a __description__ and select an __expiration__ for the new secret
10. Copy the generated value use that as __clientSecret__ in the config file

## Usage

NodeJS is required to run this application

To upload a single file __file.ext__ from __/var/backups__ folder:

`node ./lib/index.js upload -f config.json -w /var/backups -d /file.ext`

To upload all the files from __/var/backups__ folder:

`node ./lib/index.js upload -f config.json -w /var/backups -d /`

## Docker

In the __config.json__ file the __http.port__ must be set to __8001__ and the __http.external__ must be set to the URI accessible.

`docker run -i --rm --user=root:root -v /location/config.json/is:/config -v /var/backups:/workdir -p 8001:8001 sircuri/onedrive -d /file.ext`

There is also a docker image created for running on a Raspberry. Use the following tag `sircuri/onedrive:latest-pi`
