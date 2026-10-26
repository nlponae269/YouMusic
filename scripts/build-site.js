// Собирает сайт для GitHub Pages: public/ + музыка из music/ + catalog.json.
// Из каждого файла берутся теги, обложка, текст песни и волна (нужен ffmpeg).
// Запуск: node scripts/build-site.js [папка-результата]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { makeDemo } from './demo.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MUSIC = path.join(ROOT, 'music');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, '_site'));
const MEDIA = path.join(OUT, 'media');
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.wav', '.webm']);
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const LYRICS_EXT = ['.lrc', '.txt'];

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], ...opts });

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return AUDIO_EXT.has(path.extname(e.name).toLowerCase()) ? [p] : [];
  }).sort();
}

function sibling(file, exts) {
  const base = file.slice(0, -path.extname(file).length);
  for (const ext of exts) {
    for (const candidate of [base + ext, base + ext.toUpperCase()]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// Общая обложка альбома: cover.jpg / folder.jpg в той же папке
function folderCover(file) {
  const dir = path.dirname(file);
  for (const name of ['cover', 'folder', 'front']) {
    const found = sibling(path.join(dir, `${name}.x`), IMAGE_EXT);
    if (found) return found;
  }
  return null;
}

function probe(file) {
  const info = JSON.parse(run('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file]).toString());
  const tags = {};
  for (const src of [info.format?.tags, ...(info.streams || []).map((s) => s.tags)]) {
    for (const [k, v] of Object.entries(src || {})) {
      const key = k.toLowerCase();
      if (!(key in tags)) tags[key] = String(v);
    }
  }
  const lyricsKey = Object.keys(tags).find((k) => k.startsWith('lyrics') || k === 'unsyncedlyrics');
  return {
    duration: Number(info.format?.duration) || 0,
    hasPicture: (info.streams || []).some((s) => s.codec_type === 'video'),
    title: tags.title,
    artist: tags.artist || tags.album_artist,
    album: tags.album,
    lyrics: lyricsKey ? tags[lyricsKey] : '',
  };
}

// Трек в подпапке music/Название альбома/ — имя папки считаем альбомом
function folderAlbum(file) {
  const dir = path.relative(MUSIC, path.dirname(file));
  return dir && !dir.startsWith('..') ? path.basename(dir) : null;
}

function guessFromName(file) {
  const base = path.basename(file, path.extname(file)).replace(/_/g, ' ').replace(/^\d+[\s.-]+/, '').trim();
  const m = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: base };
}

function peaks(file, count = 128) {
  const raw = run('ffmpeg', ['-v', 'quiet', '-i', file, '-ac', '1', '-ar', '4000', '-f', 's16le', '-']);
  const samples = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
  const block = Math.max(1, Math.floor(samples.length / count));
  const out = [];
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let j = 0; j < block; j++) sum += (samples[i * block + j] || 0) ** 2;
    out.push(Math.sqrt(sum / block));
  }
  const max = Math.max(...out, 1);
  return { peaks: out.map((p) => +(p / max).toFixed(3)), duration: samples.length / 4000 };
}

// Обложка → квадрат 600×600 JPEG; из встроенной картинки или из файла рядом
function makeCover(input, dest, embedded) {
  const args = ['-v', 'quiet', '-y', '-i', input];
  if (embedded) args.push('-an');
  args.push('-frames:v', '1', '-vf', 'scale=600:600:force_original_aspect_ratio=increase,crop=600:600', '-q:v', '3', dest);
  run('ffmpeg', args);
  return fs.existsSync(dest);
}

// Средний «сочный» цвет обложки: насыщенные пиксели весят больше
function coverColor(image) {
  const raw = run('ffmpeg', ['-v', 'quiet', '-i', image, '-vf', 'scale=24:24', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  let r = 0, g = 0, b = 0, total = 0;
  for (let i = 0; i + 2 < raw.length; i += 3) {
    const max = Math.max(raw[i], raw[i + 1], raw[i + 2]);
    const min = Math.min(raw[i], raw[i + 1], raw[i + 2]);
    const w = ((max - min) / 255) ** 2 * (max / 255) + 0.01;
    r += raw[i] * w; g += raw[i + 1] * w; b += raw[i + 2] * w; total += w;
  }
  return `#${[r, g, b].map((v) => Math.round(v / total).toString(16).padStart(2, '0')).join('')}`;
}

function generatedCover(title, artist) {
  let h = 0;
  for (const ch of title + artist) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const h2 = (h + 60) % 360;
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600">
  <defs><radialGradient id="a" cx="25%" cy="20%" r="95%"><stop offset="0" stop-color="hsl(${h} 90% 62%)"/><stop offset=".6" stop-color="hsl(${h2} 70% 30%)"/><stop offset="1" stop-color="hsl(${h2} 60% 10%)"/></radialGradient></defs>
  <rect width="600" height="600" fill="url(#a)"/>
  <circle cx="440" cy="420" r="190" fill="none" stroke="hsl(${(h + 180) % 360} 95% 70%)" stroke-width="22" opacity=".85"/>
  <circle cx="440" cy="420" r="120" fill="none" stroke="#fff" stroke-width="6" opacity=".35"/>
  <text x="44" y="108" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="50" fill="#fff">${esc(title.slice(0, 18))}</text>
  <text x="44" y="158" font-family="Arial, sans-serif" font-weight="700" font-size="30" fill="#fff" opacity=".75">${esc(artist.slice(0, 28))}</text>
</svg>`;
  const l = 0.62, s = 0.9;
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return { svg, color: `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}` };
}

function addedAt(file) {
  try {
    const out = run('git', ['log', '--diff-filter=A', '--format=%ct', '--', path.relative(ROOT, file)], { cwd: ROOT }).toString().trim();
    const first = out.split('\n').pop();
    if (first) return Number(first) * 1000;
  } catch { /* не git-репозиторий */ }
  return fs.statSync(file).mtimeMs;
}

function buildTrack(file, meta = {}) {
  const rel = path.relative(ROOT, file);
  const id = crypto.createHash('sha1').update(meta.key || rel).digest('hex').slice(0, 12);
  const info = probe(file);
  const guess = guessFromName(file);
  const title = meta.title || info.title || guess.title;
  const artist = meta.artist || info.artist || guess.artist || 'Неизвестный исполнитель';

  // аудио: WAV пережимаем в MP3, остальное копируем как есть
  let ext = path.extname(file).toLowerCase();
  if (ext === '.wav') {
    ext = '.mp3';
    run('ffmpeg', ['-v', 'quiet', '-y', '-i', file, '-b:a', '128k', path.join(MEDIA, id + ext)]);
  } else {
    fs.copyFileSync(file, path.join(MEDIA, id + ext));
  }

  // обложка
  let cover = null;
  let color = meta.color || null;
  if (meta.coverSvg) {
    cover = `media/${id}.svg`;
    fs.writeFileSync(path.join(OUT, cover), meta.coverSvg);
  } else {
    const dest = path.join(MEDIA, `${id}.jpg`);
    const external = sibling(file, IMAGE_EXT) || folderCover(file);
    let ok = false;
    try {
      ok = external ? makeCover(external, dest, false) : info.hasPicture && makeCover(file, dest, true);
    } catch { ok = false; }
    if (ok) {
      cover = `media/${id}.jpg`;
      try { color = coverColor(dest); } catch { /* цвет по умолчанию */ }
    } else {
      const gen = generatedCover(title, artist);
      cover = `media/${id}.svg`;
      fs.writeFileSync(path.join(OUT, cover), gen.svg);
      color = gen.color;
    }
  }

  // текст: файл .lrc/.txt рядом или тег в самом файле
  const lyricsFile = sibling(file, LYRICS_EXT);
  const lyrics = meta.lyrics || (lyricsFile ? fs.readFileSync(lyricsFile, 'utf8') : info.lyrics) || '';

  const wave = peaks(file);
  return {
    id,
    title,
    artist,
    album: meta.album || info.album || folderAlbum(file),
    duration: Math.round((info.duration || wave.duration) * 10) / 10,
    color: color || '#7a5cff',
    peaks: wave.peaks,
    lyrics: lyrics.trim().slice(0, 20000),
    audio: `media/${id}${ext}`,
    cover,
    addedAt: addedAt(file),
  };
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'public'), OUT, { recursive: true });
fs.mkdirSync(MEDIA, { recursive: true });

let sources = walk(MUSIC).map((file) => ({ file, meta: {} }));
let demo = false;
if (!sources.length) {
  console.log('В папке music/ пока нет треков — собираю демо');
  sources = makeDemo(fs.mkdtempSync(path.join(os.tmpdir(), 'youmusic-demo-')));
  demo = true;
}

const tracks = [];
for (const { file, meta } of sources) {
  try {
    const t = buildTrack(file, meta);
    if (demo) t.addedAt = Date.now() - tracks.length * 60_000;
    tracks.push(t);
    console.log(`+ ${t.artist} — ${t.title}`);
  } catch (err) {
    console.warn(`! Пропускаю ${path.relative(ROOT, file)}: ${err.message}`);
  }
}
tracks.sort((a, b) => a.addedAt - b.addedAt);

fs.writeFileSync(path.join(OUT, 'catalog.json'), JSON.stringify({ generatedAt: Date.now(), demo, tracks }));
const repo = process.env.GITHUB_REPOSITORY || '';
const branch = process.env.DEFAULT_BRANCH || 'main';
fs.writeFileSync(path.join(OUT, 'config.js'),
  `window.YOUMUSIC_REPO = ${JSON.stringify(repo)};\nwindow.YOUMUSIC_BRANCH = ${JSON.stringify(branch)};\n`);
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

const size = tracks.reduce((sum, t) => sum + fs.statSync(path.join(OUT, t.audio)).size, 0);
const word = tracks.length % 10 === 1 && tracks.length % 100 !== 11 ? 'трек'
  : [2, 3, 4].includes(tracks.length % 10) && ![12, 13, 14].includes(tracks.length % 100) ? 'трека' : 'треков';
console.log(`Готово: ${tracks.length} ${word}, ${(size / 1024 / 1024).toFixed(1)} МБ → ${OUT}`);
