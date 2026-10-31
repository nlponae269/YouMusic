// Поиск треков для загрузки на сайт: открытый каталог Openverse (музыка Jamendo под лицензиями
// Creative Commons). Берём только лицензии, разрешающие изменения: цензура меняет трек.
// Запросы идут прямо из браузера, без ключа (лимит Openverse — 20 запросов в минуту на человека).

const API = 'https://api.openverse.org/v1/audio/';
const LICENSES = new Set(['by', 'by-sa', 'by-nc', 'by-nc-sa', 'cc0', 'pdm']);
const cache = new Map();

function licenceName(r) {
  if (r.license === 'cc0') return 'CC0';
  if (r.license === 'pdm') return 'Public Domain';
  return `CC ${r.license.toUpperCase()}${r.license_version ? ` ${r.license_version}` : ''}`;
}

// «2 SnikS - Это Хип Хоп» → «Это Хип Хоп»: номер трека и имя артиста в названии лишние
function cleanTitle(title, artist) {
  let t = title.trim().replace(/^\d{1,2}[\s.)_-]+/, '');
  const prefix = `${artist.toLowerCase()} - `;
  if (t.toLowerCase().startsWith(prefix)) t = t.slice(prefix.length);
  return t.trim() || title.trim();
}

function toItem(r) {
  const artist = (r.creator || 'Неизвестный артист').replace(/\s*-\s*$/, '').trim();
  return {
    id: r.id,
    title: cleanTitle(r.title || 'Без названия', artist),
    artist,
    duration: (r.duration || 0) / 1000,
    url: r.url,
    landing: r.foreign_landing_url,
    licence: licenceName(r),
    source: 'Jamendo',
    cover: cover(r),
  };
}

// Обложка альбома с сервера Jamendo: номер альбома есть в ссылке на его страницу
function cover(r) {
  const m = /\/album\/(\d+)/.exec(r.audio_set?.foreign_landing_url || '');
  return m ? `https://usercontent.jamendo.com/?type=album&id=${m[1]}&width=300` : null;
}

const PAGE = 20;

// Каталог на новых запросах думает до полуминуты и иногда отвечает 500/504 — тогда пробуем ещё раз
async function request(url, tries = 2) {
  for (let i = 1; ; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45_000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (res.status < 500 || i >= tries) return res;
    } catch (err) {
      if (i >= tries) throw new Error('Каталог для загрузки не отвечает — попробуй ещё раз');
    } finally {
      clearTimeout(timer);
    }
  }
}

// Возвращает { items, more }: more — есть ли следующая страница
export async function searchOpen(q, page = 1) {
  const query = q.trim();
  if (query.length < 2) return { items: [], more: false };
  const key = `${query}#${page}`;
  if (cache.has(key)) return cache.get(key);
  const params = new URLSearchParams({
    q: query, license_type: 'modification', source: 'jamendo', page_size: String(PAGE), page: String(page),
  });
  const res = await request(`${API}?${params}`);
  if (res.status === 429) throw new Error('Слишком много поисков подряд — подожди минуту');
  if (!res.ok) throw new Error('Каталог для загрузки сейчас недоступен');
  const data = await res.json();
  const items = data.results
    .filter((r) => LICENSES.has(r.license) && r.url && r.foreign_landing_url && !r.mature
      && (!r.duration || r.duration <= 600_000))
    .map(toItem);
  const result = { items, more: page < (data.page_count || 0) };
  cache.set(key, result);
  return result;
}

// Быстрые запросы для пустого поиска
// [подпись, запрос]: каталог в основном англоязычный, поэтому запросы — как там подписаны треки
export const GENRES = [['Рэп', 'рэп'], ['Хип-хоп', 'хип хоп'], ['Rap', 'rap'], ['Trap', 'trap'], ['Lo-fi', 'lofi'],
  ['Поп', 'pop'], ['Рок', 'rock'], ['Электроника', 'electronic'], ['Chill', 'chill']];
