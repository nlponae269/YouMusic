import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from './config.js';

const base = {
  region: config.s3.region,
  forcePathStyle: config.s3.forcePathStyle,
  credentials: {
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
  },
  // Object Storage не понимает новые checksum-заголовки AWS SDK в presigned-ссылках
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
};

export const s3 = new S3Client({ ...base, endpoint: config.s3.endpoint });
// отдельный клиент для подписи ссылок, которые откроет браузер
const signer = new S3Client({ ...base, endpoint: config.s3.publicEndpoint });

const Bucket = config.s3.bucket;

export function presignGet(key, { expiresIn = 3600, downloadName } = {}) {
  const params = { Bucket, Key: key };
  if (downloadName) {
    params.ResponseContentDisposition = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  }
  return getSignedUrl(signer, new GetObjectCommand(params), { expiresIn });
}

export function presignPut(key, contentType, expiresIn = 900) {
  return getSignedUrl(signer, new PutObjectCommand({ Bucket, Key: key, ContentType: contentType }), { expiresIn });
}

export function getObject(key) {
  return s3.send(new GetObjectCommand({ Bucket, Key: key }));
}

export function putObject(key, body, contentType) {
  return s3.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));
}

export async function exists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
    return true;
  } catch (err) {
    if (err.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

export function deleteObject(key) {
  return s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
}
