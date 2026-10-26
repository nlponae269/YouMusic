import { api, uploadUrl } from './api.js';
import { player } from './player.js';
import { $, esc, icon, fmtTime, plural, paletteFrom, fakePeaks, resample, toast } from './util.js';

const els = {
  player: $('#player'),
  view: $('#view'),
  art: $('#art'),
  title: $('#title'),
  artist: $('#artist'),
  ticker: $('#ticker'),
  tickerText: $('#ticker-text'),
  wave: $('#wave'),
  cur: $('#time-cur'),
  dur: $('#time-dur'),
  play: $('#play-btn'),
  prev: $('#prev-btn'),
  next: $('#next-btn'),
  shuffle: $('#shuffle-btn'),
  repeat: $('#repeat-btn'),
  like: $('#like-btn'),
  add: $('#add-btn'),
  download: $('#download-btn'),
  lyrics: $('#lyrics-btn'),
  volume: $('#volume'),
  mute: $('#mute-btn'),
  mini: $('#mini'),
  miniArt: $('#mini-art'),
  miniTitle: $('#mini-title'),
  miniArtist: $('#mini-artist'),
  miniPlay: $('#mini-play'),
  miniLike: $('#mini-like'),
  miniProgress: $('#mini-progress'),
  voice: $('#voice-btn'),
};

const lists = new Map(); // списки треков на текущем экране: ключ → массив
let route = { name: 'home' };
let feed = null;

/* =============== Плеер: отрисовка =============== */

function setIcon(btn, name) {
  btn.querySelector('use').setAttribute('href', `#i-${name}`);
}

function applyPalette(color) {
  const { tc, accent } = paletteFrom(color);
  document.documentElement.style.setProperty('--tc', tc);
  document.documentElement.style.setProperty('--accent', accent);
  document.querySelector('meta[name="theme-color"]').content = color || '#0b0a10';
}

function setTicker(text) {
  els.tickerText.textContent = text;
  els.ticker.classList.remove('is-running');
  const track = els.ticker.firstElementChild;
  track.querySelectorAll('[data-clone]').forEach((n) => n.remove());
  requestAnimationFrame(() => {
    if (els.tickerText.offsetWidth > els.ticker.clientWidth) {
      const clone = els.tickerText.cloneNode(true);
      clone.removeAttribute('id');
      clone.dataset.clone = '';
      track.append(clone);
      els.ticker.style.setProperty('--ticker-time', `${Math.max(8, text.length * 0.35)}s`);
      els.ticker.classList.add('is-running');
    }
  });
}

new ResizeObserver(() => {
  if (player.current) setTicker(`${player.current.artist} — ${player.current.title}`);
}).observe(els.ticker);

function renderTrack() {
  const t = player.current;
  if (!t) return;
  els.art.classList.add('is-loading');
  els.art.onload = () => els.art.classList.remove('is-loading');
  els.art.src = t.cover || 'icon.svg';
  els.miniArt.src = t.cover || 'icon.svg';
  els.title.textContent = t.title;
  els.title.title = t.title;
  els.artist.textContent = t.artist;
  els.artist.href = `#/search?q=${encodeURIComponent(t.artist)}`;
  els.miniTitle.textContent = t.title;
  els.miniArtist.textContent = t.artist;
  els.lyrics.disabled = !t.hasLyrics;
  document.title = `${t.artist} — ${t.title} · YouMusic`;
  setTicker(`${t.artist} — ${t.title}`);
  applyPalette(t.color);
  renderLike();
  buildWave();
  renderTime();
  renderRows();
  updateChrome();
}

function renderLike() {
  const liked = !!player.current?.liked;
  for (const btn of [els.like, els.miniLike]) {
    btn.classList.toggle('is-on', liked);
    setIcon(btn, liked ? 'heart-fill' : 'heart');
    btn.setAttribute('aria-pressed', String(liked));
  }
}

function renderState() {
  const playing = player.playing;
  setIcon(els.play, playing ? 'pause' : 'play');
  els.play.querySelector('span').textContent = playing ? 'Пауза' : 'Слушать';
  els.play.setAttribute('aria-label', playing ? 'Пауза' : 'Слушать');
  setIcon(els.miniPlay, playing ? 'pause' : 'play');
  els.miniPlay.setAttribute('aria-label', playing ? 'Пауза' : 'Слушать');
  els.player.classList.toggle('is-playing', playing);
  renderRows();
}

function renderMode() {
  els.shuffle.classList.toggle('is-on', player.shuffle);
  els.shuffle.setAttribute('aria-pressed', String(player.shuffle));
  els.repeat.classList.toggle('is-on', player.repeat !== 'off');
  setIcon(els.repeat, player.repeat === 'one' ? 'repeat-one' : 'repeat');
  els.repeat.setAttribute('aria-label', { off: 'Повтор выключен', all: 'Повтор очереди', one: 'Повтор трека' }[player.repeat]);
}

function renderVolume() {
  const a = player.audio;
  const v = a.muted ? 0 : a.volume;
  els.volume.value = v;
  els.volume.style.setProperty('--p', `${v * 100}%`);
  setIcon(els.mute, v === 0 ? 'volume-off' : 'volume');
}

/* волна-прогресс */
let bars = [];
let scrubbing = null;

function buildWave() {
  const t = player.current;
  if (!t) return;
  const width = els.wave.clientWidth || 320;
  const count = Math.max(24, Math.min(96, Math.floor((width + 3) / 7)));
  const peaks = resample(t.peaks?.length ? t.peaks : fakePeaks(t.id), count);
  const max = Math.max(...peaks, 0.01);
  els.wave.innerHTML = peaks
    .map((p) => `<span class="wave__bar" style="height:${Math.round(12 + (p / max) * 88)}%"></span>`)
    .join('');
  bars = [...els.wave.children];
  renderTime();
}

function renderTime() {
  const d = player.duration;
  const time = scrubbing ?? player.audio.currentTime;
  const frac = d ? Math.min(1, time / d) : 0;
  els.cur.textContent = fmtTime(time);
  els.dur.textContent = fmtTime(d);
  els.miniProgress.style.width = `${frac * 100}%`;
  els.wave.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
  els.wave.setAttribute('aria-valuetext', `${fmtTime(time)} из ${fmtTime(d)}`);

  const buf = player.audio.buffered;
  const bufEnd = buf.length && d ? buf.end(buf.length - 1) / d : 0;
  const head = Math.floor(frac * bars.length);
  bars.forEach((bar, i) => {
    bar.classList.toggle('is-on', i < head);
    bar.classList.toggle('is-head', i === head && frac > 0);
    bar.classList.toggle('is-buffered', i / bars.length < bufEnd);
  });
}

function waveFraction(e) {
  const rect = els.wave.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
}

els.wave.addEventListener('pointerdown', (e) => {
  if (!player.current) return;
  els.wave.setPointerCapture(e.pointerId);
  scrubbing = waveFraction(e) * player.duration;
  renderTime();
});
els.wave.addEventListener('pointermove', (e) => {
  if (scrubbing === null) return;
  scrubbing = waveFraction(e) * player.duration;
  renderTime();
});
els.wave.addEventListener('pointerup', (e) => {
  if (scrubbing === null) return;
  player.seek(waveFraction(e));
  scrubbing = null;
});
els.wave.addEventListener('pointercancel', () => { scrubbing = null; renderTime(); });
els.wave.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') player.audio.currentTime += 5;
  else if (e.key === 'ArrowLeft') player.audio.currentTime -= 5;
  else return;
  e.preventDefault();
});
new ResizeObserver(() => buildWave()).observe(els.wave);

/* =============== Плеер: события =============== */

player.addEventListener('track', renderTrack);
player.addEventListener('track-meta', renderLike);
player.addEventListener('state', renderState);
player.addEventListener('time', renderTime);
player.addEventListener('mode', renderMode);
player.addEventListener('volume', renderVolume);
player.addEventListener('error', () => toast('Не удалось загрузить трек'));

els.play.addEventListener('click', () => player.toggle());
els.miniPlay.addEventListener('click', () => player.toggle());
els.prev.addEventListener('click', () => player.prev());
els.next.addEventListener('click', () => player.next());
els.shuffle.addEventListener('click', () => {
  player.toggleShuffle();
  toast(player.shuffle ? 'Перемешано' : 'По порядку');
});
els.repeat.addEventListener('click', () => {
  player.cycleRepeat();
  toast({ off: 'Повтор выключен', all: 'Повтор очереди', one: 'Повтор трека' }[player.repeat]);
});
els.volume.addEventListener('input', () => player.setVolume(Number(els.volume.value)));
els.mute.addEventListener('click', () => player.toggleMute());
els.like.addEventListener('click', () => player.current && toggleLike(player.current));
els.miniLike.addEventListener('click', () => player.current && toggleLike(player.current));
els.add.addEventListener('click', () => player.current && openPlaylistPicker(player.current));
els.download.addEventListener('click', async () => {
  const t = player.current;
  if (!t) return;
  // файл лежит на другом домене — атрибут download там не работает, поэтому качаем через blob
  toast('Скачиваю…');
  try {
    const res = await fetch(t.stream);
    if (!res.ok) throw new Error();
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `${t.artist} - ${t.title}.${t.stream.split('.').pop()}`.replace(/[\\/:*?"<>|]/g, '_');
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast('Готово');
  } catch {
    toast('Не удалось скачать трек');
  }
});
els.lyrics.addEventListener('click', () => openLyrics());

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Space' && !e.target.closest('button, a')) {
    e.preventDefault();
    player.toggle();
  } else if (e.key === 'ArrowRight' && e.shiftKey) player.next();
  else if (e.key === 'ArrowLeft' && e.shiftKey) player.prev();
});

/* =============== Лайки =============== */

async function toggleLike(track) {
  const liked = !track.liked;
  const sync = (value) => {
    track.liked = value;
    player.patch(track.id, { liked: value });
    for (const arr of lists.values()) arr.forEach((t) => { if (t.id === track.id) t.liked = value; });
    document.querySelectorAll(`[data-like="${track.id}"]`).forEach((btn) => {
      btn.classList.toggle('is-on', value);
      setIcon(btn, value ? 'heart-fill' : 'heart');
    });
    renderLike();
  };
  sync(liked);
  try {
    await api.like(track.id, liked);
    toast(liked ? 'Добавлено в любимое' : 'Убрано из любимого');
    if (route.name === 'liked' && !liked) render();
  } catch (err) {
    sync(!liked);
    toast(err.message);
  }
}

/* =============== Списки треков =============== */

function trackRows(key, tracks, { removable = false } = {}) {
  lists.set(key, tracks);
  return `<div class="list" data-list="${esc(key)}">${tracks.map((t, i) => `
    <div class="row" data-i="${i}" data-id="${t.id}" role="button" tabindex="0">
      <span class="row__art" style="--c:${esc(t.color)}">
        ${t.cover ? `<img src="${t.cover}" alt="" loading="lazy">` : ''}
        <span class="row__eq"><i></i><i></i><i></i></span>
      </span>
      <span class="row__meta">
        <span class="row__title">${esc(t.title)}</span>
        <span class="row__artist">${esc(t.artist)}</span>
      </span>
      <span class="row__time">${fmtTime(t.duration)}</span>
      <span class="row__actions">
        <button class="row__btn ${t.liked ? 'is-on' : ''}" data-act="like" data-like="${t.id}" aria-label="Нравится">${icon(t.liked ? 'heart-fill' : 'heart')}</button>
        ${removable
          ? `<button class="row__btn" data-act="remove" aria-label="Убрать из плейлиста">${icon('close')}</button>`
          : `<button class="row__btn" data-act="add" aria-label="В плейлист">${icon('plus')}</button>`}
      </span>
    </div>`).join('')}</div>`;
}

function renderRows() {
  const id = player.current?.id;
  document.querySelectorAll('.row').forEach((row) => {
    const current = row.dataset.id === id;
    row.classList.toggle('is-current', current);
    row.classList.toggle('is-playing', current && player.playing);
  });
}

function playList(key, index = 0, { shuffle = false } = {}) {
  const tracks = lists.get(key);
  if (!tracks?.length) return;
  if (shuffle && !player.shuffle) player.toggleShuffle();
  player.source = key;
  player.setQueue(tracks, shuffle ? Math.floor(Math.random() * tracks.length) : index);
}

els.view.addEventListener('click', async (e) => {
  const actBtn = e.target.closest('[data-act]');
  const row = e.target.closest('.row');
  const listEl = e.target.closest('[data-list]');

  if (row && listEl) {
    const tracks = lists.get(listEl.dataset.list);
    const track = tracks[Number(row.dataset.i)];
    if (actBtn?.dataset.act === 'like') return toggleLike(track);
    if (actBtn?.dataset.act === 'add') return openPlaylistPicker(track);
    if (actBtn?.dataset.act === 'remove') return removeFromPlaylist(track);
    if (player.current?.id === track.id) return player.toggle();
    return playList(listEl.dataset.list, Number(row.dataset.i));
  }

  const mix = e.target.closest('[data-mix]');
  if (mix) {
    const key = mix.dataset.mix;
    if (player.source === key && player.current) {
      player.play();
    } else {
      playList(key, 0);
    }
    location.hash = '#/';
    return;
  }

  if (!actBtn) return;
  const act = actBtn.dataset.act;
  if (act === 'play-all') playList(actBtn.dataset.key);
  else if (act === 'shuffle-all') playList(actBtn.dataset.key, 0, { shuffle: true });
  else if (act === 'new-playlist') createPlaylistFlow();
  else if (act === 'rename-playlist') renamePlaylistFlow();
  else if (act === 'delete-playlist') deletePlaylistFlow();
});

els.view.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('row')) {
    e.preventDefault();
    e.target.click();
  }
});

/* =============== Шторки =============== */

function openSheet(html) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="sheet__grip"></div>${html}</div>`;
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  return { el: backdrop.firstElementChild, close };
}

function plCover(p) {
  if (!p.covers?.length) return `<span class="pl__cover pl__cover--empty" style="--c:${esc(p.color || '')}">${icon('library')}</span>`;
  const covers = p.covers.length >= 4 ? p.covers.slice(0, 4) : p.covers.slice(0, 1);
  return `<span class="pl__cover" style="--c:${esc(p.color || '')}">${covers.map((c) => `<img src="${c}" alt="" loading="lazy">`).join('')}</span>`;
}

async function openPlaylistPicker(track) {
  const sheet = openSheet(`
    <h2 class="sheet__title">Добавить в плейлист</h2>
    <div data-items><div class="skeleton" style="height:64px"></div></div>
    <form><input class="field" name="title" placeholder="Новый плейлист" maxlength="80" required>
    <button class="btn btn--accent" aria-label="Создать">${icon('plus')}</button></form>`);
  const items = sheet.el.querySelector('[data-items]');

  async function add(playlistId, el) {
    try {
      const { added } = await api.addToPlaylist(playlistId, track.id);
      el?.querySelector('[data-mark]')?.classList.add('is-done');
      toast(added ? 'Добавлено в плейлист' : 'Трек уже в плейлисте');
      setTimeout(sheet.close, 350);
    } catch (err) {
      toast(err.message);
    }
  }

  try {
    const playlists = await api.playlists();
    items.innerHTML = playlists.map((p) => `
      <button class="sheet__item" data-pl="${p.id}">
        ${plCover(p)}
        <span>${esc(p.title)}<small>${p.count} ${plural(p.count, 'трек', 'трека', 'треков')}</small></span>
        <span data-mark style="flex:none">${icon('plus')}</span>
      </button>`).join('') || '<p class="section__hint">Плейлистов пока нет — создайте первый</p>';
  } catch (err) {
    items.textContent = err.message;
  }
  items.addEventListener('click', (e) => {
    const item = e.target.closest('[data-pl]');
    if (item) add(item.dataset.pl, item);
  });
  sheet.el.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const p = await api.createPlaylist(e.target.title.value);
      await add(p.id);
    } catch (err) {
      toast(err.message);
    }
  });
  setTimeout(() => sheet.el.querySelector('.sheet__item, input')?.focus(), 50);
}

function promptSheet(title, value = '', submitLabel = 'Готово') {
  return new Promise((resolve) => {
    const sheet = openSheet(`
      <h2 class="sheet__title">${esc(title)}</h2>
      <form><input class="field" name="value" value="${esc(value)}" maxlength="80" required>
      <button class="btn btn--accent">${esc(submitLabel)}</button></form>`);
    const input = sheet.el.querySelector('input');
    setTimeout(() => { input.focus(); input.select(); }, 50);
    sheet.el.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      sheet.close();
      resolve(input.value.trim());
    });
    sheet.el.parentElement.addEventListener('click', (e) => {
      if (e.target === sheet.el.parentElement) resolve(null);
    });
  });
}

async function createPlaylistFlow() {
  const title = await promptSheet('Новый плейлист', '', 'Создать');
  if (!title) return;
  try {
    const p = await api.createPlaylist(title);
    location.hash = `#/playlist/${p.id}`;
  } catch (err) {
    toast(err.message);
  }
}

async function renamePlaylistFlow() {
  const title = await promptSheet('Название плейлиста', route.playlist?.title);
  if (!title) return;
  try {
    await api.renamePlaylist(route.id, title);
    render();
  } catch (err) {
    toast(err.message);
  }
}

async function deletePlaylistFlow() {
  if (!confirm(`Удалить плейлист «${route.playlist?.title}»?`)) return;
  try {
    await api.deletePlaylist(route.id);
    toast('Плейлист удалён');
    location.hash = '#/playlists';
  } catch (err) {
    toast(err.message);
  }
}

async function removeFromPlaylist(track) {
  try {
    await api.removeFromPlaylist(route.id, track.id);
    render();
  } catch (err) {
    toast(err.message);
  }
}

/* =============== Текст песни =============== */

function parseLrc(text) {
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,2}):(\d{2}(?:[.:]\d{1,3})?)\]/g)];
    if (!stamps.length) continue;
    const words = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const s of stamps) lines.push({ time: Number(s[1]) * 60 + Number(s[2].replace(':', '.')), text: words || '♪' });
  }
  return lines.sort((a, b) => a.time - b.time);
}

let lyricsView = null;

async function openLyrics() {
  const t = player.current;
  if (!t?.hasLyrics) return;
  closeLyrics();
  const el = document.createElement('div');
  el.className = 'lyrics';
  el.setAttribute('role', 'dialog');
  el.innerHTML = `
    <div class="lyrics__head">
      <img src="${t.cover || 'icon.svg'}" alt="">
      <div><b>${esc(t.title)}</b><small>${esc(t.artist)}</small></div>
      <button class="icon-btn" data-close aria-label="Закрыть">${icon('chevron-down')}</button>
    </div>
    <div class="lyrics__body"><div class="skeleton" style="height:200px"></div></div>
    <div class="lyrics__foot"><button class="btn btn--ghost" data-toggle></button></div>`;
  document.body.append(el);
  const body = el.querySelector('.lyrics__body');
  const toggleBtn = el.querySelector('[data-toggle]');
  const syncToggle = () => {
    toggleBtn.innerHTML = `${icon(player.playing ? 'pause' : 'play')}${player.playing ? 'Пауза' : 'Слушать'}`;
  };
  syncToggle();
  toggleBtn.addEventListener('click', () => player.toggle());
  el.querySelector('[data-close]').addEventListener('click', closeLyrics);

  const state = { el, lines: [], nodes: [], active: -1, syncToggle };
  lyricsView = state;
  try {
    const { lyrics } = await api.lyrics(t.id);
    if (lyricsView !== state) return;
    state.lines = parseLrc(lyrics);
    if (state.lines.length) {
      body.innerHTML = state.lines.map((l, i) => `<button class="lyrics__line" data-i="${i}">${esc(l.text)}</button>`).join('');
      state.nodes = [...body.children];
      body.addEventListener('click', (e) => {
        const line = e.target.closest('[data-i]');
        if (line) player.audio.currentTime = state.lines[line.dataset.i].time;
      });
      syncLyrics();
    } else {
      el.classList.add('lyrics--plain');
      body.innerHTML = lyrics.split(/\r?\n/).map((l) => `<p class="lyrics__line">${esc(l) || '&nbsp;'}</p>`).join('');
    }
  } catch (err) {
    body.textContent = err.message;
  }
}

function syncLyrics() {
  const s = lyricsView;
  if (!s?.lines.length) return;
  const time = player.audio.currentTime + 0.25;
  let idx = -1;
  while (idx + 1 < s.lines.length && s.lines[idx + 1].time <= time) idx++;
  if (idx === s.active) return;
  s.active = idx;
  s.nodes.forEach((n, i) => {
    n.classList.toggle('is-active', i === idx);
    n.classList.toggle('is-past', i < idx);
  });
  s.nodes[Math.max(0, idx)]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function closeLyrics() {
  lyricsView?.el.remove();
  lyricsView = null;
}

player.addEventListener('time', syncLyrics);
player.addEventListener('state', () => lyricsView?.syncToggle());
player.addEventListener('track', () => {
  if (!lyricsView) return;
  if (player.current?.hasLyrics) openLyrics();
  else closeLyrics();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLyrics(); });

/* =============== Голосовой поиск =============== */

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
els.voice.addEventListener('click', () => {
  if (!Recognition) return toast('Голосовой поиск не поддерживается этим браузером');
  if (recognition) return recognition.stop();
  recognition = new Recognition();
  recognition.lang = 'ru-RU';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onresult = (e) => {
    const text = e.results[0][0].transcript;
    location.hash = `#/search?q=${encodeURIComponent(text)}`;
  };
  recognition.onerror = (e) => {
    if (e.error !== 'aborted' && e.error !== 'no-speech') toast('Не расслышал, попробуйте ещё раз');
  };
  recognition.onend = () => {
    recognition = null;
    els.voice.classList.remove('is-listening');
  };
  els.voice.classList.add('is-listening');
  toast('Говорите…');
  recognition.start();
});

/* =============== Экраны =============== */

function emptyState(iconName, title, text, action = '') {
  return `<div class="empty">${icon(iconName)}<b>${title}</b><span>${text}</span>${action}</div>`;
}

function mixCard(key, label, title, tracks) {
  lists.set(key, tracks);
  const { tc, accent } = paletteFrom(tracks[0]?.color);
  const covers = tracks.filter((t) => t.cover).slice(0, 3);
  const active = player.source === key && player.current;
  return `
    <button class="mix" data-mix="${key}" style="--mix:${tc};--mix2:${accent}">
      <span class="mix__covers">${covers.map((t) => `<img src="${t.cover}" alt="" loading="lazy">`).join('')}</span>
      <span class="mix__label">${active ? 'Вернуться' : label}</span>
      <span class="mix__title">${esc(title)}</span>
      <span class="mix__play">${icon('play')}</span>
    </button>`;
}

async function viewHome() {
  feed = await api.feed();
  if (!feed.wave.length) {
    return emptyState('wave', 'Здесь пока тихо',
      'Загрузите аудиофайлы в папку music в репозитории — сайт пересоберётся сам',
      uploadUrl ? `<a class="btn btn--accent" href="${uploadUrl}" target="_blank" rel="noopener">Загрузить музыку</a>` : '');
  }
  if (!player.current) {
    player.source = 'mix:wave';
    player.setQueue(feed.wave, 0, { autoplay: false });
  }
  const mins = Math.max(1, Math.round((feed.nextRefresh - Date.now()) / 60000));
  const mixes = [
    mixCard('mix:wave', 'Слушать', 'Моя волна', feed.wave),
    mixCard('mix:fresh', 'Только что', 'Новинки', feed.fresh),
    mixCard('mix:popular', 'Твоё', 'На повторе', feed.popular),
    feed.liked.length ? mixCard('mix:liked', 'Ваше', 'Любимое', feed.liked) : '',
  ].join('');

  const playlists = feed.playlists.length ? `
    <section>
      <div class="section__head"><h2 class="section__title">Твои плейлисты</h2></div>
      <div class="rail" style="grid-auto-columns:150px">
        ${feed.playlists.map((p) => `<a class="pl" href="#/playlist/${p.id}">${plCover(p)}<span class="pl__title">${esc(p.title)}</span></a>`).join('')}
      </div>
    </section>` : '';

  const demoHint = feed.demo ? `
    <section class="hero" style="--c:${esc(paletteFrom(feed.wave[0]?.color).tc)}">
      <span class="hero__top">${icon('wave')} Демо-режим</span>
      <span class="hero__sub">Сейчас играют сгенерированные демо-треки. Загрузи свои файлы в папку music — через пару минут они появятся здесь.</span>
      ${uploadUrl ? `<div class="hero__actions"><a class="btn btn--accent" href="${uploadUrl}" target="_blank" rel="noopener">${icon('plus')}Загрузить музыку</a></div>` : ''}
    </section>` : '';

  return `
    ${demoHint}
    <section>
      <div class="section__head">
        <h2 class="section__title">Подборки для тебя</h2>
        <span class="section__hint">обновятся через ${mins} ${plural(mins, 'минуту', 'минуты', 'минут')}</span>
      </div>
      <div class="rail">${mixes}</div>
    </section>
    ${playlists}
    <section>
      <div class="section__head"><h2 class="section__title">Новое</h2></div>
      ${trackRows('home:fresh', feed.fresh.slice(0, 8))}
    </section>
    <section>
      <div class="section__head"><h2 class="section__title">Часто слушаешь</h2></div>
      ${trackRows('home:popular', feed.popular.slice(0, 8))}
    </section>`;
}

function hero({ label, title, sub, key, color, extra = '' }) {
  return `
    <section class="hero" style="--c:${esc(paletteFrom(color).tc)}">
      <span class="hero__top">${label}</span>
      <h1 class="hero__title">${esc(title)}</h1>
      <span class="hero__sub">${sub}</span>
      <div class="hero__actions">
        <button class="btn" data-act="play-all" data-key="${key}">${icon('play')}Слушать</button>
        <button class="btn btn--ghost" data-act="shuffle-all" data-key="${key}">${icon('shuffle')}Вперемешку</button>
        ${extra}
      </div>
    </section>`;
}

async function viewLiked() {
  const tracks = await api.likes();
  if (!tracks.length) {
    return `<h1 class="page-title">Любимое</h1>${emptyState('heart', 'Пока пусто', 'Нажимайте на сердечко у треков — они появятся здесь')}`;
  }
  return `
    ${hero({ label: `${icon('heart-fill')} Коллекция`, title: 'Мне нравится', sub: `${tracks.length} ${plural(tracks.length, 'трек', 'трека', 'треков')}`, key: 'liked', color: tracks[0].color })}
    ${trackRows('liked', tracks)}`;
}

async function viewPlaylists() {
  const playlists = await api.playlists();
  return `
    <h1 class="page-title">Плейлисты</h1>
    <div class="grid">
      <button class="pl" data-act="new-playlist">
        <span class="pl__cover pl__cover--new">${icon('plus')}</span>
        <span class="pl__title">Новый плейлист</span>
      </button>
      ${playlists.map((p) => `
        <a class="pl" href="#/playlist/${p.id}">
          ${plCover(p)}
          <span class="pl__title">${esc(p.title)}</span>
          <span class="pl__sub">${p.count} ${plural(p.count, 'трек', 'трека', 'треков')}</span>
        </a>`).join('')}
    </div>`;
}

async function viewPlaylist() {
  const p = await api.playlist(route.id);
  route.playlist = p;
  const extra = `
    <button class="round-btn" data-act="rename-playlist" aria-label="Переименовать">${icon('lyrics')}</button>
    <button class="round-btn" data-act="delete-playlist" aria-label="Удалить плейлист">${icon('trash')}</button>`;
  return `
    <a class="chip" href="#/playlists" style="justify-self:start">${icon('back')}Плейлисты</a>
    ${hero({ label: `${icon('library')} Плейлист`, title: p.title, sub: `${p.tracks.length} ${plural(p.tracks.length, 'трек', 'трека', 'треков')}`, key: `pl:${p.id}`, color: p.tracks[0]?.color, extra })}
    ${p.tracks.length
      ? trackRows(`pl:${p.id}`, p.tracks, { removable: true })
      : emptyState('plus', 'Плейлист пуст', 'Добавляйте треки кнопкой «+» в плеере или в списках')}`;
}

let searchTimer;
els.view.addEventListener('input', (e) => {
  if (e.target.id !== 'search-input') return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const value = e.target.value.trim();
    history.replaceState(null, '', value ? `#/search?q=${encodeURIComponent(value)}` : '#/search');
    route.q = value;
    try {
      const html = await searchResults(value);
      if (route.name === 'search' && route.q === value) $('#search-results').innerHTML = html;
      renderRows();
    } catch (err) {
      toast(err.message);
    }
  }, 250);
});

async function viewSearch() {
  const q = route.q || '';
  return `
    <label class="search">${icon('search')}
      <input id="search-input" type="search" value="${esc(q)}" placeholder="Трек, артист или альбом" autocomplete="off" enterkeyhint="search">
    </label>
    <div id="search-results">${await searchResults(q)}</div>`;
}

async function searchResults(q) {
  const tracks = await api.search(q);
  if (!tracks.length) return emptyState('search', 'Ничего не нашлось', `По запросу «${esc(q)}» треков нет`);
  return `
    <div class="section__head" style="margin-top:20px"><h2 class="section__title">${q ? 'Найдено' : 'Все треки'}</h2>
    <span class="section__hint">${tracks.length}</span></div>
    ${trackRows(`search:${q}`, tracks)}`;
}

const VIEWS = {
  home: viewHome,
  liked: viewLiked,
  playlists: viewPlaylists,
  playlist: viewPlaylist,
  search: viewSearch,
};

function parseRoute() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [name, id] = path.split('/');
  const params = new URLSearchParams(query);
  if (name === 'playlist' && id) return { name: 'playlist', id };
  if (VIEWS[name]) return { name, q: params.get('q') || '' };
  return { name: 'home' };
}

function updateChrome() {
  const home = route.name === 'home';
  els.player.hidden = !home || !player.current;
  els.mini.hidden = home || !player.current;
  const tab = route.name === 'playlist' ? 'playlists' : route.name;
  document.querySelectorAll('.tab').forEach((a) => {
    a.classList.toggle('is-active', a.dataset.tab === tab);
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

let renderId = 0;
async function render() {
  const id = ++renderId;
  route = parseRoute();
  closeLyrics();
  updateChrome();
  try {
    const html = await VIEWS[route.name]();
    if (id !== renderId) return;
    for (const key of [...lists.keys()]) {
      if (!html.includes(`"${esc(key)}"`)) lists.delete(key);
    }
    els.view.innerHTML = html;
    if (route.name === 'search' && !route.q) $('#search-input')?.focus();
  } catch (err) {
    if (id !== renderId) return;
    els.view.innerHTML = emptyState('close', 'Что-то пошло не так', esc(err.message),
      '<button class="btn btn--ghost" onclick="location.reload()">Обновить</button>');
  }
  updateChrome();
  renderRows();
}

window.addEventListener('hashchange', () => {
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
});
window.addEventListener('scroll', () => {
  $('.topbar').classList.toggle('is-scrolled', window.scrollY > 8);
}, { passive: true });

/* =============== Старт =============== */

renderMode();
renderVolume();
renderState();
player.restore();
render();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
