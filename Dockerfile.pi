FROM balenalib/raspberry-pi-alpine-node

RUN [ "cross-build-start" ]

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm@5+)
COPY package*.json ./

RUN npm install

# Bundle app source
COPY . .

RUN npm run build:prod

# Create config dir
RUN mkdir -p /config && mkdir -p /workdir
VOLUME /config /workdir

EXPOSE 8001

ENTRYPOINT [ "node", "./lib/index.js", "-f", "/config/config.json", "-w", "/workdir" ]
CMD [ "-d", "/" ]

RUN [ "cross-build-end" ]