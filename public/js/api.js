// Данные сайта: каталог, аккаунты и загрузки — в Supabase (бесплатный тариф),
// лайки, плейлисты и счётчики прослушиваний — в памяти браузера.

const URL_BASE = String(window.YOUMUSIC_SUPABASE_URL || '').replace(/\/$/, '');
const ANON_KEY = window.YOUMUSIC_SUPABASE_KEY || '';

export const configured = !!(URL_BASE && ANON_KEY && window.supabase);
export const sb = configured ? window.supabase.createClient(URL_BASE, ANON_KEY) : null;

export const MAX_UPLOAD = 50 * 1024 * 1024;

function publicUrl(key) {
  return `${URL_BASE}/storage/v1/object/public/tracks/${key}`;
}

function mediaUrl(key) {
  return key ? publicUrl(key) : null;
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

function check({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

/* ---------- Каталог ---------- */

const TRACK_COLUMNS = 'id,title,artist,album,duration,color,peaks,has_lyrics,audio_path,cover_path,uploader,published_at';
let catalogPromise = null;
let catalogAt = 0;

async function catalog() {
  if (!configured) return [];
  if (!catalogPromise || Date.now() - catalogAt > 60_000) {
    catalogAt = Date.now();
    catalogPromise = sb.from('tracks').select(TRACK_COLUMNS).eq('status', 'ready')
      .not('audio_path', 'like', 'soundcloud:%')
      .order('published_at', { ascending: true }).limit(5000).then(check);
    catalogPromise.catch(() => { catalogPromise = null; });
  }
  return catalogPromise;
}

export function refreshCatalog() {
  catalogPromise = null;
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
    hasLyrics: !!t.has_lyrics,
    uploader: t.uploader || null,
    // автозагрузка из ccMixter: uploader = «ccmixter:<автор>/<номер>»
    source: t.uploader?.startsWith('ccmixter:') ? `https://ccmixter.org/files/${t.uploader.slice(9)}` : null,
    cover: mediaUrl(t.cover_path),
    stream: publicUrl(t.audio_path),
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
      nextRefresh: (Math.floor(Date.now() / 3_600_000) + 1) * 3_600_000,
    };
  },

  async search(q) {
    const tracks = (await tracksView()).reverse();
    const query = q.trim().toLowerCase();
    if (!query) return tracks.slice(0, 100);
    return tracks.filter((t) => `${t.artist} ${t.title} ${t.album || ''} ${t.uploader || ''}`.toLowerCase().includes(query));
  },

  async track(id) {
    return (await tracksView()).find((t) => t.id === id) || null;
  },

  async lyrics(id) {
    const rows = check(await sb.from('tracks').select('lyrics').eq('id', id).limit(1));
    return { lyrics: rows[0]?.lyrics || '' };
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

/* ---------- Аккаунт ---------- */

const AUTH_ERRORS = {
  'Invalid login credentials': 'Неверная почта или пароль',
  'User already registered': 'Такая почта уже зарегистрирована',
  'Email not confirmed': 'Подтвердите почту — ссылка в письме',
  'Password should be at least 6 characters.': 'Пароль — минимум 6 символов',
};

function authCheck({ data, error }) {
  if (error) throw new Error(AUTH_ERRORS[error.message] || error.message);
  return data;
}


// Загрузка файла в приватный бакет incoming (с прогрессом)
function putIncoming(session, path, body, type, progress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${URL_BASE}/storage/v1/object/incoming/${path}`);
    xhr.setRequestHeader('Authorization', `Bearer ${session.access_token}`);
    xhr.setRequestHeader('apikey', ANON_KEY);
    xhr.setRequestHeader('Content-Type', type || 'application/octet-stream');
    xhr.setRequestHeader('x-upsert', 'false');
    if (progress) xhr.upload.onprogress = (e) => e.lengthComputable && progress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status < 300) return resolve();
      let msg = `Ошибка загрузки (${xhr.status})`;
      try { msg = JSON.parse(xhr.responseText).message || msg; } catch { /* не JSON */ }
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error('Нет связи с сервером'));
    xhr.send(body);
  });
}

export const AI_ALBUM = 'Сгенерировано нейросетью';

export const account = {
  async user() {
    if (!configured) return null;
    const { data } = await sb.auth.getSession();
    return data.session?.user || null;
  },

  nickname(user) {
    return user?.user_metadata?.nickname || user?.email?.split('@')[0] || 'Гость';
  },

  async signUp(email, password, nickname) {
    const data = authCheck(await sb.auth.signUp({
      email,
      password,
      options: { data: { nickname }, emailRedirectTo: location.href.split('#')[0] },
    }));
    return { needsConfirm: !data.session };
  },

  async signIn(email, password) {
    authCheck(await sb.auth.signInWithPassword({ email, password }));
  },

  async signOut() {
    await sb.auth.signOut();
  },

  onChange(fn) {
    if (configured) sb.auth.onAuthStateChange(() => fn());
  },

  async isAdmin() {
    const { data } = await sb.rpc('is_admin');
    return !!data;
  },

  async myTracks(all = false) {
    const user = await this.user();
    let q = sb.from('tracks')
      .select('id,title,artist,album,status,error,censored,cover_path,color,uploader,source_path,created_at')
      .order('created_at', { ascending: false }).limit(200);
    if (!all) q = q.eq('owner', user.id);
    return check(await q).map((t) => ({ ...t, cover: mediaUrl(t.cover_path) }));
  },

  async deleteTrack(id) {
    check(await sb.from('tracks').delete().eq('id', id));
    refreshCatalog();
  },

  // Файл → приватный бакет incoming (с прогрессом), затем строка в очередь модерации
  // Заявка на песню от нейросети: параметры — JSON-файлом в incoming, трек — в очередь
  async requestSong({ title, artist, caption, lyrics, language, duration, instrumental }) {
    const { data } = await sb.auth.getSession();
    const session = data.session;
    if (!session) throw new Error('Войдите в аккаунт');
    const uid = session.user.id;
    const id = newId();
    const sourcePath = `${uid}/${id}.gen`;
    const request = JSON.stringify({ caption, lyrics, language, duration, instrumental });
    // бакет принимает только audio/*, поэтому у файла заявки «аудио»-тип
    await putIncoming(session, sourcePath, new Blob([request]), 'audio/x-youmusic-request');
    check(await sb.from('tracks').insert({
      id,
      title: title.trim().slice(0, 200),
      artist: artist.trim().slice(0, 200),
      album: AI_ALBUM,
      source_path: sourcePath,
      uploader: this.nickname(session.user).slice(0, 60),
    }));
    return id;
  },

  async upload({ file, cover, title, artist, album, lyrics }, onProgress) {
    const { data } = await sb.auth.getSession();
    const session = data.session;
    if (!session) throw new Error('Войдите в аккаунт');
    if (file.size > MAX_UPLOAD) throw new Error('Файл больше 50 МБ');
    const uid = session.user.id;
    const id = newId();
    const ext = (file.name.split('.').pop() || 'mp3').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp3';
    const sourcePath = `${uid}/${id}.${ext}`;

    const put = (path, body, type, progress) => putIncoming(session, path, body, type, progress);

    await put(sourcePath, file, file.type || 'audio/mpeg', onProgress);
    let coverPath = null;
    if (cover) {
      const cext = { 'image/png': 'png', 'image/webp': 'webp' }[cover.type] || 'jpg';
      coverPath = `${uid}/${id}.cover.${cext}`;
      await put(coverPath, cover, cover.type || 'image/jpeg');
    }
    const user = session.user;
    check(await sb.from('tracks').insert({
      id,
      title: title.trim().slice(0, 200),
      artist: artist.trim().slice(0, 200),
      album: album?.trim().slice(0, 200) || null,
      lyrics: lyrics?.trim().slice(0, 20000) || null,
      source_path: sourcePath,
      cover_source: coverPath,
      uploader: this.nickname(user).slice(0, 60),
    }));
    return id;
  },
};
