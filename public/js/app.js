'use strict';
(() => {
  const cfg = window.SUP_CFG || {};
  // ссылка из письма «сброс пароля» приходит с #...type=recovery — запоминаем до того, как Supabase заберёт токен
  const AUTH_HASH = new URLSearchParams(location.hash.replace(/^#/, ''));
  const sb = cfg.url && cfg.key && window.supabase ? window.supabase.createClient(cfg.url, cfg.key) : null;

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = s => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const pubUrl = (bucket, path) => path ? sb.storage.from(bucket).getPublicUrl(path).data.publicUrl : '';
  const shuffleArr = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const ic = n => `<svg class="i"><use href="#i-${n}"/></svg>`;
  const hue = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const grad = s => { const h = hue(s); return `linear-gradient(135deg,hsl(${h} 70% 56%),hsl(${(h + 50) % 360} 70% 32%))`; };
  // обложка: картинка или градиент с буквой
  const cover = (t, key) => t && t.cover_path
    ? `<img loading="lazy" alt="" src="${esc(pubUrl('covers', t.cover_path))}">`
    : `<div class="ph" style="background:${grad(key ?? t?.title ?? '?')}">${esc((t?.title || key || '♪').trim().charAt(0))}</div>`;

  let toastT;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2600);
  }

  // ---------- состояние ----------
  const S = { user: null, profile: null, likes: new Set(), playlists: [], queue: [], qi: -1, shuffle: false, repeat: 0 };
  const audio = new Audio(); audio.preload = 'metadata'; audio.volume = 0.8;

  // ---------- данные ----------
  const COLS = 'id,owner,title,artist,album,genre,duration,audio_path,cover_path,plays,status,error,created_at';
  const AI_ALBUM = 'Сгенерировано нейросетью';
  async function getTracks({ q, owner, genre, all, order = 'created_at', limit = 100 } = {}) {
    let r = sb.from('sup_tracks').select(COLS).order(order, { ascending: false }).limit(limit);
    if (!owner && !all) r = r.eq('status', 'ready');
    if (q) { const p = `%${q.replace(/[%,()]/g, ' ')}%`; r = r.or(`title.ilike.${p},artist.ilike.${p}`); }
    if (owner) r = r.eq('owner', owner);
    if (genre) r = r.eq('genre', genre);
    const { data, error } = await r;
    if (error) throw error;
    return data || [];
  }
  async function loadUserData() {
    S.likes = new Set(); S.playlists = []; S.profile = null; S.admin = false;
    if (!S.user) return;
    sb.rpc('is_admin').then(({ data }) => { S.admin = !!data; }, () => {});
    const [l, p, pr] = await Promise.all([
      sb.from('sup_likes').select('track_id').eq('user_id', S.user.id),
      sb.from('sup_playlists').select('*').eq('owner', S.user.id).order('created_at'),
      sb.from('sup_profiles').select('*').eq('id', S.user.id).maybeSingle(),
    ]);
    S.likes = new Set((l.data || []).map(x => x.track_id));
    S.playlists = p.data || [];
    S.profile = pr.data;
    if (!S.profile) { // аккаунт старше таблиц supMUSIC: создаём профиль сами
      const name = S.user.user_metadata?.name || (S.user.email || 'user').split('@')[0];
      const { data } = await sb.from('sup_profiles').upsert({ id: S.user.id, name }).select().maybeSingle();
      S.profile = data || { id: S.user.id, name };
    }
  }
  async function toggleLike(id) {
    if (!S.user) return openAuth();
    if (S.likes.has(id)) { S.likes.delete(id); sb.from('sup_likes').delete().eq('user_id', S.user.id).eq('track_id', id).then(() => {}); }
    else { S.likes.add(id); sb.from('sup_likes').insert({ user_id: S.user.id, track_id: id }).then(() => {}); }
    syncLikes();
  }
  function syncLikes() {
    $$('[data-like]').forEach(b => setLikeBtn(b, S.likes.has(b.dataset.like)));
    const cur = S.queue[S.qi];
    $$('.js-like').forEach(b => setLikeBtn(b, !!cur && S.likes.has(cur.id)));
  }
  function setLikeBtn(b, on) { b.innerHTML = ic(on ? 'heart-on' : 'heart'); b.classList.toggle('on', on); }

  // ---------- плеер ----------
  function setQueue(list, idx) { S.queue = list.slice(); S.qi = idx; playCurrent(); }
  function playCurrent() {
    const t = S.queue[S.qi]; if (!t) return;
    audio.src = pubUrl('audio', t.audio_path);
    audio.play().catch(() => toast('Не удалось воспроизвести'));
    renderPlayer(); markNow(); loadLyrics(t);
    sb.rpc('sup_inc_plays', { track: t.id }).then(() => {}, () => {});
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, artwork: t.cover_path ? [{ src: pubUrl('covers', t.cover_path) }] : [] });
    }
  }
  function renderPlayer() {
    const t = S.queue[S.qi];
    if (t) {
      $$('.js-title').forEach(e => e.textContent = t.title);
      $$('.js-artist').forEach(e => e.textContent = t.artist);
      $$('.js-cover').forEach(e => e.innerHTML = cover(t));
      $$('.js-bg').forEach(e => e.style.background = grad(t.title));
      const src = /^Jamendo #(\d+)/.exec(t.album || '');
      $$('.js-src').forEach(e => { e.hidden = !src; if (src) { e.href = `https://www.jamendo.com/track/${src[1]}`; e.textContent = `${t.album.replace(/#\d+ /, '')} ↗`; } });
      document.title = `${t.title} — supMUSIC`;
    }
    $$('.js-shuffle').forEach(b => b.classList.toggle('on', S.shuffle));
    $$('.js-repeat').forEach(b => { b.classList.toggle('on', S.repeat > 0); b.innerHTML = ic('repeat'); b.title = ['Повтор выключен', 'Повторять всё', 'Повторять трек'][S.repeat]; b.style.opacity = S.repeat === 2 ? '1' : ''; b.dataset.one = S.repeat === 2 ? '1' : ''; });
    renderPlayState(); syncLikes();
  }
  function renderPlayState() {
    const playing = !audio.paused && !!audio.src;
    document.body.classList.toggle('playing', playing);
    $$('.js-play').forEach(b => b.innerHTML = ic(playing ? 'pause' : 'play'));
  }
  function markNow() {
    const cur = S.queue[S.qi];
    $$('.row').forEach(r => r.classList.toggle('now', !!cur && r.dataset.id === cur.id));
  }
  function next(auto) {
    if (!S.queue.length) return;
    if (auto && S.repeat === 2) { audio.currentTime = 0; audio.play(); return; }
    let i = S.shuffle && S.queue.length > 1 ? (() => { let j; do { j = Math.random() * S.queue.length | 0; } while (j === S.qi); return j; })() : S.qi + 1;
    if (i >= S.queue.length) { if (S.repeat === 1 || !auto) i = 0; else { audio.pause(); return; } }
    S.qi = i; playCurrent();
  }
  function prev() {
    if (audio.currentTime > 3 || S.qi <= 0) { audio.currentTime = 0; return; }
    S.qi--; playCurrent();
  }
  function togglePlay() {
    if (!S.queue.length) { toast('Выбери трек или включи «Мою волну»'); return; }
    audio.paused ? audio.play() : audio.pause();
  }
  const ACT = {
    play: togglePlay, next: () => next(false), prev,
    like: () => { const t = S.queue[S.qi]; if (t) toggleLike(t.id); },
    shuffle: () => { S.shuffle = !S.shuffle; renderPlayer(); },
    repeat: () => { S.repeat = (S.repeat + 1) % 3; renderPlayer(); },
  };
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (b) { e.stopPropagation(); ACT[b.dataset.act]?.(); }
  });
  audio.addEventListener('play', renderPlayState);
  audio.addEventListener('pause', renderPlayState);
  audio.addEventListener('ended', () => next(true));
  let seeking = false;
  audio.addEventListener('timeupdate', () => {
    if (!audio.duration) return;
    const p = audio.currentTime / audio.duration;
    $$('.js-cur').forEach(e => e.textContent = fmt(audio.currentTime));
    $$('.js-dur').forEach(e => e.textContent = fmt(audio.duration));
    $('#pLine').style.width = p * 100 + '%';
    syncLyrics();
    if (!seeking) $$('.js-seek').forEach(s => { s.value = p * 1000; paintRange(s); });
  });
  function paintRange(r) { const v = (r.value - r.min) / (r.max - r.min) * 100; r.style.background = `linear-gradient(90deg,var(--accent) ${v}%,var(--s3) ${v}%)`; }
  $$('.js-seek').forEach(s => {
    s.addEventListener('input', () => { seeking = true; paintRange(s); });
    s.addEventListener('change', () => { if (audio.duration) audio.currentTime = s.value / 1000 * audio.duration; seeking = false; });
    paintRange(s);
  });
  const vol = $('#pVol'); paintRange(vol);
  vol.addEventListener('input', e => { audio.volume = e.target.value / 100; paintRange(vol); });
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => audio.play());
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('nexttrack', () => next(false));
    navigator.mediaSession.setActionHandler('previoustrack', prev);
  }
  document.addEventListener('keydown', e => {
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.code === 'Escape') $('#full').hidden = true;
  });
  $('.js-open').onclick = () => { if (S.queue.length) $('#full').hidden = false; };
  $('#fullClose').onclick = () => $('#full').hidden = true;

  // ---------- текст песни (как в Яндекс Музыке) ----------
  const lyricsCache = new Map();
  const LY = { id: null, lines: [], synced: false, cur: -2, card: localStorage.getItem('supLyCard') !== '0' };
  const DOTS = '<span class="dots4"><i></i><i></i><i></i><i></i></span>';

  // LRC: «[01:23.45] строка». Пустая строка с таймкодом — проигрыш (точки).
  // Без таймкодов текст показывается целиком, без подсветки
  function parseLyrics(raw) {
    raw = (raw || '').trim();
    if (!raw) return { lines: [], synced: false };
    const lines = [];
    for (const row of raw.split(/\r?\n/)) {
      const text = row.replace(/\[[^\]]*\]/g, '').trim().replace(/^♪$/, '');
      for (const m of row.matchAll(/\[(\d{1,2}):(\d{2}(?:[.:]\d{1,3})?)\]/g)) lines.push({ t: +m[1] * 60 + parseFloat(m[2].replace(':', '.')), text });
    }
    if (lines.length) {
      lines.sort((a, b) => a.t - b.t);
      if (lines[0].t > 4) lines.unshift({ t: 0, text: '' }); // вступление — точки
      return { lines: lines.filter((l, i) => l.text || lines[i - 1]?.text !== ''), synced: true };
    }
    return { lines: raw.split(/\r?\n/).map(text => ({ t: 0, text: text.trim() })), synced: false };
  }

  async function loadLyrics(t) {
    LY.id = t.id; LY.lines = []; LY.synced = false; LY.cur = -2;
    drawLyrics('<div class="ly-note">Загружаю текст…</div>');
    renderLyMode();
    let raw = lyricsCache.get(t.id);
    if (raw === undefined) {
      const { data } = await sb.from('sup_tracks').select('lyrics').eq('id', t.id).maybeSingle();
      raw = data?.lyrics || '';
      lyricsCache.set(t.id, raw);
    }
    if (LY.id !== t.id) return; // за это время включили другой трек
    Object.assign(LY, parseLyrics(raw), { cur: -2 });
    $('#full').classList.toggle('no-ly', !LY.lines.length);
    renderLyMode();
    if (!LY.lines.length) return drawLyrics('<div class="ly-note">Текста для этого трека пока нет</div>');
    drawLyrics(LY.lines.map((l, i) => l.text
      ? `<p class="ly ${LY.synced ? '' : 'plain'}" data-i="${i}">${esc(l.text)}</p>`
      : `<div class="ly gap" data-i="${i}">${DOTS}</div>`).join(''));
    $$('#lyrics .ly').forEach(p => p.onclick = () => { if (LY.synced) { audio.currentTime = LY.lines[+p.dataset.i].t; lyTouched = 0; audio.play(); } });
    if (!LY.synced) $('#lyCardT').innerHTML = LY.lines.map(l => `<p>${esc(l.text) || '&nbsp;'}</p>`).join('');
    syncLyrics(true);
  }
  let lyTouched = 0;
  ['wheel', 'touchmove'].forEach(ev => $('#lyrics').addEventListener(ev, () => { lyTouched = Date.now(); }, { passive: true }));
  function drawLyrics(html) { const box = $('#lyrics'); box.innerHTML = html; box.scrollTop = 0; }

  // Режимы на телефоне: обложка → карточка с текстом (кнопка «Текст») → текст на весь экран (карточка или ↗)
  function renderLyMode() {
    const full = $('#full'), has = LY.lines.length > 0;
    if (!has) full.classList.remove('show-ly');
    const card = LY.card && has && !full.classList.contains('show-ly');
    $('#lyCard').hidden = !card;
    $('#lyCardT').classList.toggle('plain', !LY.synced);
    full.classList.toggle('ly-on', card);
    $('#lyBtn').disabled = !has;
    $('#lyBtn').classList.toggle('on', has && (LY.card || full.classList.contains('show-ly')));
  }
  $('#lyBtn').onclick = () => {
    const full = $('#full');
    if (full.classList.contains('show-ly')) full.classList.remove('show-ly');
    else { LY.card = !LY.card; localStorage.setItem('supLyCard', LY.card ? '1' : '0'); }
    renderLyMode(); syncLyrics(true);
  };
  const openLyFull = () => { $('#full').classList.add('show-ly'); renderLyMode(); lyTouched = 0; syncLyrics(true); };
  $('#lyCard').onclick = openLyFull;
  $('#lyExp').onclick = e => { e.stopPropagation(); openLyFull(); };

  // какая доля проигрыша прошла: точки загораются по одной
  const gapPart = (i, now) => {
    const end = LY.lines[i + 1]?.t ?? (audio.duration || LY.lines[i].t + 8);
    return Math.max(0, Math.min(1, (now - LY.lines[i].t) / Math.max(1, end - LY.lines[i].t)));
  };
  const paintDots = (root, k) => { if (root) $$('.dots4 i', root).forEach((d, n) => d.classList.toggle('on', k >= (n + 1) / 5)); };

  function syncLyrics(force) {
    if (!LY.synced || !LY.lines.length) return;
    const now = audio.currentTime + 0.25; // подсветка чуть раньше, чтобы глаз успевал
    let idx = -1;
    for (let i = 0; i < LY.lines.length && LY.lines[i].t <= now; i++) idx = i;
    const gap = idx < 0 || !LY.lines[idx].text;
    const box = $('#lyrics'), cardT = $('#lyCardT');
    if (idx !== LY.cur || force) {
      LY.cur = idx;
      $$('.ly', box).forEach((p, i) => {
        p.dataset.d = i >= idx ? Math.min(i - idx, 4) : '';
        p.classList.toggle('cur', i === idx);
        p.classList.toggle('past', i < idx);
      });
      // карточка: текущая строка и две следующие
      if (gap) cardT.innerHTML = DOTS;
      else cardT.innerHTML = [idx, idx + 1, idx + 2].map(i => LY.lines[i])
        .filter((l, n) => l && (n === 0 || l.text))
        .map((l, n) => `<p class="${n ? '' : 'now'}">${esc(l.text)}</p>`).join('');
      const el = box.querySelector(`.ly[data-i="${Math.max(idx, 0)}"]`);
      // пока человек сам листает текст, не дёргаем его обратно
      if (el && Date.now() - lyTouched > 3500) box.scrollTo({ top: el.offsetTop - box.clientHeight * 0.35, behavior: force ? 'auto' : 'smooth' });
    }
    if (gap) {
      const k = idx < 0 ? 0 : gapPart(idx, now);
      paintDots(cardT, k);
      if (idx >= 0) paintDots(box.querySelector(`.ly[data-i="${idx}"]`), k);
    }
  }

  // ---------- скачать, поделиться, «Моя волна по треку» ----------
  async function download() {
    const t = S.queue[S.qi]; if (!t) return;
    const url = pubUrl('audio', t.audio_path);
    const name = `${t.artist} - ${t.title}.mp3`.replace(/[\\/:*?"<>|]/g, '_');
    // в приложении для Android файл качает сам телефон — в «Загрузки»
    if (window.YouMusicApp) return window.YouMusicApp.download(url, name);
    toast('Скачиваю…');
    try {
      const blob = await (await fetch(url)).blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch { toast('Не удалось скачать'); }
  }
  $('#dlBtn').onclick = download;
  $('#dlBtn2').onclick = download;
  $('#shareBtn').onclick = async () => {
    const t = S.queue[S.qi]; if (!t) return;
    const url = `${location.origin}${location.pathname}#/track/${t.id}`;
    try {
      if (navigator.share) await navigator.share({ title: t.title, text: `${t.artist} — ${t.title}`, url });
      else { await navigator.clipboard.writeText(url); toast('Ссылка скопирована'); }
    } catch { /* окно «Поделиться» закрыли */ }
  };
  // волна по треку: сначала этот же исполнитель, потом весь каталог вперемешку
  $('#waveBy').onclick = async () => {
    const t = S.queue[S.qi]; if (!t) return;
    const pool = await getTracks({ limit: 200 });
    const same = shuffleArr(pool.filter(x => x.artist === t.artist && x.id !== t.id));
    const rest = shuffleArr(pool.filter(x => x.artist !== t.artist));
    S.queue = [t, ...same, ...rest]; S.qi = 0; S.shuffle = false; renderPlayer();
    toast('Моя волна по треку «' + t.title + '»');
  };

  // ---------- списки ----------
  const STATUS = { pending: 'На проверке нейросетью…', processing: 'Проверяется нейросетью…', failed: 'Ошибка обработки' };
  function rowHtml(t, i, opts = {}) {
    const mine = S.user && (t.owner === S.user.id || S.admin);
    const on = S.likes.has(t.id);
    const ready = t.status === 'ready' || !t.status;
    const sub = ready ? esc(t.artist) + (t.genre ? ' · ' + esc(t.genre) : '') + (t.album === AI_ALBUM ? ' <em class="ai">ИИ</em>' : '')
      : `<em class="st st-${t.status}">${STATUS[t.status] || ''}${t.status === 'failed' && t.error ? ' — ' + esc(t.error) : ''}</em>`;
    return `<div class="row ${ready ? '' : 'wait'}" data-id="${t.id}" data-i="${i}">
      <div class="cv" data-play>${cover(t)}<div class="go">${ic('play')}</div><div class="eq"><u></u><u></u><u></u></div></div>
      <div class="info" data-play><div class="t">${esc(t.title)}</div><div class="a">${sub}</div></div>
      <button class="ib ${on ? 'on' : ''}" data-like="${t.id}" aria-label="Нравится">${ic(on ? 'heart-on' : 'heart')}</button>
      <button class="ib add" data-add="${t.id}" aria-label="В плейлист">${ic('plus')}</button>
      <span class="d">${fmt(t.duration)}</span>
      ${opts.remove ? `<button class="ib" data-remove="${t.id}" aria-label="Убрать из плейлиста">${ic('x')}</button>`
        : mine ? `<button class="ib" data-del="${t.id}" aria-label="Удалить трек">${ic('trash')}</button>` : '<span></span>'}
    </div>`;
  }
  const listHtml = (tracks, opts) => tracks.length ? `<div class="list">${tracks.map((t, i) => rowHtml(t, i, opts)).join('')}</div>` : '<div class="empty">Здесь пока пусто</div>';
  function bindList(root, tracks, opts = {}) {
    $$('.row', root).forEach(r => {
      const i = +r.dataset.i, t = tracks[i];
      const playable = !t.status || t.status === 'ready';
      const ready = tracks.filter(x => !x.status || x.status === 'ready');
      $$('[data-play]', r).forEach(el => el.onclick = () => playable ? setQueue(ready, ready.indexOf(t)) : toast('Трек ещё проверяется нейросетью'));
      $('[data-like]', r).onclick = () => toggleLike(t.id);
      $('[data-add]', r).onclick = () => addToPlaylist(t);
      const del = $('[data-del]', r);
      if (del) del.onclick = async () => {
        if (!confirm(`Удалить «${t.title}»?`)) return;
        if (t.audio_path) await sb.storage.from('audio').remove([t.audio_path]);
        if (t.cover_path) await sb.storage.from('covers').remove([t.cover_path]);
        const { error } = await sb.from('sup_tracks').delete().eq('id', t.id);
        if (error) return toast(error.message);
        toast('Трек удалён'); route();
      };
      const rm = $('[data-remove]', r);
      if (rm) rm.onclick = () => opts.remove(t);
    });
    markNow();
  }
  function shelfHtml(tracks) {
    return `<div class="shelf">${tracks.map((t, i) => `<div class="card" data-i="${i}"><div class="cv">${cover(t)}<span class="go">${ic('play')}</span></div><b>${esc(t.title)}</b><span>${esc(t.artist)}</span></div>`).join('')}</div>`;
  }
  function bindShelf(root, tracks) { $$('.card', root).forEach(c => c.onclick = () => setQueue(tracks, +c.dataset.i)); }

  // ---------- окна ----------
  function modal(html) {
    const m = $('#modal'); m.innerHTML = `<div class="box">${html}</div>`; m.hidden = false;
    m.onclick = e => { if (e.target === m) closeModal(); };
    return m;
  }
  function closeModal() { $('#modal').hidden = true; $('#modal').innerHTML = ''; }

  function openAuth(mode = 'in') {
    const up = mode === 'up';
    const m = modal(`<h2>${up ? 'Регистрация' : 'Вход'}</h2>
      ${up ? '<input id="aName" placeholder="Имя" autocomplete="nickname">' : ''}
      <input id="aEmail" type="email" placeholder="Почта" autocomplete="email">
      <input id="aPass" type="password" placeholder="Пароль (от 6 символов)" autocomplete="${up ? 'new-password' : 'current-password'}">
      <div class="err" id="aErr"></div>
      <button class="btn" id="aGo">${up ? 'Создать аккаунт' : 'Войти'}</button>
      <button class="btn ghost" id="aSwitch">${up ? 'Уже есть аккаунт' : 'Нет аккаунта? Регистрация'}</button>
      ${up ? '' : '<button class="link" id="aForgot">Забыли пароль?</button>'}`);
    $('#aSwitch', m).onclick = () => openAuth(up ? 'in' : 'up');
    if (!up) $('#aForgot', m).onclick = () => openReset($('#aEmail', m).value.trim());
    $('#aGo', m).onclick = async () => {
      const email = $('#aEmail', m).value.trim(), password = $('#aPass', m).value, err = $('#aErr', m);
      err.textContent = '';
      const r = up
        ? await sb.auth.signUp({ email, password, options: { data: { name: $('#aName', m).value.trim() || email.split('@')[0] } } })
        : await sb.auth.signInWithPassword({ email, password });
      if (r.error) { err.style.color = ''; err.textContent = AUTH_ERR[r.error.message] || r.error.message; return; }
      if (up && !r.data.session) { err.style.color = 'var(--accent)'; err.textContent = 'Проверь почту: мы отправили письмо для подтверждения.'; return; }
      closeModal(); toast('Добро пожаловать!');
    };
  }

  function addToPlaylist(t) {
    if (!S.user) return openAuth();
    const m = modal(`<h2>В плейлист</h2>
      ${S.playlists.map(p => `<button class="pl-item" data-pl="${p.id}">${esc(p.title)}</button>`).join('')}
      <input id="plNew" placeholder="Новый плейлист">
      <button class="btn" id="plCreate">Создать и добавить</button>`);
    const put = async id => {
      const { count } = await sb.from('sup_playlist_tracks').select('*', { count: 'exact', head: true }).eq('playlist_id', id);
      const { error } = await sb.from('sup_playlist_tracks').insert({ playlist_id: id, track_id: t.id, position: count || 0 });
      closeModal(); toast(error ? (error.code === '23505' ? 'Уже в плейлисте' : error.message) : 'Добавлено');
    };
    $$('[data-pl]', m).forEach(b => b.onclick = () => put(b.dataset.pl));
    $('#plCreate', m).onclick = async () => {
      const title = $('#plNew', m).value.trim(); if (!title) return;
      const { data, error } = await sb.from('sup_playlists').insert({ title }).select().single();
      if (error) return toast(error.message);
      S.playlists.push(data); put(data.id);
    };
  }

  // ---------- страницы ----------
  const view = $('#view');
  const GENRES = ['Поп', 'Рок', 'Рэп', 'Электроника', 'Джаз', 'Классика', 'Инди', 'Другое'];
  const greeting = () => { const h = new Date().getHours(); return h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер'; };
  const needAuth = (title, text) => { view.innerHTML = `<h1>${title}</h1><div class="empty">${text}</div><button class="btn" id="goIn">Войти</button>`; $('#goIn').onclick = () => openAuth(); };

  async function pageHome() {
    view.innerHTML = '<div class="empty">Загрузка…</div>';
    const [fresh, top] = await Promise.all([getTracks({ limit: 30 }), getTracks({ order: 'plays', limit: 12 })]);
    view.innerHTML = `<h1 class="hello">${greeting()}${S.profile?.name ? ', ' + esc(S.profile.name) : ''}</h1>${appBanner()}
      <div class="wave"><i></i><i></i><i></i><h1>Моя волна</h1><p>Бесконечная музыка из всего каталога</p><button class="play" id="waveBtn" aria-label="Включить">${ic('play')}</button></div>
      ${top.length ? `<h2>Популярное</h2><div id="top">${shelfHtml(top)}</div>` : ''}
      ${fresh.length ? `<h2>Новое</h2><div id="fresh">${shelfHtml(fresh)}</div><h2>Все треки</h2><div id="all">${listHtml(fresh)}</div>`
        : '<div class="empty">В каталоге пока нет треков. Загрузи первый — вкладка «Загрузить».</div>'}`;
    $('#waveBtn').onclick = async () => {
      const pool = shuffleArr(await getTracks({ limit: 200 }));
      if (!pool.length) return toast('Каталог пока пуст');
      S.shuffle = true; setQueue(pool, 0);
    };
    bindAppBanner();
    if (top.length) bindShelf($('#top'), top);
    if (fresh.length) { bindShelf($('#fresh'), fresh); bindList($('#all'), fresh); }
  }

  async function pageSearch() {
    view.innerHTML = `<h1>Поиск</h1><div class="search">${ic('search')}<input id="q" placeholder="Трек или исполнитель" autocomplete="off">
      <button class="ib mic" id="mic" aria-label="Голосовой поиск">${ic('mic')}</button></div>
      <div class="chips">${GENRES.map(g => `<button class="chip" data-g="${g}">${g}</button>`).join('')}</div><div id="res"></div><div id="open"></div>`;
    $('#mic').onclick = () => voiceSearch(text => { $('#q').value = text; run(); });
    let t, genre = '', n = 0;
    const run = async () => {
      const q = $('#q').value.trim(), res = $('#res'), my = ++n;
      if (!q && !genre) { res.innerHTML = '<div class="empty">Начни вводить название или выбери жанр</div>'; return; }
      const tracks = await getTracks({ q, genre });
      if (my !== n) return;
      res.innerHTML = tracks.length || !q ? listHtml(tracks) : `<div class="empty">На сайте по запросу «${esc(q)}» ничего нет — поищем в каталоге ↓</div>`;
      bindList(res, tracks);
      openSearch(q);
    };
    $('#q').oninput = () => { clearTimeout(t); t = setTimeout(run, 250); };
    $$('[data-g]', view).forEach(b => b.onclick = () => {
      genre = genre === b.dataset.g ? '' : b.dataset.g;
      $$('[data-g]', view).forEach(x => x.classList.toggle('on', x.dataset.g === genre));
      run();
    });
    const preset = decodeURIComponent((location.hash.split('?q=')[1] || ''));
    if (preset) $('#q').value = preset;
    run();
  }

  async function pageCollection() {
    if (!S.user) return needAuth('Коллекция', 'Войди, чтобы лайкать треки и собирать плейлисты.');
    view.innerHTML = '<div class="empty">Загрузка…</div>';
    const ids = [...S.likes];
    const liked = ids.length ? (await sb.from('sup_tracks').select(COLS).eq('status', 'ready').in('id', ids)).data || [] : [];
    const mine = await getTracks({ owner: S.user.id });
    view.innerHTML = `<h1>Коллекция</h1>
      <h2 style="margin-top:6px">Плейлисты</h2><div class="grid">
        ${S.playlists.map(p => `<div class="card" data-pl="${p.id}"><div class="cv"><div class="ph" style="background:${grad(p.title)}">${esc(p.title.charAt(0))}</div></div><b>${esc(p.title)}</b><span>Плейлист</span></div>`).join('')}
        <div class="card" id="newPl"><div class="cv"><div class="ph" style="background:var(--s2);color:var(--accent)">${ic('plus')}</div></div><b>Новый плейлист</b><span>&nbsp;</span></div></div>
      <h2>Мне нравится</h2><div id="liked"></div><h2>Мои загрузки</h2><div id="mine"></div>${S.admin ? '<h2>Все треки (админ)</h2><div id="allAdm"></div>' : ''}`;
    $('#liked').innerHTML = listHtml(liked); bindList($('#liked'), liked);
    $('#mine').innerHTML = listHtml(mine); bindList($('#mine'), mine);
    if (S.admin) { const all = await getTracks({ all: true, limit: 300 }); $('#allAdm').innerHTML = listHtml(all); bindList($('#allAdm'), all); }
    $$('[data-pl]', view).forEach(c => c.onclick = () => location.hash = `#/playlist/${c.dataset.pl}`);
    $('#newPl').onclick = async () => {
      const title = prompt('Название плейлиста'); if (!title || !title.trim()) return;
      const { data, error } = await sb.from('sup_playlists').insert({ title: title.trim() }).select().single();
      if (error) return toast(error.message);
      S.playlists.push(data); location.hash = `#/playlist/${data.id}`;
    };
  }

  async function pagePlaylist(id) {
    const pl = S.playlists.find(p => p.id === id) || (await sb.from('sup_playlists').select('*').eq('id', id).maybeSingle()).data;
    if (!pl) { view.innerHTML = '<div class="empty">Плейлист не найден</div>'; return; }
    const { data } = await sb.from('sup_playlist_tracks').select('position, sup_tracks(' + COLS + ')').eq('playlist_id', id).order('position');
    const tracks = (data || []).map(x => x.sup_tracks).filter(Boolean);
    view.innerHTML = `<div class="pl-head"><div class="cv"><div class="ph" style="background:${grad(pl.title)}">${esc(pl.title.charAt(0))}</div></div>
      <div><h1>${esc(pl.title)}</h1><div class="acts"><button class="btn" id="plPlay">${ic('play')} Играть</button><button class="btn ghost" id="plDel">Удалить</button></div></div></div><div id="pt"></div>`;
    const box = $('#pt');
    box.innerHTML = listHtml(tracks, { remove: true });
    bindList(box, tracks, { remove: async t => {
      await sb.from('sup_playlist_tracks').delete().eq('playlist_id', id).eq('track_id', t.id); pagePlaylist(id);
    } });
    $('#plPlay').onclick = () => tracks.length && setQueue(tracks, 0);
    $('#plDel').onclick = async () => {
      if (!confirm('Удалить плейлист?')) return;
      await sb.from('sup_playlists').delete().eq('id', id);
      S.playlists = S.playlists.filter(p => p.id !== id); location.hash = '#/collection';
    };
  }

  function pageUpload() {
    if (!S.user) return needAuth('Загрузить трек', 'Чтобы загружать музыку, нужно войти.');
    view.innerHTML = `<h1>Загрузить трек</h1><div class="form">
      <label>Аудиофайл (mp3, m4a, ogg, wav · до 50 МБ)<input type="file" id="uFile" accept="audio/*"></label>
      <label>Название<input id="uTitle"></label>
      <label>Исполнитель<input id="uArtist" value="${esc(S.profile?.name || '')}"></label>
      <label>Жанр<select id="uGenre">${GENRES.map(g => `<option>${g}</option>`).join('')}</select></label>
      <label>Обложка (необязательно)<input type="file" id="uCover" accept="image/*"></label>
      <label>Текст песни (необязательно: если не вставить, найдём сами или распознаем нейросетью)<textarea id="uLyrics" maxlength="20000" placeholder="Можно с таймкодами: [00:12.50] первая строка"></textarea></label>
      <div class="err" id="uErr"></div>
      <button class="btn" id="uGo">Отправить на проверку</button>
      <div class="sub" style="margin:0;font-size:13px">Перед публикацией нейросеть вырезает из трека мат, наркотики и суицид, на их месте остаётся бит. Это занимает 10–30 минут. Загружай только то, на что у тебя есть права.</div></div>`;
    $('#uFile').onchange = e => {
      const f = e.target.files[0]; if (f && !$('#uTitle').value) $('#uTitle').value = f.name.replace(/\.[^.]+$/, '');
    };
    $('#uGo').onclick = async () => {
      const f = $('#uFile').files[0], c = $('#uCover').files[0], err = $('#uErr'), btn = $('#uGo');
      const title = $('#uTitle').value.trim(), artist = $('#uArtist').value.trim();
      err.textContent = '';
      if (!f) return err.textContent = 'Выбери аудиофайл';
      if (!title || !artist) return err.textContent = 'Укажи название и исполнителя';
      if (f.size > 50 * 1024 * 1024) return err.textContent = 'Файл больше 50 МБ';
      btn.disabled = true; btn.textContent = 'Загрузка…';
      try {
        const duration = await new Promise(res => {
          const a = new Audio(), u = URL.createObjectURL(f);
          a.onloadedmetadata = () => { res(Math.round(a.duration) || 0); URL.revokeObjectURL(u); };
          a.onerror = () => res(0); a.src = u;
        });
        // оригинал уходит в приватную очередь: нейросеть вырежет мат и наркотики, и только потом трек опубликуется
        const id = crypto.randomUUID();
        const extOf = (file, d) => (file.name.split('.').pop() || d).toLowerCase().replace(/[^a-z0-9]/g, '') || d;
        const sourcePath = `${S.user.id}/${id}.${extOf(f, 'mp3')}`;
        let r = await sb.storage.from('sup-incoming').upload(sourcePath, f, { contentType: f.type || 'audio/mpeg' });
        if (r.error) throw r.error;
        let coverSource = null;
        if (c) {
          coverSource = `${S.user.id}/${id}-cover.${extOf(c, 'jpg')}`;
          r = await sb.storage.from('sup-incoming').upload(coverSource, c, { contentType: c.type });
          if (r.error) throw r.error;
        }
        r = await sb.from('sup_tracks').insert({ id, title, artist, genre: $('#uGenre').value, duration, source_path: sourcePath, cover_source: coverSource, lyrics: $('#uLyrics').value.trim() || null });
        if (r.error) throw r.error;
        toast('Трек принят: после проверки нейросетью он появится на сайте'); location.hash = '#/collection';
      } catch (e) { err.textContent = e.message || String(e); btn.disabled = false; btn.textContent = 'Отправить на проверку'; }
    };
  }

  // ---------- генератор песен (ACE-Step) ----------
  // подписи на русском, а модели уходят английские теги: так она лучше понимает стиль
  const G_GENRES = [['Поп', 'pop'], ['Рэп', 'hip-hop, rap'], ['Рок', 'rock, electric guitar'], ['Электроника', 'electronic, synth'], ['Лоу-фай', 'lo-fi, chill'], ['R&B', 'r&b, soul'], ['Инди', 'indie'], ['Танцевальная', 'dance, edm']];
  const G_MOODS = [['Весёлая', 'happy, upbeat'], ['Грустная', 'sad, melancholic'], ['Энергичная', 'energetic'], ['Спокойная', 'calm, relaxing']];
  const G_VOICES = [['Мужской вокал', 'male vocal'], ['Женский вокал', 'female vocal']];
  const G_LENGTHS = [['30 с', '30'], ['1 мин', '60'], ['2 мин', '120'], ['3 мин', '180']];
  const G_EXAMPLE = '[Verse]\nНочной город гасит окна\nМы летим по пустым дворам\nФонари считают метры\nОт тебя и до меня\n\n[Chorus]\nНе отпускай, пока играет бас\nЭта ночь только для нас';
  const chips = (group, items, multi, def = 0) => `<div class="chips" data-group="${group}" data-multi="${multi ? 1 : 0}">${items.map(([l, v], i) => `<button type="button" class="chip ${!multi && i === def ? 'on' : ''}" data-value="${esc(v)}">${esc(l)}</button>`).join('')}</div>`;

  function pageCreate() {
    if (!S.user) return needAuth('Создать песню', 'Войди, чтобы нейросеть написала для тебя песню.');
    view.innerHTML = `<h1>Создать песню</h1><p class="sub">Нейросеть ACE-Step сочинит музыку и споёт твой текст. Бесплатно.</p>
      <form class="form" id="gForm">
        <label>Название<input name="title" maxlength="200" required placeholder="Ночной город"></label>
        <label>Исполнитель<input name="artist" maxlength="200" required value="${esc(S.profile?.name || '')}"></label>
        <div class="lb">Жанр${chips('genre', G_GENRES, true)}</div>
        <div class="lb">Настроение${chips('mood', G_MOODS, true)}</div>
        <div class="lb">Голос${chips('voice', G_VOICES, false)}</div>
        <div class="lb">Язык${chips('language', [['Русский', 'ru'], ['English', 'en']], false)}</div>
        <div class="lb">Длина${chips('duration', G_LENGTHS, false, 1)}</div>
        <label>Своё описание стиля (необязательно)<input name="caption" maxlength="300" placeholder="синтезаторы, 100 bpm, ночное настроение"></label>
        <label class="check"><input type="checkbox" name="instrumental"> Без слов (только музыка)</label>
        <div class="lb" id="gLyrics">Текст песни <button type="button" class="chip sm" id="gExample">Вставить пример</button>
          <textarea name="lyrics" maxlength="4000" placeholder="[Verse]&#10;Первый куплет…&#10;&#10;[Chorus]&#10;Припев…"></textarea></div>
        <div class="err" id="gErr"></div>
        <button class="btn" id="gGo">Сгенерировать песню</button>
        <div class="sub" style="margin:0;font-size:13px">Запрещённые слова вырезаются из текста до генерации, а готовую песню ещё раз проверяет нейросеть (Demucs + Whisper). Песня появится в «Коллекции» через 10–30 минут.</div>
      </form>`;
    const form = $('#gForm');
    form.addEventListener('click', e => {
      const chip = e.target.closest('[data-group] .chip');
      if (chip) {
        const g = chip.parentElement;
        if (g.dataset.multi === '1') chip.classList.toggle('on');
        else { $$('.chip', g).forEach(c => c.classList.remove('on')); chip.classList.add('on'); }
      }
    });
    $('#gExample').onclick = () => { form.lyrics.value = G_EXAMPLE; };
    form.instrumental.onchange = () => { $('#gLyrics').hidden = form.instrumental.checked; };
    const picked = g => $$(`[data-group="${g}"] .on`, form).map(c => c.dataset.value);
    form.onsubmit = async e => {
      e.preventDefault();
      const err = $('#gErr'), btn = $('#gGo'), instrumental = form.instrumental.checked, lyrics = form.lyrics.value.trim();
      err.textContent = '';
      if (!instrumental && !lyrics) return err.textContent = 'Напиши текст или включи «Без слов»';
      btn.disabled = true; btn.textContent = 'Отправляю…';
      try {
        const id = crypto.randomUUID(), path = `${S.user.id}/${id}.gen`;
        const req = {
          caption: [...picked('genre'), ...picked('mood'), ...(instrumental ? ['instrumental'] : picked('voice')), form.caption.value.trim()].filter(Boolean).join(', ') || 'pop',
          lyrics: instrumental ? '' : lyrics, language: picked('language')[0] || 'ru', duration: +picked('duration')[0] || 60, instrumental,
        };
        let r = await sb.storage.from('sup-incoming').upload(path, new Blob([JSON.stringify(req)], { type: 'application/json' }), { contentType: 'application/json' });
        if (r.error) throw r.error;
        r = await sb.from('sup_tracks').insert({ id, title: form.title.value.trim(), artist: form.artist.value.trim(), source_path: path });
        if (r.error) throw r.error;
        toast('Заявка принята! Песня появится в «Коллекции»'); location.hash = '#/collection';
      } catch (ex) { err.textContent = ex.message || String(ex); btn.disabled = false; btn.textContent = 'Сгенерировать песню'; }
    };
  }

  // ---------- голосовой поиск ----------
  // в приложении для Android распознаёт речь сам телефон (голосовой ввод Google)
  let voiceDone = null;
  window.__ymVoice = text => { if (voiceDone) voiceDone(text); else location.hash = `#/search?q=${encodeURIComponent(text)}`; };
  function voiceSearch(done) {
    voiceDone = done;
    if (window.YouMusicApp) return window.YouMusicApp.voice();
    const R = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!R) return toast('Голосовой поиск не поддерживается этим браузером');
    const r = new R(); r.lang = 'ru-RU'; r.interimResults = false;
    r.onresult = e => done(e.results[0][0].transcript);
    r.onerror = e => { if (e.error !== 'aborted' && e.error !== 'no-speech') toast('Не расслышал, попробуй ещё раз'); };
    r.onend = () => $('#mic')?.classList.remove('on');
    $('#mic')?.classList.add('on'); toast('Говори…'); r.start();
  }

  // ---------- загрузка из каталога: поиск → «Загрузить» → модерация ----------
  // Openverse (музыка Jamendo под лицензиями Creative Commons, только с правом изменять — цензура меняет трек)
  const OV = 'https://api.openverse.org/v1/audio/';
  const OV_LIC = new Set(['by', 'by-sa', 'by-nc', 'by-nc-sa', 'cc0', 'pdm']);
  const ovCache = new Map();
  let openTimer, openN = 0, openItems = [], openPage = 1;
  const preview = new Audio(); preview.preload = 'none';

  async function ovFetch(url, tries = 2) {
    for (let i = 1; ; i++) {
      const c = new AbortController(), tm = setTimeout(() => c.abort(), 45000);
      try {
        const r = await fetch(url, { signal: c.signal });
        if (r.status < 500 || i >= tries) return r;
      } catch { if (i >= tries) throw new Error('Каталог не отвечает — попробуй ещё раз'); } finally { clearTimeout(tm); }
    }
  }
  async function searchOpenverse(q, page = 1) {
    const key = q + '#' + page;
    if (ovCache.has(key)) return ovCache.get(key);
    const p = new URLSearchParams({ q, license_type: 'modification', source: 'jamendo', page_size: '20', page: String(page) });
    const r = await ovFetch(OV + '?' + p);
    if (r.status === 429) throw new Error('Слишком много поисков подряд — подожди минуту');
    if (!r.ok) throw new Error('Каталог сейчас недоступен');
    const d = await r.json();
    const items = d.results.filter(x => OV_LIC.has(x.license) && x.url && !x.mature && (!x.duration || x.duration <= 600000)).map(x => {
      const artist = (x.creator || 'Неизвестный артист').replace(/\s*-\s*$/, '').trim();
      let title = (x.title || 'Без названия').trim().replace(/^\d{1,2}[\s.)_-]+/, '');
      if (title.toLowerCase().startsWith(artist.toLowerCase() + ' - ')) title = title.slice(artist.length + 3);
      const alb = /\/album\/(\d+)/.exec(x.audio_set?.foreign_landing_url || '');
      return {
        jid: (/\/track\/(\d+)/.exec(x.foreign_landing_url || '') || [])[1] || '',
        title: title.trim() || x.title, artist, url: x.url, duration: Math.round((x.duration || 0) / 1000),
        licence: x.license === 'cc0' ? 'CC0' : x.license === 'pdm' ? 'Public Domain' : `CC ${x.license.toUpperCase()}${x.license_version ? ' ' + x.license_version : ''}`,
        cover: alb ? `https://usercontent.jamendo.com/?type=album&id=${alb[1]}&width=300` : null,
      };
    }).filter(x => x.jid);
    const res = { items, more: page < (d.page_count || 0) };
    ovCache.set(key, res);
    return res;
  }
  // что из каталога уже есть: на сайте или в очереди (номер трека Jamendo хранится в альбоме)
  async function knownJamendo() {
    const { data } = await sb.from('sup_tracks').select('id,album,status').like('album', 'Jamendo #%').limit(1000);
    return new Map((data || []).map(t => [(/#(\d+)/.exec(t.album) || [])[1], t]));
  }
  function openRow(it, i, known) {
    const k = known.get(it.jid);
    const act = k ? (k.status === 'ready' ? `<button class="btn ghost sm" data-oact="play">${ic('play')} На сайте</button>`
      : `<button class="btn ghost sm" disabled>В очереди</button>`)
      : `<button class="btn sm" data-oact="import">${ic('dl')} Загрузить</button>`;
    return `<div class="orow" data-o="${i}">
      <button class="cv" data-oact="preview" aria-label="Послушать отрывок">${it.cover ? `<img loading="lazy" alt="" src="${esc(it.cover)}">` : `<div class="ph" style="background:${grad(it.title)}"></div>`}<span class="go">${ic('play')}</span></button>
      <div class="info"><div class="t">${esc(it.title)}</div><div class="a">${esc(it.artist)} · ${fmt(it.duration)}</div></div>${act}</div>`;
  }
  function openSearch(q) {
    clearTimeout(openTimer); preview.pause();
    const box = $('#open'); if (!box) return;
    if (q.length < 2) { box.innerHTML = ''; return; }
    const my = ++openN;
    box.innerHTML = `<h2>Можно загрузить</h2><div class="empty">Ищу в каталоге свободной музыки… новый запрос бывает долгим, до полминуты.</div>`;
    // пока человек печатает, каталог не дёргаем: у него лимит запросов
    openTimer = setTimeout(async () => {
      let res, known;
      try { [res, known] = await Promise.all([searchOpenverse(q), knownJamendo()]); }
      catch (e) { if (my === openN) box.innerHTML = `<h2>Можно загрузить</h2><div class="empty">${esc(e.message)}</div>`; return; }
      if (my !== openN || !box.isConnected) return;
      openItems = res.items; openPage = 1;
      box.innerHTML = `<h2>Можно загрузить</h2><p class="sub">Свободные треки Jamendo. ▶ — отрывок, «Загрузить» — трек проверит нейросеть и выложит на сайт.</p>
        ${res.items.length ? `<div class="olist">${res.items.map((it, i) => openRow(it, i, known)).join('')}</div>
        ${res.more ? '<button class="btn ghost" id="oMore">Показать ещё</button>' : ''}` : '<div class="empty">В каталоге тоже ничего. Попробуй по-английски или другое название.</div>'}`;
      const more = $('#oMore');
      if (more) more.onclick = async () => {
        more.disabled = true;
        try {
          const [r2, k2] = await Promise.all([searchOpenverse(q, openPage + 1), knownJamendo()]);
          openPage++; const start = openItems.length; openItems = openItems.concat(r2.items);
          $('.olist', box).insertAdjacentHTML('beforeend', r2.items.map((it, i) => openRow(it, start + i, k2)).join(''));
          if (r2.more) more.disabled = false; else more.remove();
        } catch (e) { more.disabled = false; toast(e.message); }
      };
    }, 700);
  }
  const resetPreview = () => $$('.orow').forEach(r => { r.classList.remove('pv'); const g = $('.go', r); if (g) g.innerHTML = ic('play'); });
  preview.addEventListener('pause', () => { if (preview.paused) resetPreview(); });
  audio.addEventListener('play', () => preview.pause());
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-oact]'); if (!b) return;
    const row = b.closest('[data-o]'), it = openItems[+row.dataset.o]; if (!it) return;
    const act = b.dataset.oact;
    if (act === 'preview') {
      const same = preview.src === it.url && !preview.paused;
      resetPreview(); if (same) return preview.pause();
      if (preview.src !== it.url) preview.src = it.url;
      audio.pause(); preview.play().catch(() => toast('Не удалось включить отрывок'));
      row.classList.add('pv'); $('.go', row).innerHTML = ic('pause');
    } else if (act === 'play') {
      const k = (await knownJamendo()).get(it.jid);
      const { data } = await sb.from('sup_tracks').select(COLS).eq('id', k.id).maybeSingle();
      if (data) setQueue([data], 0);
    } else if (act === 'import') {
      if (!S.user) return openAuth();
      b.disabled = true;
      try {
        const id = crypto.randomUUID(), path = `${S.user.id}/${id}.imp`;
        let r = await sb.storage.from('sup-incoming').upload(path, new Blob([JSON.stringify({ url: it.url, cover: it.cover })], { type: 'application/json' }), { contentType: 'application/json' });
        if (r.error) throw r.error;
        r = await sb.from('sup_tracks').insert({ id, title: it.title.slice(0, 200), artist: it.artist.slice(0, 200), duration: it.duration,
          album: `Jamendo #${it.jid} · ${it.licence}`, source_path: path });
        if (r.error) throw r.error;
        b.className = 'btn ghost sm'; b.innerHTML = 'В очереди';
        toast('Загружается. После проверки нейросетью трек появится на сайте');
      } catch (ex) { b.disabled = false; toast(ex.message || String(ex)); }
    }
  });

  // ---------- «Забыли пароль?» ----------
  const AUTH_ERR = {
    'Invalid login credentials': 'Неверная почта или пароль',
    'User already registered': 'Такая почта уже зарегистрирована',
    'Email not confirmed': 'Подтверди почту — ссылка в письме',
    'New password should be different from the old password.': 'Новый пароль должен отличаться от старого',
  };
  function openReset(email = '') {
    const m = modal(`<h2>Сброс пароля</h2><p class="sub" style="margin:0">Введи почту, с которой регистрировался. Придёт письмо со ссылкой — по ней задашь новый пароль.</p>
      <input id="rEmail" type="email" placeholder="Почта" autocomplete="email" value="${esc(email)}">
      <div class="err" id="rErr"></div><button class="btn" id="rGo">Прислать ссылку</button>
      <button class="btn ghost" id="rBack">Вспомнил пароль — войти</button>`);
    $('#rBack', m).onclick = () => openAuth();
    $('#rGo', m).onclick = async () => {
      const mail = $('#rEmail', m).value.trim(), err = $('#rErr', m);
      if (!mail) return err.textContent = 'Введи почту';
      $('#rGo', m).disabled = true;
      const { error } = await sb.auth.resetPasswordForEmail(mail, { redirectTo: location.href.split('#')[0] });
      if (error) {
        $('#rGo', m).disabled = false;
        return err.textContent = /rate limit|security purposes/i.test(error.message) ? 'Письмо недавно уже отправляли — подожди немного' : error.message;
      }
      modal(`<h2>Письмо отправлено</h2><p class="sub" style="margin:0">Открой письмо на <b>${esc(mail)}</b> и нажми на ссылку. Не видно — загляни в «Спам».</p>
        <button class="btn" onclick="this.closest('.modal').hidden=true">Понятно</button>`);
    };
  }
  function openNewPass() {
    const m = modal(`<h2>Новый пароль</h2><p class="sub" style="margin:0">Придумай новый пароль — старый перестанет работать.</p>
      <input id="nPass" type="password" placeholder="Новый пароль (от 6 символов)" autocomplete="new-password">
      <input id="nPass2" type="password" placeholder="Ещё раз" autocomplete="new-password">
      <div class="err" id="nErr"></div><button class="btn" id="nGo">Сохранить пароль</button>`);
    $('#nGo', m).onclick = async () => {
      const a = $('#nPass', m).value, b = $('#nPass2', m).value, err = $('#nErr', m);
      if (a.length < 6) return err.textContent = 'Минимум 6 символов';
      if (a !== b) return err.textContent = 'Пароли не совпадают';
      const { error } = await sb.auth.updateUser({ password: a });
      if (error) return err.textContent = AUTH_ERR[error.message] || error.message;
      closeModal(); toast('Пароль изменён — ты в аккаунте');
    };
  }

  // ---------- приложение для Android ----------
  function appBanner() {
    if (!/Android/i.test(navigator.userAgent) || window.YouMusicApp || localStorage.getItem('supAppHidden')) return '';
    return `<div class="app-ban" id="appBan"><span class="logo-mark"></span><div><b>supMUSIC для Android</b><span>Музыка в фоне, треки в «Загрузки», голосовой поиск</span></div>
      <a class="btn sm" href="YouMusic.apk" download>${ic('dl')} APK</a><button class="ib" id="appHide" aria-label="Скрыть">${ic('x')}</button></div>`;
  }
  function bindAppBanner() {
    const h = $('#appHide');
    if (h) h.onclick = () => { localStorage.setItem('supAppHidden', '1'); $('#appBan').remove(); };
  }
  // кнопка «Назад» в приложении: закрываем верхнее, что открыто; false — приложение свернётся
  window.__ymBack = () => {
    if (!$('#modal').hidden) { closeModal(); return true; }
    const full = $('#full');
    if (!full.hidden && full.classList.contains('show-ly')) { full.classList.remove('show-ly'); renderLyMode(); return true; }
    if (!full.hidden) { full.hidden = true; return true; }
    if (location.hash && location.hash !== '#/') { location.hash = '#/'; return true; }
    return false;
  };

  // ссылка «поделиться»: #/track/<id>
  async function playById(id) {
    if (!/^[0-9a-f-]{36}$/.test(id || '')) return;
    const { data } = await sb.from('sup_tracks').select(COLS).eq('id', id).eq('status', 'ready').maybeSingle();
    if (data) { setQueue([data], 0); $('#full').hidden = false; } else toast('Трек не найден');
  }

  // ---------- роутер ----------
  async function route() {
    const [, page, argRaw = ''] = (location.hash || '#/').split('/');
    const arg = argRaw.split('?')[0];
    const pg = (page || '').split('?')[0];
    const cur = pg === 'playlist' ? 'collection' : ['search', 'collection', 'create', 'upload'].includes(pg) ? pg : 'home';
    $$('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === cur));
    view.scrollTop = 0; $('#full').hidden = true; closeModal();
    try {
      if ((page || '').startsWith('search')) await pageSearch();
      else if (page === 'collection') await pageCollection();
      else if (page === 'playlist') await pagePlaylist(arg);
      else if (page === 'upload') pageUpload();
      else if (page === 'create') pageCreate();
      else if (page === 'track') { await pageHome(); playById(arg); }
      else await pageHome();
    } catch (e) { view.innerHTML = `<div class="err">Ошибка: ${esc(e.message || e)}</div>`; }
  }
  window.addEventListener('hashchange', route);

  function renderSideUser() {
    const el = $('#sideUser');
    el.innerHTML = S.user
      ? `<b>${esc(S.profile?.name || S.user.email)}</b><button class="btn ghost sm" id="outBtn">Выйти</button>`
      : '<b style="color:var(--dim);font-weight:500">Войди, чтобы лайкать и загружать</b><button class="btn sm" id="inBtn">Войти</button>';
    const o = $('#outBtn'), i = $('#inBtn');
    if (o) o.onclick = () => sb.auth.signOut();
    if (i) i.onclick = () => openAuth();
  }

  // ---------- старт ----------
  async function start() {
    renderPlayer();
    if (!sb) {
      view.innerHTML = '<h1>supMUSIC</h1><div class="err">Supabase не подключён. Задай секреты SUPABASE_URL и SUPABASE_ANON_KEY в репозитории и перезапусти деплой.</div>';
      return;
    }
    const { data } = await sb.auth.getSession();
    S.user = data.session?.user || null;
    await loadUserData(); renderSideUser();
    sb.auth.onAuthStateChange(async (ev, session) => {
      const was = S.user?.id; S.user = session?.user || null;
      if (ev === 'PASSWORD_RECOVERY') {
        if ($('#nPass')) return; // форма нового пароля уже открыта
        await loadUserData(); renderSideUser(); route(); openNewPass(); return;
      }
      if (was === S.user?.id && ev !== 'SIGNED_OUT') return;
      await loadUserData(); renderSideUser(); route();
    });
    route();
    if (AUTH_HASH.get('type') === 'recovery' && S.user) openNewPass();
    else if (AUTH_HASH.get('error_code') || AUTH_HASH.get('error')) {
      history.replaceState(null, '', location.pathname);
      toast(/expired|invalid/i.test(AUTH_HASH.get('error_description') || '') ? 'Ссылка из письма устарела — запроси новую' : (AUTH_HASH.get('error_description') || 'Ссылка недействительна'));
    }
  }
  start();
})();
