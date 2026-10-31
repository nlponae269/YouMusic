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
  };
}

export async function searchOpen(q) {
  const query = q.trim();
  if (query.length < 2) return [];
  if (cache.has(query)) return cache.get(query);
  const params = new URLSearchParams({ q: query, license_type: 'modification', source: 'jamendo', page_size: '20' });
  const res = await fetch(`${API}?${params}`);
  if (res.status === 429) throw new Error('Слишком много поисков подряд — подожди минуту');
  if (!res.ok) throw new Error('Каталог для загрузки сейчас недоступен');
  const items = (await res.json()).results
    .filter((r) => LICENSES.has(r.license) && r.url && r.foreign_landing_url && (!r.duration || r.duration <= 600_000))
    .map(toItem);
  cache.set(query, items);
  return items;
}
