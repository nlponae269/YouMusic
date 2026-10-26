FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Корневой сертификат Яндекса для SSL-подключения к Managed PostgreSQL
RUN mkdir -p /app/certs && wget -q -O /app/certs/yandex-ca.pem https://storage.yandexcloud.net/cloud-certs/CA.pem
ENV PGSSLROOTCERT=/app/certs/yandex-ca.pem

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY scripts ./scripts

USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
