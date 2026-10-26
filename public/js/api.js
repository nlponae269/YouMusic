function clientId() {
  let id;
  try { id = localStorage.getItem('ym:client'); } catch { /* приватный режим */ }
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try { localStorage.setItem('ym:client', id); } catch { /* без сохранения */ }
  }
  return id;
}

const CLIENT_ID = clientId();

// Адрес сервера задаётся в config.js; пусто — тот же домен
export const API_BASE = String(window.YOUMUSIC_API || '').replace(/\/$/, '');

export function apiUrl(path) {
  return `${API_BASE}${path}`;
}

// Сервер отдаёт ссылки вида /api/…; если фронт живёт на другом домене, дописываем адрес сервера
function absolutize(value) {
  if (typeof value === 'string') return value.startsWith('/api/') ? apiUrl(value) : value;
  if (Array.isArray(value)) return value.map(absolutize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, absolutize(v)]));
  }
  return value;
}

async function request(method, url, body) {
  const res = await fetch(apiUrl(url), {
    method,
    headers: {
      'X-Client-Id': CLIENT_ID,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Ошибка ${res.status}`);
  }
  return res.status === 204 ? null : absolutize(await res.json());
}

export const api = {
  feed: () => request('GET', '/api/feed'),
  search: (q) => request('GET', `/api/tracks?q=${encodeURIComponent(q)}`),
  track: (id) => request('GET', `/api/tracks/${id}`),
  lyrics: (id) => request('GET', `/api/tracks/${id}/lyrics`),
  played: (id) => request('POST', `/api/tracks/${id}/play`),
  likes: () => request('GET', '/api/likes'),
  like: (id, on) => request(on ? 'PUT' : 'DELETE', `/api/likes/${id}`),
  playlists: () => request('GET', '/api/playlists'),
  playlist: (id) => request('GET', `/api/playlists/${id}`),
  createPlaylist: (title) => request('POST', '/api/playlists', { title }),
  renamePlaylist: (id, title) => request('PATCH', `/api/playlists/${id}`, { title }),
  deletePlaylist: (id) => request('DELETE', `/api/playlists/${id}`),
  addToPlaylist: (id, trackId) => request('POST', `/api/playlists/${id}/tracks`, { trackId }),
  removeFromPlaylist: (id, trackId) => request('DELETE', `/api/playlists/${id}/tracks/${trackId}`),
};
