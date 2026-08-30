FROM node:20-alpine

# yt-dlp + ffmpeg for the YouTube fallback source, python3 for yt-dlp itself
# and for the rtorrent_scgi.py helper, openssh-client for the SSH-based
# rTorrent download client (see src/services/downloadClients/rtorrent.js)
RUN apk add --no-cache python3 py3-pip ffmpeg openssh-client && \
    pip3 install --break-system-packages -U yt-dlp

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src

ENV RAGEARR_DATA_DIR=/config
ENV YTDLP_PATH=yt-dlp
VOLUME ["/config"]

EXPOSE 5299
CMD ["node", "src/server.js"]
