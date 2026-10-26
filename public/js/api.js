// «Бэкенд» без сервера: каталог (catalog.json) и музыка лежат рядом с сайтом на GitHub Pages,
// лайки, плейлисты и счётчики прослушиваний — в памяти браузера.

const CATALOG = 'catalog.json';

// Ссылка, куда загружать музыку в репозитории (config.js генерируется при сборке)
export const uploadUrl = window.YOUMUSIC_REPO
  ? `https://github.com/${window.YOUMUSIC_REPO}/upload/${window.YOUMUSIC_BRANCH || 'main'}/music`
  : null;

function mediaUrl(key) {
  return new URL(key, document.baseURI).href;
}

function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(`ym:${key}`)) ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(`ym:${key}`, JSON.stringify(value));
  } catch { /* хранилище браузера недоступно */ }
}

let catalogPromise = null;
let isDemo = false;
let catalogAt = 0;

async function catalog() {
  // перечитываем каталог не чаще раза в минуту
  if (!catalogPromise || Date.now() - catalogAt > 60_000) {
    catalogAt = Date.now();
    catalogPromise = (async () => {
      const res = await fetch(CATALOG, { cache: 'no-cache' });
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`Не удалось загрузить каталог (${res.status})`);
      const data = await res.json();
      isDemo = !!data.demo;
      return Array.isArray(data.tracks) ? data.tracks : [];
    })();
    catalogPromise.catch(() => { catalogPromise = null; });
  }
  return catalogPromise;
}

function view(t, likes) {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album || null,
    duration: t.duration || 0,
    color: t.color || '#7a5cff',
    peaks: t.peaks || null,
    liked: likes.includes(t.id),
    hasLyrics: !!t.lyrics,
    cover: t.cover ? mediaUrl(t.cover) : null,
    stream: mediaUrl(t.audio),
  };
}

async function tracksView() {
  const likes = load('likes', []);
  return (await catalog()).map((t) => view(t, likes));
}

// Детерминированное перемешивание: подборки стабильны в течение часа
function hourlyShuffle(list) {
  const seed = Math.floor(Date.now() / 3_600_000);
  const score = (id) => {
    let h = seed;
    for (const ch of id) h = (Math.imul(h ^ ch.charCodeAt(0), 2654435761) >>> 0);
    return h;
  };
  return list.slice().sort((a, b) => score(a.id) - score(b.id));
}

function byId(tracks) {
  return new Map(tracks.map((t) => [t.id, t]));
}

function playlistSummary(p, map) {
  const tracks = p.tracks.map((id) => map.get(id)).filter(Boolean);
  return {
    id: p.id,
    title: p.title,
    count: tracks.length,
    color: tracks[0]?.color || null,
    covers: tracks.filter((t) => t.cover).slice(0, 4).map((t) => t.cover),
  };
}

function findPlaylist(id) {
  const lists = load('playlists', []);
  const p = lists.find((x) => x.id === id);
  if (!p) throw new Error('Плейлист не найден');
  return { lists, p };
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export const api = {
  async feed() {
    const tracks = await tracksView();
    const likes = load('likes', []);
    const plays = load('plays', {});
    const likedArtists = new Set(tracks.filter((t) => t.liked).map((t) => t.artist));
    const map = byId(tracks);
    const wave = hourlyShuffle(tracks).sort((a, b) => likedArtists.has(b.artist) - likedArtists.has(a.artist));
    const fresh = tracks.slice().reverse();
    const popular = hourlyShuffle(tracks).sort((a, b) => (plays[b.id] || 0) - (plays[a.id] || 0));
    return {
      wave: wave.slice(0, 40),
      fresh: fresh.slice(0, 30),
      popular: popular.slice(0, 30),
      liked: likes.map((id) => map.get(id)).filter(Boolean),
      playlists: load('playlists', []).map((p) => playlistSummary(p, map)),
      demo: isDemo,
      nextRefresh: (Math.floor(Date.now() / 3_600_000) + 1) * 3_600_000,
    };
  },

  async search(q) {
    const tracks = (await tracksView()).reverse();
    const query = q.trim().toLowerCase();
    if (!query) return tracks.slice(0, 100);
    return tracks.filter((t) => `${t.artist} ${t.title} ${t.album || ''}`.toLowerCase().includes(query));
  },

  async lyrics(id) {
    const t = (await catalog()).find((x) => x.id === id);
    return { lyrics: t?.lyrics || '' };
  },

  async played(id) {
    const plays = load('plays', {});
    plays[id] = (plays[id] || 0) + 1;
    save('plays', plays);
  },

  async likes() {
    const map = byId(await tracksView());
    return load('likes', []).map((id) => map.get(id)).filter(Boolean);
  },

  async like(id, on) {
    const likes = load('likes', []).filter((x) => x !== id);
    if (on) likes.unshift(id);
    save('likes', likes);
  },

  async playlists() {
    const map = byId(await tracksView());
    return load('playlists', []).map((p) => playlistSummary(p, map));
  },

  async playlist(id) {
    const { p } = findPlaylist(id);
    const map = byId(await tracksView());
    return { id: p.id, title: p.title, tracks: p.tracks.map((t) => map.get(t)).filter(Boolean) };
  },

  async createPlaylist(title) {
    const name = String(title || '').trim().slice(0, 80);
    if (!name) throw new Error('Введите название');
    const lists = load('playlists', []);
    const p = { id: newId(), title: name, tracks: [] };
    lists.unshift(p);
    save('playlists', lists);
    return { id: p.id, title: p.title, count: 0, covers: [], color: null };
  },

  async renamePlaylist(id, title) {
    const name = String(title || '').trim().slice(0, 80);
    if (!name) throw new Error('Введите название');
    const { lists, p } = findPlaylist(id);
    p.title = name;
    save('playlists', lists);
  },

  async deletePlaylist(id) {
    save('playlists', load('playlists', []).filter((p) => p.id !== id));
  },

  async addToPlaylist(id, trackId) {
    const { lists, p } = findPlaylist(id);
    if (p.tracks.includes(trackId)) return { added: false };
    p.tracks.push(trackId);
    save('playlists', lists);
    return { added: true };
  },

  async removeFromPlaylist(id, trackId) {
    const { lists, p } = findPlaylist(id);
    p.tracks = p.tracks.filter((t) => t !== trackId);
    save('playlists', lists);
  },
};
