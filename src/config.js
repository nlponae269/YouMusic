import fs from 'node:fs';

const env = process.env;

function required(name) {
  const value = env[name];
  if (!value) throw new Error(`Не задана переменная окружения ${name}`);
  return value;
}

const s3Endpoint = env.S3_ENDPOINT || 'https://storage.yandexcloud.net';

export const config = {
  port: Number(env.PORT || 8080),
  adminToken: env.ADMIN_TOKEN || '',
  // откуда разрешены запросы к API, через запятую; * — отовсюду
  corsOrigins: (env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),
  db: {
    connectionString: required('DATABASE_URL'),
    // Managed PostgreSQL в Yandex Cloud требует SSL с корневым сертификатом Яндекса
    ssl: env.PGSSLROOTCERT && fs.existsSync(env.PGSSLROOTCERT)
      ? { ca: fs.readFileSync(env.PGSSLROOTCERT, 'utf8'), rejectUnauthorized: true }
      : env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  },
  s3: {
    endpoint: s3Endpoint,
    // адрес, по которому браузер ходит в хранилище (для локального MinIO отличается от внутреннего)
    publicEndpoint: env.S3_PUBLIC_ENDPOINT || s3Endpoint,
    region: env.S3_REGION || 'ru-central1',
    bucket: required('S3_BUCKET'),
    accessKeyId: required('S3_ACCESS_KEY_ID'),
    secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
    forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
  },
};
