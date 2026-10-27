// Рекомендации из SoundCloud для «Моей волны» — без ключей и без нашего сервера.
// Официальный плеер SoundCloud умеет загрузить профиль артиста и отдать список его треков;
// берём артистов, которых человек слушает и лайкает, и предлагаем их треки, которых у нас ещё нет.

import { store } from './util.js';
import { SC_PREFIX } from './soundcloud.js';

const API_SRC = 'https://w.soundcloud.com/player/api.js';
const CACHE_TTL = 3_600_000; // час
const MAX_ARTISTS = 4;

function loadApi() {
  if (window.SC) return Promise.resolve(window.SC);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = API_SRC;
    s.onload = () => resolve(window.SC);
    s.onerror = reject;
    document.head.append(s);
  });
}

// https://soundcloud.com/артист/трек → https://soundcloud.com/артист
export function artistUrl(trackUrl) {
  try {
    const u = new URL(trackUrl);
    const name = u.pathname.split('/').filter(Boolean)[0];
    return name ? `https://soundcloud.com/${name}` : null;
  } catch {
    return null;
  }
}

function bigArtwork(url) {
  return url ? url.replace(/-(large|t\d+x\d+)\.(jpg|png)$/, '-t500x500.$2') : null;
}

// Треки одного артиста через невидимый служебный плеер (ничего не воспроизводит)
function artistSounds(SC, url) {
  return new Promise((resolve) => {
    let holder = document.getElementById('sc-probe');
    if (!holder) {
      holder = document.createElement('div');
      holder.id = 'sc-probe';
      holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:160px;overflow:hidden';
      holder.setAttribute('aria-hidden', 'true');
      document.body.append(holder);
    }
    const iframe = document.createElement('iframe');
    iframe.src = `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&auto_play=false`;
    iframe.tabIndex = -1;
    holder.replaceChildren(iframe);
    const done = (list) => { clearTimeout(timer); iframe.remove(); resolve(list); };
    const timer = setTimeout(() => done([]), 12_000);
    const w = SC.Widget(iframe);
    w.bind(SC.Widget.Events.ERROR, () => done([]));
    w.bind(SC.Widget.Events.READY, () => w.getSounds((sounds) => done(sounds || [])));
  });
}

function toTrack(s) {
  return {
    id: `sc-${s.id}`,
    title: s.title,
    artist: s.user?.username || 'SoundCloud',
    album: 'SoundCloud',
    duration: (s.duration || 0) / 1000,
    color: '#ff5500',
    peaks: null,
    liked: false,
    hasLyrics: false,
    cover: bigArtwork(s.artwork_url || s.user?.avatar_url),
    stream: SC_PREFIX + s.permalink_url,
    soundcloud: s.permalink_url,
    external: true, // ещё не в нашей библиотеке
  };
}

/**
 * Рекомендации: треки из плейлиста SoundCloud (если указан) и треки артистов-«семян»,
 * которых нет в каталоге. seeds — ссылки на треки SoundCloud (лайки, прослушивания).
 */
export async function soundcloudRecs(seeds, known, playlist = null) {
  let artists = [...new Set(seeds.map(artistUrl).filter(Boolean))].slice(0, MAX_ARTISTS);
  if (!artists.length && !playlist) return [];
  const key = `${playlist || ''}#${artists.join('|')}`;
  const cached = store('screcs');
  if (cached?.key === key && Date.now() - cached.at < CACHE_TTL) {
    return cached.tracks.filter((t) => !known.has(t.soundcloud));
  }
  let SC;
  try {
    SC = await loadApi();
  } catch {
    return [];
  }
  // у части треков плеер отдаёт только номер, без названия — такие пропускаем
  const usable = (sounds) => sounds.filter((s) => s.title && s.permalink_url && s.streamable !== false).map(toTrack);
  const sources = [];
  if (playlist) {
    const own = usable(await artistSounds(SC, playlist));
    // перемешиваем, чтобы волна каждый раз начиналась по-разному
    for (let i = own.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [own[i], own[j]] = [own[j], own[i]];
    }
    sources.push(own);
    // артисты из плейлиста — источник «ещё от этих артистов»
    artists = [...new Set([...artists, ...own.map((t) => artistUrl(t.soundcloud))])].slice(0, MAX_ARTISTS);
  }
  for (const url of artists) sources.push(usable(await artistSounds(SC, url)));
  // чередуем источники по кругу, чтобы подряд не шли треки одного артиста, и убираем повторы
  const seen = new Set();
  const tracks = [];
  for (let i = 0; sources.some((list) => i < list.length); i++) {
    for (const list of sources) {
      const t = list[i];
      if (t && !seen.has(t.soundcloud)) {
        seen.add(t.soundcloud);
        tracks.push(t);
      }
    }
  }
  tracks.splice(60);
  store('screcs', { key, at: Date.now(), tracks });
  return tracks.filter((t) => !known.has(t.soundcloud));
}
