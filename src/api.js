import crypto from 'node:crypto';
import { Router } from 'express';
import { pool } from './db.js';
import * as storage from './storage.js';
import { config } from './config.js';

export const api = Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

const AUDIO_TYPES = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
};
const IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Анонимный идентификатор устройства: лайки и плейлисты привязаны к нему
api.use((req, _res, next) => {
  const id = req.get('x-client-id');
  req.clientId = id && /^[\w-]{8,64}$/.test(id) ? id : null;
  next();
});

function requireClient(req) {
  if (!req.clientId) throw new HttpError(400, 'Нужен заголовок X-Client-Id');
  return req.clientId;
}

function idParam(req, name = 'id') {
  const id = req.params[name];
  if (!UUID_RE.test(id)) throw new HttpError(404, 'Не найдено');
  return id;
}

function cleanText(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// Все выборки треков: $1 — client_id для флага «лайкнут»
const TRACK_SELECT = `
  select t.id, t.title, t.artist, t.album, t.duration, t.color, t.peaks, t.plays,
         t.cover_key is not null as has_cover,
         coalesce(t.lyrics, '') <> '' as has_lyrics,
         exists (select 1 from likes l where l.track_id = t.id and l.client_id = $1) as liked
  from tracks t`;

function serialize(row) {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    duration: row.duration,
    color: row.color,
    peaks: row.peaks,
    plays: row.plays,
    liked: row.liked,
    hasLyrics: row.has_lyrics,
    cover: row.has_cover ? `/api/tracks/${row.id}/cover` : null,
    stream: `/api/tracks/${row.id}/stream`,
  };
}

async function queryTracks(sql, params) {
  const { rows } = await pool.query(sql, params);
  return rows.map(serialize);
}

// Подборки пересобираются раз в час — стабильный порядок внутри часа
function hourSeed(clientId) {
  return `${clientId || 'anon'}:${Math.floor(Date.now() / 3_600_000)}`;
}

api.get('/health', wrap(async (_req, res) => {
  await pool.query('select 1');
  res.json({ ok: true });
}));

api.get('/feed', wrap(async (req, res) => {
  const cid = req.clientId;
  const seed = hourSeed(cid);
  const [wave, fresh, popular, liked, playlists] = await Promise.all([
    // «Моя волна»: сначала артисты, которых пользователь лайкал, остальное вперемешку
    queryTracks(`${TRACK_SELECT}
      order by (exists (select 1 from likes l join tracks lt on lt.id = l.track_id
                        where l.client_id = $1 and lt.artist = t.artist and lt.id <> t.id)) desc,
               md5(t.id::text || $2)
      limit 40`, [cid, seed]),
    queryTracks(`${TRACK_SELECT} order by t.created_at desc limit 30`, [cid]),
    queryTracks(`${TRACK_SELECT} order by t.plays desc, md5(t.id::text || $2) limit 30`, [cid, seed]),
    cid ? queryTracks(`${TRACK_SELECT} join likes lk on lk.track_id = t.id and lk.client_id = $1
                       order by lk.created_at desc limit 50`, [cid]) : [],
    cid ? listPlaylists(cid) : [],
  ]);
  const nextRefresh = (Math.floor(Date.now() / 3_600_000) + 1) * 3_600_000;
  res.json({ wave, fresh, popular, liked, playlists, nextRefresh });
}));

api.get('/tracks', wrap(async (req, res) => {
  const q = cleanText(req.query.q, 100);
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  if (!q) {
    return res.json(await queryTracks(`${TRACK_SELECT} order by t.created_at desc limit $2`, [req.clientId, limit]));
  }
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  res.json(await queryTracks(`${TRACK_SELECT}
    where t.title ilike $2 or t.artist ilike $2 or t.album ilike $2
          or (t.artist || ' ' || t.title) ilike $2
    order by (t.title ilike $2) desc, t.plays desc
    limit $3`, [req.clientId, like, limit]));
}));

api.get('/tracks/:id', wrap(async (req, res) => {
  const [track] = await queryTracks(`${TRACK_SELECT} where t.id = $2`, [req.clientId, idParam(req)]);
  if (!track) throw new HttpError(404, 'Трек не найден');
  res.json(track);
}));

async function trackRow(id, columns) {
  const { rows } = await pool.query(`select ${columns} from tracks where id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Трек не найден');
  return rows[0];
}

api.get('/tracks/:id/lyrics', wrap(async (req, res) => {
  const row = await trackRow(idParam(req), 'lyrics');
  res.json({ lyrics: row.lyrics || '' });
}));

// Аудио отдаёт само Object Storage (с поддержкой Range) — сервер только подписывает ссылку
api.get('/tracks/:id/stream', wrap(async (req, res) => {
  const row = await trackRow(idParam(req), 'audio_key');
  const url = await storage.presignGet(row.audio_key, { expiresIn: 6 * 3600 });
  res.set('Cache-Control', 'private, max-age=600');
  res.redirect(302, url);
}));

api.get('/tracks/:id/download', wrap(async (req, res) => {
  const row = await trackRow(idParam(req), 'audio_key, title, artist');
  const ext = row.audio_key.split('.').pop();
  const name = `${row.artist} - ${row.title}.${ext}`.replace(/[\\/:*?"<>|]/g, '_');
  res.redirect(302, await storage.presignGet(row.audio_key, { expiresIn: 600, downloadName: name }));
}));

api.get('/tracks/:id/cover', wrap(async (req, res) => {
  const row = await trackRow(idParam(req), 'cover_key');
  if (!row.cover_key) throw new HttpError(404, 'Нет обложки');
  const obj = await storage.getObject(row.cover_key);
  res.set('Content-Type', obj.ContentType || 'image/jpeg');
  if (obj.ContentLength) res.set('Content-Length', String(obj.ContentLength));
  res.set('Cache-Control', 'public, max-age=604800, immutable');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; font-src data:");
  res.set('X-Content-Type-Options', 'nosniff');
  obj.Body.on('error', (err) => res.destroy(err));
  obj.Body.pipe(res);
}));

api.post('/tracks/:id/play', wrap(async (req, res) => {
  await pool.query('update tracks set plays = plays + 1 where id = $1', [idParam(req)]);
  res.status(204).end();
}));

/* ---------- Лайки ---------- */

api.get('/likes', wrap(async (req, res) => {
  const cid = requireClient(req);
  res.json(await queryTracks(`${TRACK_SELECT} join likes lk on lk.track_id = t.id and lk.client_id = $1
                              order by lk.created_at desc`, [cid]));
}));

api.put('/likes/:id', wrap(async (req, res) => {
  const cid = requireClient(req);
  const id = idParam(req);
  await trackRow(id, 'id');
  await pool.query('insert into likes (client_id, track_id) values ($1, $2) on conflict do nothing', [cid, id]);
  res.status(204).end();
}));

api.delete('/likes/:id', wrap(async (req, res) => {
  const cid = requireClient(req);
  await pool.query('delete from likes where client_id = $1 and track_id = $2', [cid, idParam(req)]);
  res.status(204).end();
}));

/* ---------- Плейлисты ---------- */

async function listPlaylists(cid) {
  const { rows } = await pool.query(`
    select p.id, p.title,
           count(pt.track_id)::int as count,
           coalesce((array_agg(pt.track_id order by pt.added_at) filter (where t.cover_key is not null))[1:4], '{}') as covers,
           (array_agg(t.color order by pt.added_at))[1] as color
    from playlists p
    left join playlist_tracks pt on pt.playlist_id = p.id
    left join tracks t on t.id = pt.track_id
    where p.client_id = $1
    group by p.id
    order by p.created_at desc`, [cid]);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    count: r.count,
    color: r.color,
    covers: r.covers.map((tid) => `/api/tracks/${tid}/cover`),
  }));
}

async function ownPlaylist(req) {
  const cid = requireClient(req);
  const id = idParam(req);
  const { rows } = await pool.query('select id, title from playlists where id = $1 and client_id = $2', [id, cid]);
  if (!rows[0]) throw new HttpError(404, 'Плейлист не найден');
  return rows[0];
}

api.get('/playlists', wrap(async (req, res) => {
  res.json(await listPlaylists(requireClient(req)));
}));

api.post('/playlists', wrap(async (req, res) => {
  const cid = requireClient(req);
  const title = cleanText(req.body?.title, 80);
  if (!title) throw new HttpError(400, 'Введите название');
  const id = crypto.randomUUID();
  await pool.query('insert into playlists (id, client_id, title) values ($1, $2, $3)', [id, cid, title]);
  res.status(201).json({ id, title, count: 0, covers: [], color: null });
}));

api.get('/playlists/:id', wrap(async (req, res) => {
  const playlist = await ownPlaylist(req);
  const tracks = await queryTracks(`${TRACK_SELECT} join playlist_tracks pt on pt.track_id = t.id
                                    where pt.playlist_id = $2 order by pt.added_at`, [req.clientId, playlist.id]);
  res.json({ ...playlist, tracks });
}));

api.patch('/playlists/:id', wrap(async (req, res) => {
  const playlist = await ownPlaylist(req);
  const title = cleanText(req.body?.title, 80);
  if (!title) throw new HttpError(400, 'Введите название');
  await pool.query('update playlists set title = $2 where id = $1', [playlist.id, title]);
  res.status(204).end();
}));

api.delete('/playlists/:id', wrap(async (req, res) => {
  const playlist = await ownPlaylist(req);
  await pool.query('delete from playlists where id = $1', [playlist.id]);
  res.status(204).end();
}));

api.post('/playlists/:id/tracks', wrap(async (req, res) => {
  const playlist = await ownPlaylist(req);
  const trackId = req.body?.trackId;
  if (!UUID_RE.test(trackId || '')) throw new HttpError(400, 'Неверный трек');
  await trackRow(trackId, 'id');
  const { rowCount } = await pool.query(
    'insert into playlist_tracks (playlist_id, track_id) values ($1, $2) on conflict do nothing',
    [playlist.id, trackId]);
  res.status(rowCount ? 201 : 200).json({ added: rowCount > 0 });
}));

api.delete('/playlists/:id/tracks/:trackId', wrap(async (req, res) => {
  const playlist = await ownPlaylist(req);
  await pool.query('delete from playlist_tracks where playlist_id = $1 and track_id = $2',
    [playlist.id, idParam(req, 'trackId')]);
  res.status(204).end();
}));

/* ---------- Админка: загрузка музыки ---------- */

function requireAdmin(req, _res, next) {
  if (!config.adminToken) return next(new HttpError(503, 'ADMIN_TOKEN не настроен на сервере'));
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const a = crypto.createHash('sha256').update(token).digest();
  const b = crypto.createHash('sha256').update(config.adminToken).digest();
  if (!crypto.timingSafeEqual(a, b)) return next(new HttpError(401, 'Неверный токен'));
  next();
}

api.get('/admin/check', requireAdmin, (_req, res) => res.json({ ok: true }));

// Файлы грузятся напрямую из браузера в Object Storage по подписанным ссылкам
api.post('/admin/uploads', requireAdmin, wrap(async (req, res) => {
  const audioType = req.body?.audioType;
  const coverType = req.body?.coverType;
  if (!AUDIO_TYPES[audioType]) throw new HttpError(400, `Формат аудио не поддерживается: ${audioType}`);
  if (coverType && !IMAGE_TYPES[coverType]) throw new HttpError(400, `Формат обложки не поддерживается: ${coverType}`);
  const id = crypto.randomUUID();
  const audioKey = `audio/${id}.${AUDIO_TYPES[audioType]}`;
  const result = {
    id,
    audio: { key: audioKey, url: await storage.presignPut(audioKey, audioType) },
    cover: null,
  };
  if (coverType) {
    const coverKey = `covers/${id}.${IMAGE_TYPES[coverType]}`;
    result.cover = { key: coverKey, url: await storage.presignPut(coverKey, coverType) };
  }
  res.json(result);
}));

api.post('/admin/tracks', requireAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  if (!UUID_RE.test(b.id || '')) throw new HttpError(400, 'Неверный id');
  const audioType = AUDIO_TYPES[b.audioType] ? b.audioType : null;
  if (!audioType || b.audioKey !== `audio/${b.id}.${AUDIO_TYPES[audioType]}`) throw new HttpError(400, 'Неверный аудиофайл');
  if (b.coverKey && !/^covers\/[0-9a-f-]{36}\.(jpg|png|webp|svg)$/.test(b.coverKey)) throw new HttpError(400, 'Неверная обложка');
  const title = cleanText(b.title);
  const artist = cleanText(b.artist);
  if (!title || !artist) throw new HttpError(400, 'Укажите название и исполнителя');
  if (!(await storage.exists(b.audioKey))) throw new HttpError(400, 'Аудиофайл не загружен в хранилище');

  const peaks = Array.isArray(b.peaks)
    ? b.peaks.slice(0, 256).map((v) => Math.max(0, Math.min(1, Number(v) || 0)))
    : null;
  const track = {
    id: b.id,
    title,
    artist,
    album: cleanText(b.album) || null,
    duration: Math.max(0, Number(b.duration) || 0),
    audio_key: b.audioKey,
    audio_type: audioType,
    cover_key: b.coverKey || null,
    color: COLOR_RE.test(b.color || '') ? b.color.toLowerCase() : '#7a5cff',
    peaks: peaks ? JSON.stringify(peaks) : null,
    lyrics: typeof b.lyrics === 'string' ? b.lyrics.slice(0, 20000) : null,
  };
  await insertTrack(track);
  res.status(201).json({ id: track.id });
}));

export async function insertTrack(t) {
  await pool.query(`
    insert into tracks (id, title, artist, album, duration, audio_key, audio_type, cover_key, color, peaks, lyrics)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
  [t.id, t.title, t.artist, t.album, t.duration, t.audio_key, t.audio_type, t.cover_key, t.color, t.peaks, t.lyrics]);
}

api.delete('/admin/tracks/:id', requireAdmin, wrap(async (req, res) => {
  const row = await trackRow(idParam(req), 'id, audio_key, cover_key');
  await pool.query('delete from tracks where id = $1', [row.id]);
  await Promise.allSettled([row.audio_key, row.cover_key].filter(Boolean).map((k) => storage.deleteObject(k)));
  res.status(204).end();
}));

api.use((_req, _res, next) => next(new HttpError(404, 'Не найдено')));

// eslint-disable-next-line no-unused-vars
api.use((err, _req, res, _next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Внутренняя ошибка сервера' : err.message });
});
