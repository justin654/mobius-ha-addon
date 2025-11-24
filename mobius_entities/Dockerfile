ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:latest
FROM ${BUILD_FROM}

ENV LANG=C.UTF-8

# Install Node.js and NPM
RUN apk add --no-cache nodejs npm bash curl

WORKDIR /usr/src/app

# Install dependencies
COPY rootfs/usr/src/app/package.json ./
RUN npm install --production

# Copy app source
COPY rootfs/usr/src/app/ ./

COPY run.sh /run.sh
RUN chmod +x /run.sh

CMD [ "/run.sh" ]
