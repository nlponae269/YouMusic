import { $, esc, fmtTime, toast, store } from './util.js';

let token = store('admin-token') || '';
const items = [];

async function adminFetch(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Ошибка ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

/* ---------- Вход ---------- */

async function login(value) {
  token = value;
  try {
    await adminFetch('GET', '/api/admin/check');
    store('admin-token', token);
    $('#login').hidden = true;
    $('#uploader').hidden = false;
    $('#library').hidden = false;
    $('#logout').hidden = false;
    loadLibrary();
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  }
}

$('#login').addEventListener('submit', (e) => {
  e.preventDefault();
  login(e.target.token.value.trim());
});
$('#logout').addEventListener('click', () => {
  store('admin-token', '');
  location.reload();
});
if (token) login(token);

/* ---------- Разбор ID3v2: название, артист, альбом, обложка, текст ---------- */

function synchsafe(b, o) {
  return (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
}

function decodeText(bytes, enc) {
  const label = ['latin1', 'utf-16', 'utf-16be', 'utf-8'][enc] || 'latin1';
  return new TextDecoder(label).decode(bytes).replace(/\0+$/, '').trim();
}

// Конец строки, оканчивающейся нулём (для UTF-16 — двойным нулём на чётной позиции)
function strEnd(b, start, enc) {
  if (enc === 1 || enc === 2) {
    for (let i = start; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return [i, i + 2];
  } else {
    for (let i = start; i < b.length; i++) if (b[i] === 0) return [i, i + 1];
  }
  return [b.length, b.length];
}

async function readTags(file) {
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return {};
  const version = head[3];
  const size = synchsafe(head, 6);
  const b = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
  let pos = 0;
  if (head[5] & 0x40) pos += version === 4 ? synchsafe(b, 0) : ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) + 4;
  const tags = {};
  while (pos + 10 < b.length) {
    const id = String.fromCharCode(b[pos], b[pos + 1], b[pos + 2], b[pos + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const len = version === 4 ? synchsafe(b, pos + 4) : (b[pos + 4] << 24) | (b[pos + 5] << 16) | (b[pos + 6] << 8) | b[pos + 7];
    const data = b.subarray(pos + 10, pos + 10 + len);
    pos += 10 + len;
    if (!len) continue;
    const enc = data[0];
    try {
      if (id === 'TIT2') tags.title = decodeText(data.subarray(1), enc);
      else if (id === 'TPE1') tags.artist = decodeText(data.subarray(1), enc).replace(/\0/g, ', ');
      else if (id === 'TALB') tags.album = decodeText(data.subarray(1), enc);
      else if (id === 'USLT') {
        const [, next] = strEnd(data, 4, enc);
        tags.lyrics = decodeText(data.subarray(next), enc);
      } else if (id === 'APIC' && !tags.cover) {
        const [mimeEnd, afterMime] = strEnd(data, 1, 0);
        let mime = new TextDecoder('latin1').decode(data.subarray(1, mimeEnd)).toLowerCase();
        if (!mime.includes('/')) mime = `image/${mime === 'png' ? 'png' : 'jpeg'}`;
        if (mime === 'image/jpg') mime = 'image/jpeg';
        const [, picStart] = strEnd(data, afterMime + 1, enc);
        tags.cover = new File([data.slice(picStart)], 'cover', { type: mime });
      }
    } catch { /* битый фрейм — пропускаем */ }
  }
  return tags;
}

/* ---------- Анализ: длительность и пики для волны ---------- */

async function analyze(file) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    const data = buffer.getChannelData(0);
    const count = 128;
    const block = Math.floor(data.length / count);
    const peaks = [];
    for (let i = 0; i < count; i++) {
      let sum = 0;
      for (let j = 0; j < block; j += 16) sum += data[i * block + j] ** 2;
      peaks.push(Math.sqrt(sum / (block / 16)));
    }
    const max = Math.max(...peaks, 1e-6);
    return { duration: buffer.duration, peaks: peaks.map((p) => +(p / max).toFixed(3)) };
  } finally {
    ctx.close();
  }
}

/* ---------- Цвет обложки ---------- */

function toHex(r, g, b) {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

async function dominantColor(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, 32, 32);
  const { data } = ctx.getImageData(0, 0, 32, 32);
  let r = 0, g = 0, b = 0, total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const max = Math.max(data[i], data[i + 1], data[i + 2]);
    const min = Math.min(data[i], data[i + 1], data[i + 2]);
    // насыщенные и не слишком тёмные пиксели весят больше
    const w = ((max - min) / 255) ** 2 * (max / 255) + 0.01;
    r += data[i] * w; g += data[i + 1] * w; b += data[i + 2] * w; total += w;
  }
  return toHex(r / total, g / total, b / total);
}

// Обложка-заглушка, если в файле нет картинки
function generatedCover(title, artist) {
  let h = 0;
  for (const ch of title + artist) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const h2 = (h + 60) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600">
  <defs><radialGradient id="a" cx="25%" cy="20%" r="95%"><stop offset="0" stop-color="hsl(${h} 90% 62%)"/><stop offset=".6" stop-color="hsl(${h2} 70% 30%)"/><stop offset="1" stop-color="hsl(${h2} 60% 10%)"/></radialGradient></defs>
  <rect width="600" height="600" fill="url(#a)"/>
  <circle cx="440" cy="420" r="190" fill="none" stroke="hsl(${(h + 180) % 360} 95% 70%)" stroke-width="22" opacity=".85"/>
  <circle cx="440" cy="420" r="120" fill="none" stroke="#fff" stroke-width="6" opacity=".35"/>
  <text x="44" y="108" font-family="Unbounded, Arial, sans-serif" font-weight="800" font-size="54" fill="#fff">${esc(title.slice(0, 18))}</text>
  <text x="44" y="160" font-family="Manrope, Arial, sans-serif" font-weight="700" font-size="30" fill="#fff" opacity=".75">${esc(artist.slice(0, 28))}</text>
</svg>`;
  return { file: new File([svg], 'cover.svg', { type: 'image/svg+xml' }), hue: h };
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return 255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return toHex(f(0), f(8), f(4));
}

/* ---------- Очередь загрузки ---------- */

function guessFromName(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const m = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: base };
}

function normalizeAudioType(file) {
  if (file.type) return file.type === 'audio/x-m4a' ? 'audio/mp4' : file.type;
  const ext = file.name.split('.').pop().toLowerCase();
  return { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', wav: 'audio/wav', webm: 'audio/webm' }[ext] || '';
}

async function addFiles(files) {
  for (const file of files) {
    const item = { file, audioType: normalizeAudioType(file), cover: null, color: null, status: 'Анализ…' };
    items.push(item);
    item.el = document.createElement('div');
    item.el.className = 'item';
    const guess = guessFromName(file.name);
    item.el.innerHTML = `
      <div class="item__cover" title="Выбрать обложку"><img alt=""><span>Обложка</span>
        <input type="file" accept="image/jpeg,image/png,image/webp" hidden></div>
      <div class="item__fields">
        <input class="field" name="title" placeholder="Название" value="${esc(guess.title)}">
        <input class="field" name="artist" placeholder="Исполнитель" value="${esc(guess.artist)}">
        <input class="field wide" name="album" placeholder="Альбом (необязательно)">
        <details class="wide"><summary>Текст песни (обычный или LRC с таймкодами [мм:сс.xx])</summary>
          <textarea class="field" name="lyrics" placeholder="[00:12.50] Первая строка"></textarea></details>
        <div class="item__info"><span data-status>Анализ…</span><span class="item__bar"><i></i></span><span>${esc(file.name)}</span></div>
      </div>
      <button class="row__btn item__remove" aria-label="Убрать"><svg><use href="#i-close"/></svg></button>`;
    $('#items').append(item.el);
    item.field = (n) => item.el.querySelector(`[name="${n}"]`);

    const coverInput = item.el.querySelector('input[type="file"]');
    item.el.querySelector('.item__cover').addEventListener('click', (e) => { if (e.target !== coverInput) coverInput.click(); });
    coverInput.addEventListener('change', () => coverInput.files[0] && setCover(item, coverInput.files[0]));
    item.el.querySelector('.item__remove').addEventListener('click', () => {
      if (item.uploading) return;
      items.splice(items.indexOf(item), 1);
      item.el.remove();
      syncActions();
    });
    syncActions();

    try {
      const tags = file.type === 'audio/mpeg' || /\.mp3$/i.test(file.name) ? await readTags(file) : {};
      if (tags.title) item.field('title').value = tags.title;
      if (tags.artist) item.field('artist').value = tags.artist;
      if (tags.album) item.field('album').value = tags.album;
      if (tags.lyrics) item.field('lyrics').value = tags.lyrics;
      if (tags.cover) await setCover(item, tags.cover);
    } catch { /* теги не обязательны */ }
    try {
      Object.assign(item, await analyze(file));
      setStatus(item, `${fmtTime(item.duration)} · готово к загрузке`);
    } catch {
      setStatus(item, 'Не удалось проанализировать — загрузится без волны');
    }
  }
}

async function setCover(item, file) {
  item.cover = file;
  item.el.querySelector('.item__cover img').src = URL.createObjectURL(file);
  try {
    item.color = await dominantColor(file);
  } catch {
    item.color = null;
  }
}

function setStatus(item, text, progress) {
  item.el.querySelector('[data-status]').textContent = text;
  if (progress !== undefined) item.el.querySelector('.item__bar i').style.width = `${progress * 100}%`;
}

function syncActions() {
  $('#upload-actions').hidden = !items.length;
}

function put(url, file, type, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', type);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`Хранилище ответило ${xhr.status}`)));
    xhr.onerror = () => reject(new Error('Сеть или CORS бакета не настроены'));
    xhr.send(file);
  });
}

async function uploadItem(item) {
  const title = item.field('title').value.trim();
  const artist = item.field('artist').value.trim();
  if (!title || !artist) throw new Error('Укажите название и исполнителя');
  if (!item.audioType) throw new Error('Неизвестный формат файла');

  let cover = item.cover;
  let color = item.color;
  if (!cover) {
    const gen = generatedCover(title, artist);
    cover = gen.file;
    color = hslToHex(gen.hue, 90, 62);
  }

  const slot = await adminFetch('POST', '/api/admin/uploads', { audioType: item.audioType, coverType: cover.type });
  await put(slot.cover.url, cover, cover.type, () => {});
  await put(slot.audio.url, item.file, item.audioType, (p) => setStatus(item, `Загрузка ${Math.round(p * 100)}%`, p));
  await adminFetch('POST', '/api/admin/tracks', {
    id: slot.id,
    audioKey: slot.audio.key,
    audioType: item.audioType,
    coverKey: slot.cover.key,
    title,
    artist,
    album: item.field('album').value.trim(),
    lyrics: item.field('lyrics').value,
    duration: item.duration || 0,
    peaks: item.peaks || null,
    color: color || '#7a5cff',
  });
}

$('#upload-all').addEventListener('click', async () => {
  const btn = $('#upload-all');
  btn.disabled = true;
  let ok = 0;
  const pending = items.filter((i) => !i.done);
  for (const item of pending) {
    item.uploading = true;
    item.el.classList.remove('is-error');
    try {
      await uploadItem(item);
      item.done = true;
      item.el.classList.add('is-done');
      setStatus(item, 'Загружено ✓', 1);
      ok++;
    } catch (err) {
      item.el.classList.add('is-error');
      setStatus(item, err.message, 0);
    }
    item.uploading = false;
    $('#upload-status').textContent = `${ok} из ${pending.length}`;
  }
  btn.disabled = false;
  toast(ok === pending.length ? 'Всё загружено' : 'Часть файлов не загрузилась');
  loadLibrary();
});

const drop = $('#drop');
$('#files').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('is-over');
  addFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|ogg|flac|wav|aac)$/i.test(f.name)));
});

/* ---------- Библиотека ---------- */

let libTimer;
async function loadLibrary() {
  const q = $('#lib-search').value.trim();
  const res = await fetch(`/api/tracks?limit=100&q=${encodeURIComponent(q)}`);
  const tracks = await res.json();
  $('#lib-list').innerHTML = tracks.map((t) => `
    <div class="row" data-id="${t.id}">
      <span class="row__art" style="--c:${esc(t.color)}">${t.cover ? `<img src="${t.cover}" alt="" loading="lazy">` : ''}</span>
      <span class="row__meta"><span class="row__title">${esc(t.title)}</span><span class="row__artist">${esc(t.artist)} · ${t.plays} прослушиваний</span></span>
      <span class="row__time">${fmtTime(t.duration)}</span>
      <button class="row__btn" data-del aria-label="Удалить"><svg><use href="#i-trash"/></svg></button>
    </div>`).join('') || '<p class="section__hint">Треков пока нет</p>';
}
$('#lib-search').addEventListener('input', () => {
  clearTimeout(libTimer);
  libTimer = setTimeout(loadLibrary, 250);
});
$('#lib-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-del]');
  if (!btn) return;
  const row = btn.closest('.row');
  if (!confirm(`Удалить «${row.querySelector('.row__title').textContent}» навсегда?`)) return;
  try {
    await adminFetch('DELETE', `/api/admin/tracks/${row.dataset.id}`);
    row.remove();
    toast('Трек удалён');
  } catch (err) {
    toast(err.message);
  }
});
