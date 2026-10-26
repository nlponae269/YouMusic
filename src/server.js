import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { migrate, pool } from './db.js';
import { api } from './api.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '256kb' }));

app.use('/api', api);
app.use(express.static(publicDir, {
  maxAge: '1h',
  setHeaders(res, file) {
    if (file.endsWith('.html') || file.endsWith('sw.js')) res.set('Cache-Control', 'no-cache');
  },
}));
app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

await migrate();
const server = app.listen(config.port, () => {
  console.log(`YouMusic слушает порт ${config.port}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
