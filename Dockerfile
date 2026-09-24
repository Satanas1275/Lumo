FROM node:20-alpine

WORKDIR /app

# yt-dlp (fallback de téléchargement) + python3 (exécution) + ffmpeg (fusion)
RUN apk add --no-cache python3 ffmpeg ca-certificates \
    && wget -q -O /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp \
    && yt-dlp --version

COPY server/package*.json ./server/
RUN npm --prefix server ci --omit=dev

COPY server ./server
COPY client ./client

WORKDIR /app/server
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
