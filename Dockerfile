FROM node:20-alpine

WORKDIR /app

COPY server/package*.json ./server/
RUN npm --prefix server ci --omit=dev

COPY server ./server
COPY client ./client

WORKDIR /app/server
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
