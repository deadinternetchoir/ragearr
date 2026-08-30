FROM node:20-alpine

# yt-dlp + ffmpeg for the YouTube fallback source, python3 for yt-dlp itself
RUN apk add --no-cache python3 py3-pip ffmpeg && \
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
