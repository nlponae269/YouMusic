// Треки SoundCloud играют через официальный плеер SoundCloud (Widget API).
// Этот класс повторяет нужную часть интерфейса <audio>, чтобы плеер сайта
// управлял обоими видами треков одинаково.

const API_SRC = 'https://w.soundcloud.com/player/api.js';
let apiPromise = null;

function loadApi() {
  if (!apiPromise) {
    apiPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = API_SRC;
      s.onload = () => resolve(window.SC);
      s.onerror = () => { apiPromise = null; reject(new Error('Не удалось загрузить плеер SoundCloud')); };
      document.head.append(s);
    });
  }
  return apiPromise;
}

export const SC_PREFIX = 'soundcloud:';

export class ScAudio extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.widget = null;
    this.ready = false;
    this._url = '';
    this._paused = true;
    this._time = 0;
    this._duration = NaN;
    this._volume = 0.8;
    this._muted = false;
    this._wantPlay = false;
    this._seek = null;
    this._gestureTimer = null;
    this.buffered = { length: 0 };
  }

  emit(type) {
    this.dispatchEvent(new Event(type));
  }

  get src() {
    return this._url;
  }

  set src(value) {
    const url = String(value || '').replace(SC_PREFIX, '');
    if (url === this._url) return;
    this._url = url;
    this.ready = false;
    this._paused = true;
    this._time = 0;
    this._duration = NaN;
    this._wantPlay = false;
    this._seek = null;
    const iframe = document.createElement('iframe');
    iframe.className = 'sc-frame';
    iframe.allow = 'autoplay; encrypted-media';
    iframe.title = 'Плеер SoundCloud';
    iframe.src = `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}`
      + '&auto_play=false&visual=true&hide_related=true&show_comments=false&show_reposts=false&show_teaser=false&buying=false&sharing=false&download=false';
    this.container.replaceChildren(iframe);
    loadApi().then((SC) => {
      if (this._url !== url) return; // за это время включили другой трек
      const w = SC.Widget(iframe);
      this.widget = w;
      const E = SC.Widget.Events;
      w.bind(E.READY, () => {
        this.ready = true;
        w.setVolume(this._muted ? 0 : Math.round(this._volume * 100));
        w.getDuration((ms) => { this._duration = ms / 1000; this.emit('loadedmetadata'); });
        if (this._seek !== null) w.seekTo(this._seek * 1000);
        if (this._wantPlay) w.play();
      });
      w.bind(E.PLAY, () => { this._paused = false; clearTimeout(this._gestureTimer); this.emit('play'); });
      w.bind(E.PAUSE, () => { this._paused = true; this.emit('pause'); });
      w.bind(E.FINISH, () => { this._paused = true; this.emit('ended'); });
      w.bind(E.PLAY_PROGRESS, (e) => {
        this._time = e.currentPosition / 1000;
        this.emit('timeupdate');
      });
      w.bind(E.ERROR, () => this.emit('error'));
    }).catch(() => this.emit('error'));
  }

  play() {
    this._wantPlay = true;
    if (this.ready) this.widget.play();
    // на телефонах SoundCloud не всегда разрешает запуск без нажатия внутри своего плеера
    clearTimeout(this._gestureTimer);
    this._gestureTimer = setTimeout(() => { if (this._paused) this.emit('needgesture'); }, 3000);
    return Promise.resolve();
  }

  pause() {
    this._wantPlay = false;
    clearTimeout(this._gestureTimer);
    if (this.ready) this.widget.pause();
  }

  get paused() {
    return this._paused;
  }

  get currentTime() {
    return this._time;
  }

  set currentTime(sec) {
    const t = Math.max(0, Number(sec) || 0);
    this._time = t;
    if (this.ready) this.widget.seekTo(t * 1000);
    else this._seek = t;
    this.emit('timeupdate');
  }

  get duration() {
    return this._duration;
  }

  get volume() {
    return this._volume;
  }

  set volume(v) {
    this._volume = Math.max(0, Math.min(1, v));
    if (this.ready) this.widget.setVolume(this._muted ? 0 : Math.round(this._volume * 100));
    this.emit('volumechange');
  }

  get muted() {
    return this._muted;
  }

  set muted(m) {
    this._muted = !!m;
    if (this.ready) this.widget.setVolume(this._muted ? 0 : Math.round(this._volume * 100));
    this.emit('volumechange');
  }
}
