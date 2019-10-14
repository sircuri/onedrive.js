Onedrive.js

docker pull sircuri/onedrive && docker run -it --rm --user=root:root -v ~/onedrive-test:/config -v /var/backups/dropbox:/workdir -p 8001:8001 sircuri/onedrive

TODO:

- PATCH files with correct dates for the simple uploaded files
