import { api } from './api.js';
import { store } from './util.js';
import { ScAudio, SC_PREFIX } from './soundcloud.js';

const REPEAT_MODES = ['off', 'all', 'one'];

class Player extends EventTarget {
  // html — обычный <audio> для наших треков, sc — плеер SoundCloud
  constructor(html, sc) {
    super();
    this.engines = [html, sc];
    this.html = html;
    this.sc = sc;
    this.active = html;
    this.queue = [];
    this.original = null; // порядок до перемешивания
    this.index = -1;
    this.shuffle = false;
    this.repeat = 'off';
    this.counted = false;
    this.savedAt = 0;
    this.source = null; // откуда запущена очередь (подборка, плейлист…)

    const saved = store('player') || {};
    this.shuffle = !!saved.shuffle;
    this.repeat = REPEAT_MODES.includes(saved.repeat) ? saved.repeat : 'off';
    for (const e of this.engines) {
      e.volume = typeof saved.volume === 'number' ? saved.volume : 0.8;
      e.muted = !!saved.muted;
      this.bind(e);
    }
    this.setupMediaSession();
  }

  // Текущий движок воспроизведения: у обоих одинаковый интерфейс
  get audio() {
    return this.active;
  }

  bind(audio) {
    const on = (type, fn) => audio.addEventListener(type, (e) => { if (audio === this.active) fn(e); });
    on('play', () => this.emit('state'));
    on('pause', () => { this.emit('state'); this.save(); });
    on('volumechange', () => { this.emit('volume'); this.save(); });
    on('loadedmetadata', () => this.emit('time'));
    on('progress', () => this.emit('time'));
    on('needgesture', () => this.emit('needgesture'));
    on('timeupdate', () => {
      this.emit('time');
      if (!this.counted && audio.currentTime > 10 && this.current) {
        this.counted = true;
        api.played(this.current.id).catch(() => {});
      }
      if (Date.now() - this.savedAt > 5000) this.save();
    });
    on('ended', () => {
      if (this.repeat === 'one') {
        audio.currentTime = 0;
        audio.play();
      } else {
        this.next(true);
      }
    });
    on('error', () => {
      if (this.current) this.emit('error');
    });
  }

  emit(type) {
    this.dispatchEvent(new Event(type));
  }

  get current() {
    return this.queue[this.index] || null;
  }

  get playing() {
    return !this.audio.paused;
  }

  get duration() {
    const d = this.audio.duration;
    return Number.isFinite(d) && d > 0 ? d : this.current?.duration || 0;
  }

  setQueue(tracks, index = 0, { autoplay = true, position = 0 } = {}) {
    this.queue = tracks.slice();
    this.original = null;
    this.index = Math.max(0, Math.min(index, this.queue.length - 1));
    if (this.shuffle) this.shuffleRest();
    this.load(position);
    if (autoplay) this.play();
  }

  load(position = 0) {
    const track = this.current;
    if (!track) return;
    this.counted = false;
    const engine = String(track.stream).startsWith(SC_PREFIX) ? this.sc : this.html;
    if (engine !== this.active) this.active.pause();
    this.active = engine;
    this.audio.src = track.stream;
    if (position) {
      this.audio.addEventListener('loadedmetadata', () => { this.audio.currentTime = position; }, { once: true });
    }
    this.updateMediaSession();
    this.emit('track');
    this.save();
  }

  play() {
    if (!this.current) return;
    this.audio.play().catch((err) => {
      if (err.name !== 'AbortError') console.warn(err);
    });
  }

  pause() {
    this.audio.pause();
  }

  toggle() {
    if (this.audio.paused) this.play();
    else this.pause();
  }

  jump(index) {
    if (!this.queue.length) return;
    this.index = (index + this.queue.length) % this.queue.length;
    this.load();
    this.play();
  }

  next(auto = false) {
    if (!this.queue.length) return;
    if (this.index >= this.queue.length - 1 && auto && this.repeat === 'off') {
      this.pause();
      this.audio.currentTime = 0;
      return;
    }
    this.jump(this.index + 1);
  }

  prev() {
    if (this.audio.currentTime > 4) {
      this.audio.currentTime = 0;
      return;
    }
    this.jump(this.index - 1);
  }

  seek(fraction) {
    const d = this.duration;
    if (d) this.audio.currentTime = Math.max(0, Math.min(d - 0.1, fraction * d));
  }

  shuffleRest() {
    this.original = this.queue.slice();
    const rest = this.queue.slice(this.index + 1).concat(this.queue.slice(0, this.index));
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    this.queue = [this.current, ...rest];
    this.index = 0;
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    if (this.current) {
      if (this.shuffle) {
        this.shuffleRest();
      } else if (this.original) {
        const id = this.current.id;
        this.queue = this.original;
        this.original = null;
        this.index = Math.max(0, this.queue.findIndex((t) => t.id === id));
      }
    }
    this.emit('mode');
    this.save();
  }

  cycleRepeat() {
    this.repeat = REPEAT_MODES[(REPEAT_MODES.indexOf(this.repeat) + 1) % REPEAT_MODES.length];
    this.emit('mode');
    this.save();
  }

  setVolume(v) {
    for (const e of this.engines) {
      e.volume = Math.max(0, Math.min(1, v));
      if (v > 0) e.muted = false;
    }
  }

  toggleMute() {
    const muted = !this.audio.muted;
    for (const e of this.engines) e.muted = muted;
  }

  // Обновить данные трека (например, лайк) во всей очереди
  patch(id, changes) {
    for (const t of [...this.queue, ...(this.original || [])]) {
      if (t.id === id) Object.assign(t, changes);
    }
    if (this.current?.id === id) this.emit('track-meta');
  }

  save() {
    this.savedAt = Date.now();
    store('player', {
      source: this.source,
      shuffle: this.shuffle,
      repeat: this.repeat,
      volume: this.audio.volume,
      muted: this.audio.muted,
      queue: this.queue.slice(0, 100),
      index: this.index,
      position: this.audio.currentTime || 0,
    });
  }

  restore() {
    const saved = store('player');
    if (saved?.queue?.length && saved.index >= 0) {
      this.queue = saved.queue;
      this.source = saved.source || null;
      this.index = Math.min(saved.index, saved.queue.length - 1);
      this.load(saved.position || 0);
      return true;
    }
    return false;
  }

  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const handlers = {
      play: () => this.play(),
      pause: () => this.pause(),
      previoustrack: () => this.prev(),
      nexttrack: () => this.next(),
      seekto: (e) => { this.audio.currentTime = e.seekTime; },
      seekbackward: (e) => { this.audio.currentTime -= e.seekOffset || 10; },
      seekforward: (e) => { this.audio.currentTime += e.seekOffset || 10; },
    };
    for (const [action, fn] of Object.entries(handlers)) {
      try { ms.setActionHandler(action, fn); } catch { /* действие не поддерживается */ }
    }
    this.addEventListener('time', () => {
      const d = this.duration;
      if (!d || !ms.setPositionState) return;
      try {
        ms.setPositionState({ duration: d, position: Math.min(this.audio.currentTime, d), playbackRate: 1 });
      } catch { /* некорректная позиция во время загрузки */ }
    });
  }

  updateMediaSession() {
    if (!('mediaSession' in navigator) || !this.current) return;
    const t = this.current;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist,
      album: t.album || 'YouMusic',
      artwork: t.cover ? [{ src: new URL(t.cover, location.href).href, sizes: '512x512' }] : [],
    });
  }
}

export const player = new Player(document.getElementById('audio'), new ScAudio(document.getElementById('sc-holder')));
