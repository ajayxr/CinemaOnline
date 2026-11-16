FROM node:24-alpine
WORKDIR /app
COPY package.json server.cjs index.html app.js styles.css ./
COPY audio ./audio
COPY vendor ./vendor
ENV NODE_ENV=production
CMD ["node", "server.cjs"]
