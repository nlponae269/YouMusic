export const $ = (sel, root = document) => root.querySelector(sel);

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

export function icon(name) {
  return `<svg><use href="#i-${name}"/></svg>`;
}

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s * 100, l * 100];
}

// Из цвета обложки получаем насыщенный фон и контрастный акцент (сдвиг по кругу оттенков)
export function paletteFrom(hex) {
  const [h, s] = hexToHsl(/^#[0-9a-f]{6}$/i.test(hex || '') ? hex : '#7a5cff');
  const sat = Math.max(s, 55);
  return {
    tc: `hsl(${h.toFixed(0)} ${sat.toFixed(0)}% 42%)`,
    accent: `hsl(${((h + 140) % 360).toFixed(0)} 95% 70%)`,
  };
}

// Стабильная псевдо-волна для треков без сохранённых пиков
export function fakePeaks(seed, count = 64) {
  let x = 0;
  for (const ch of String(seed)) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  const out = [];
  for (let i = 0; i < count; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    const env = 0.55 + 0.45 * Math.sin((i / count) * Math.PI);
    out.push(Math.max(0.15, env * (0.35 + (x / 2 ** 32) * 0.65)));
  }
  return out;
}

export function resample(peaks, count) {
  if (!peaks?.length) return [];
  const out = [];
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i / count) * peaks.length);
    const to = Math.max(from + 1, Math.floor(((i + 1) / count) * peaks.length));
    let max = 0;
    for (let j = from; j < to; j++) max = Math.max(max, peaks[j]);
    out.push(max);
  }
  return out;
}

let toastTimer;
export function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('is-shown');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-shown'), 2200);
}

export function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(`ym:${key}`));
    localStorage.setItem(`ym:${key}`, JSON.stringify(value));
  } catch { /* хранилище недоступно */ }
  return null;
}
