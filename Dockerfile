FROM node:20-alpine

# yt-dlp + ffmpeg for the YouTube fallback source, python3 for yt-dlp itself
# and for the rtorrent_scgi.py helper, openssh-client for the SSH-based
# rTorrent download client (see src/services/downloadClients/rtorrent.js),
# findutils for GNU find (library.js uses -printf, which busybox find lacks -
# needed once a library root is mounted locally rather than reached over SSH)
#
# quickjs + yt-dlp-ejs: yt-dlp needs a JS runtime and its challenge-solver
# scripts to extract many YouTube videos (age-restricted ones especially).
# The base image's Node 20 is too old for yt-dlp to use, hence quickjs.
RUN apk add --no-cache python3 py3-pip ffmpeg openssh-client findutils quickjs && \
    pip3 install --break-system-packages -U yt-dlp yt-dlp-ejs && \
    echo '--js-runtimes quickjs' > /etc/yt-dlp.conf

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts

ENV RAGEARR_DATA_DIR=/config
ENV YTDLP_PATH=yt-dlp
VOLUME ["/config"]

EXPOSE 5299
CMD ["node", "src/server.js"]
