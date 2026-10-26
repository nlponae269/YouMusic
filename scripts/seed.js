// Наполняет каталог демо-треками: музыка синтезируется прямо здесь, обложки — SVG.
// Запуск: npm run seed  (нужны те же переменные окружения, что и серверу)
import crypto from 'node:crypto';
import { migrate, pool } from '../src/db.js';
import { putObject } from '../src/storage.js';
import { insertTrack } from '../src/api.js';

const RATE = 22050;
const SECONDS = 48;

const DEMO = [
  { title: 'Неоновый дрейф', artist: 'Lumen Koi', album: 'Ночной режим', hue: 280, bpm: 104, root: 45, prog: [0, 8, 3, 10], minor: true },
  { title: 'Полночный трамвай', artist: 'Северный свет', album: 'Маршрут 7', hue: 205, bpm: 92, root: 43, prog: [0, 5, 7, 3], minor: true },
  { title: 'Cassette Heart', artist: 'Vera Volt', album: 'Side B', hue: 335, bpm: 118, root: 48, prog: [0, 7, 9, 5], minor: false },
  { title: 'Тёплый асфальт', artist: 'Мятный район', album: 'Лето во дворах', hue: 150, bpm: 98, root: 41, prog: [0, 5, 9, 7], minor: false },
  { title: 'Orbit Lullaby', artist: 'Kosmo Kid', album: 'Low Gravity', hue: 245, bpm: 84, root: 40, prog: [0, 3, 8, 7], minor: true },
  { title: 'Огни на воде', artist: 'Пятый этаж', album: 'Набережная', hue: 25, bpm: 110, root: 46, prog: [0, 8, 5, 7], minor: true },
];

const LINES = [
  'Город гасит окна по одному', 'Мы ловим ритм на пустом шоссе', 'Ты — мой сигнал сквозь белый шум',
  'Не отпускай, пока играет бас', 'Ещё один круг до рассвета', 'Где-то внутри звучит эхо',
  'Сохрани этот вечер на повторе', 'Пусть волна унесёт нас дальше',
];

const freq = (midi) => 440 * 2 ** ((midi - 69) / 12);

function chord(root, minor) {
  return [0, minor ? 3 : 4, 7, 12].map((i) => root + i);
}

function synth(spec) {
  const n = RATE * SECONDS;
  const out = new Float32Array(n);
  const beat = 60 / spec.bpm;
  const bar = beat * 4;
  let lp = 0;
  let noiseLp = 0;
  let seed = spec.hue * 7919;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;

  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const barIdx = Math.floor(t / bar);
    const step = spec.prog[barIdx % spec.prog.length];
    const minor = spec.minor ? ![3, 8, 10].includes(step) : [2, 4, 9].includes(step);
    const notes = chord(spec.root + 12 + step, minor);
    const tb = t % beat;
    const fadeIn = Math.min(1, t / 3);
    const fadeOut = Math.min(1, (SECONDS - t) / 4);
    const section = barIdx % 8 < 4 ? 0.6 : 1;

    // пэд: расстроенные пилы через однополюсный фильтр
    let pad = 0;
    for (const m of notes) {
      const f = freq(m);
      pad += ((t * f) % 1) * 2 - 1;
      pad += ((t * f * 1.006) % 1) * 2 - 1;
    }
    lp += (pad / 8 - lp) * (0.04 + 0.03 * Math.sin(t * 0.4));

    // бас на восьмых
    const bassF = freq(spec.root + step);
    const tb8 = t % (beat / 2);
    const bass = Math.sin(2 * Math.PI * bassF * t) * Math.exp(-tb8 * 5) * 0.55;

    // бочка и хэт
    const kick = Math.sin(2 * Math.PI * (50 + 120 * Math.exp(-tb * 30)) * tb) * Math.exp(-tb * 9) * 0.9;
    const off = (t + beat / 2) % beat;
    noiseLp += (rnd() - noiseLp) * 0.6;
    const hat = (rnd() - noiseLp) * Math.exp(-off * 60) * 0.18 * section;

    // арпеджио на шестнадцатых
    const s16 = beat / 4;
    const arpIdx = Math.floor(t / s16) % 4;
    const ts = t % s16;
    const arpF = freq(notes[[0, 2, 1, 3][arpIdx]] + 12);
    const arp = Math.sin(2 * Math.PI * arpF * t + Math.sin(2 * Math.PI * arpF * 2 * t) * 0.6)
      * Math.exp(-ts * 14) * 0.22 * section;

    out[i] = (lp * 0.7 + bass + kick * (t > bar * 2 ? 1 : 0) + hat + arp) * 0.55 * fadeIn * fadeOut;
  }
  return out;
}

function wav(samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32000), 44 + i * 2));
  return buf;
}

function peaks(samples, count = 128) {
  const block = Math.floor(samples.length / count);
  const out = [];
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let j = 0; j < block; j += 8) sum += samples[i * block + j] ** 2;
    out.push(Math.sqrt(sum / (block / 8)));
  }
  const max = Math.max(...out);
  return out.map((p) => +(p / max).toFixed(3));
}

function hslHex(h, s, l) {
  s /= 100; l /= 100;
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function cover(spec) {
  const { hue } = spec;
  const acc = (hue + 150) % 360;
  const rings = Array.from({ length: 7 }, (_, i) =>
    `<circle cx="300" cy="330" r="${60 + i * 34}" fill="none" stroke="hsl(${(hue + i * 12) % 360} 90% ${70 - i * 5}%)" stroke-width="${10 - i}" opacity="${0.9 - i * 0.1}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600">
  <defs>
    <radialGradient id="bg" cx="30%" cy="15%" r="100%"><stop offset="0" stop-color="hsl(${hue} 85% 55%)"/><stop offset=".55" stop-color="hsl(${(hue + 30) % 360} 70% 22%)"/><stop offset="1" stop-color="hsl(${hue} 50% 7%)"/></radialGradient>
    <linearGradient id="sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${acc} 95% 70%)"/><stop offset="1" stop-color="hsl(${acc} 95% 50%)" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="600" height="600" fill="url(#bg)"/>
  ${rings}
  <circle cx="300" cy="330" r="46" fill="url(#sun)"/>
  <rect x="0" y="470" width="600" height="130" fill="hsl(${hue} 50% 6%)" opacity=".55"/>
  <text x="40" y="535" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="40" fill="#fff">${spec.title.toUpperCase()}</text>
  <text x="40" y="572" font-family="Arial, sans-serif" font-weight="700" font-size="24" fill="#fff" opacity=".7">${spec.artist}</text>
</svg>`;
}

function lrc(spec, index) {
  const beat = 60 / spec.bpm;
  const bar = beat * 4;
  const rows = ['[00:00.00] ♪'];
  for (let i = 0; i < 10; i++) {
    const t = bar * 2 + i * bar * 2;
    if (t > SECONDS - 4) break;
    const mm = String(Math.floor(t / 60)).padStart(2, '0');
    const ss = (t % 60).toFixed(2).padStart(5, '0');
    rows.push(`[${mm}:${ss}] ${LINES[(i + index) % LINES.length]}`);
  }
  return rows.join('\n');
}

await migrate();
const { rows } = await pool.query('select count(*)::int as n from tracks');
if (rows[0].n > 0 && !process.argv.includes('--force')) {
  console.log(`В каталоге уже ${rows[0].n} треков — пропускаю (добавьте --force, чтобы всё равно залить демо).`);
  await pool.end();
  process.exit(0);
}

for (const [index, spec] of DEMO.entries()) {
  const id = crypto.randomUUID();
  const samples = synth(spec);
  const audioKey = `audio/${id}.wav`;
  const coverKey = `covers/${id}.svg`;
  await putObject(audioKey, wav(samples), 'audio/wav');
  await putObject(coverKey, Buffer.from(cover(spec)), 'image/svg+xml');
  await insertTrack({
    id,
    title: spec.title,
    artist: spec.artist,
    album: spec.album,
    duration: SECONDS,
    audio_key: audioKey,
    audio_type: 'audio/wav',
    cover_key: coverKey,
    color: hslHex(spec.hue, 85, 55),
    peaks: JSON.stringify(peaks(samples)),
    lyrics: lrc(spec, index),
  });
  console.log(`+ ${spec.artist} — ${spec.title}`);
}
await pool.end();
console.log('Готово');
