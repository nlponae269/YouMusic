// Создаёт бакет (если нет) и настраивает CORS, чтобы админка могла загружать файлы напрямую из браузера.
// Запуск: node --env-file=.env scripts/setup-bucket.js [https://ваш-домен]
import { CreateBucketCommand, HeadBucketCommand, PutBucketCorsCommand } from '@aws-sdk/client-s3';
import { s3 } from '../src/storage.js';
import { config } from '../src/config.js';

const Bucket = config.s3.bucket;
const origins = process.argv.slice(2);

try {
  await s3.send(new HeadBucketCommand({ Bucket }));
  console.log(`Бакет ${Bucket} уже существует`);
} catch (err) {
  if (err.$metadata?.httpStatusCode !== 404) throw err;
  await s3.send(new CreateBucketCommand({ Bucket }));
  console.log(`Бакет ${Bucket} создан`);
}

await s3.send(new PutBucketCorsCommand({
  Bucket,
  CORSConfiguration: {
    CORSRules: [{
      AllowedOrigins: origins.length ? origins : ['*'],
      AllowedMethods: ['GET', 'HEAD', 'PUT'],
      AllowedHeaders: ['*'],
      ExposeHeaders: ['ETag', 'Content-Length', 'Content-Range', 'Accept-Ranges'],
      MaxAgeSeconds: 3600,
    }],
  },
}));
console.log(`CORS настроен для: ${origins.length ? origins.join(', ') : '*'}`);
