'use strict';
(() => {
  const cfg = window.SUP_CFG || {};
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
  async function getTracks({ q, owner, genre, order = 'created_at', limit = 100 } = {}) {
    let r = sb.from('sup_tracks').select(COLS).order(order, { ascending: false }).limit(limit);
    if (!owner) r = r.eq('status', 'ready');
    if (q) { const p = `%${q.replace(/[%,()]/g, ' ')}%`; r = r.or(`title.ilike.${p},artist.ilike.${p}`); }
    if (owner) r = r.eq('owner', owner);
    if (genre) r = r.eq('genre', genre);
    const { data, error } = await r;
    if (error) throw error;
    return data || [];
  }
  async function loadUserData() {
    S.likes = new Set(); S.playlists = []; S.profile = null;
    if (!S.user) return;
    const [l, p, pr] = await Promise.all([
      sb.from('sup_likes').select('track_id').eq('user_id', S.user.id),
      sb.from('sup_playlists').select('*').eq('owner', S.user.id).order('created_at'),
      sb.from('sup_profiles').select('*').eq('id', S.user.id).maybeSingle(),
    ]);
    S.likes = new Set((l.data || []).map(x => x.track_id));
    S.playlists = p.data || [];
    S.profile = pr.data;
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
  const LY = { id: null, lines: [], synced: false, cur: -2 };

  // LRC: «[01:23.45] строка». Без таймкодов текст показывается целиком, без подсветки
  function parseLyrics(raw) {
    raw = (raw || '').trim();
    if (!raw) return { lines: [], synced: false };
    const lines = [];
    for (const row of raw.split(/\r?\n/)) {
      const text = row.replace(/\[[^\]]*\]/g, '').trim();
      for (const m of row.matchAll(/\[(\d{1,2}):(\d{2}(?:[.:]\d{1,3})?)\]/g)) lines.push({ t: +m[1] * 60 + parseFloat(m[2].replace(':', '.')), text });
    }
    if (lines.length) {
      lines.sort((a, b) => a.t - b.t);
      if (lines[0].t > 6) lines.unshift({ t: 0, text: '' }); // вступление: три точки
      return { lines, synced: true };
    }
    return { lines: raw.split(/\r?\n/).map(text => ({ t: 0, text: text.trim() })), synced: false };
  }

  async function loadLyrics(t) {
    LY.id = t.id; LY.lines = []; LY.synced = false; LY.cur = -2;
    drawLyrics('<div class="ly-note">Загружаю текст…</div>');
    let raw = lyricsCache.get(t.id);
    if (raw === undefined) {
      const { data } = await sb.from('sup_tracks').select('lyrics').eq('id', t.id).maybeSingle();
      raw = data?.lyrics || '';
      lyricsCache.set(t.id, raw);
    }
    if (LY.id !== t.id) return; // за это время включили другой трек
    Object.assign(LY, parseLyrics(raw), { cur: -2 });
    $('#full').classList.toggle('no-ly', !LY.lines.length);
    if (!LY.lines.length) return drawLyrics('<div class="ly-note">Текста для этого трека пока нет</div>');
    drawLyrics(LY.lines.map((l, i) => l.text
      ? `<p class="ly ${LY.synced ? '' : 'plain'}" data-i="${i}">${esc(l.text)}</p>`
      : `<p class="ly dots" data-i="${i}"><i></i><i></i><i></i></p>`).join(''));
    $$('#lyrics .ly').forEach(p => p.onclick = () => { if (LY.synced) { audio.currentTime = LY.lines[+p.dataset.i].t; audio.play(); } });
    syncLyrics(true);
  }
  let lyTouched = 0;
  ['wheel', 'touchmove'].forEach(ev => $('#lyrics').addEventListener(ev, () => { lyTouched = Date.now(); }, { passive: true }));
  $('#lyBtn').onclick = () => $('#full').classList.toggle('show-ly');
  function drawLyrics(html) { const box = $('#lyrics'); box.innerHTML = html; box.scrollTop = 0; }

  function syncLyrics(force) {
    if (!LY.synced || !LY.lines.length) return;
    const now = audio.currentTime + 0.25; // подсветка чуть раньше, чтобы глаз успевал
    let idx = -1;
    for (let i = 0; i < LY.lines.length && LY.lines[i].t <= now; i++) idx = i;
    if (idx === LY.cur && !force) return;
    LY.cur = idx;
    const box = $('#lyrics');
    $$('.ly', box).forEach((p, i) => {
      p.dataset.d = Math.min(Math.abs(i - idx), 4);
      p.classList.toggle('cur', i === idx);
    });
    const el = box.querySelector(`.ly[data-i="${Math.max(idx, 0)}"]`);
    // пока человек сам листает текст, не дёргаем его обратно
    if (el && Date.now() - lyTouched > 3000) box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2, behavior: force ? 'auto' : 'smooth' });
  }

  // ---------- списки ----------
  const STATUS = { pending: 'На проверке нейросетью…', processing: 'Проверяется нейросетью…', failed: 'Ошибка обработки' };
  function rowHtml(t, i, opts = {}) {
    const mine = S.user && t.owner === S.user.id;
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
      <button class="btn ghost" id="aSwitch">${up ? 'Уже есть аккаунт' : 'Нет аккаунта? Регистрация'}</button>`);
    $('#aSwitch', m).onclick = () => openAuth(up ? 'in' : 'up');
    $('#aGo', m).onclick = async () => {
      const email = $('#aEmail', m).value.trim(), password = $('#aPass', m).value, err = $('#aErr', m);
      err.textContent = '';
      const r = up
        ? await sb.auth.signUp({ email, password, options: { data: { name: $('#aName', m).value.trim() || email.split('@')[0] } } })
        : await sb.auth.signInWithPassword({ email, password });
      if (r.error) { err.style.color = ''; err.textContent = r.error.message; return; }
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
    view.innerHTML = `<h1 class="hello">${greeting()}${S.profile?.name ? ', ' + esc(S.profile.name) : ''}</h1>
      <div class="wave"><i></i><i></i><i></i><h1>Моя волна</h1><p>Бесконечная музыка из всего каталога</p><button class="play" id="waveBtn" aria-label="Включить">${ic('play')}</button></div>
      ${top.length ? `<h2>Популярное</h2><div id="top">${shelfHtml(top)}</div>` : ''}
      ${fresh.length ? `<h2>Новое</h2><div id="fresh">${shelfHtml(fresh)}</div><h2>Все треки</h2><div id="all">${listHtml(fresh)}</div>`
        : '<div class="empty">В каталоге пока нет треков. Загрузи первый — вкладка «Загрузить».</div>'}`;
    $('#waveBtn').onclick = async () => {
      const pool = shuffleArr(await getTracks({ limit: 200 }));
      if (!pool.length) return toast('Каталог пока пуст');
      S.shuffle = true; setQueue(pool, 0);
    };
    if (top.length) bindShelf($('#top'), top);
    if (fresh.length) { bindShelf($('#fresh'), fresh); bindList($('#all'), fresh); }
  }

  async function pageSearch() {
    view.innerHTML = `<h1>Поиск</h1><div class="search">${ic('search')}<input id="q" placeholder="Трек или исполнитель" autocomplete="off"></div>
      <div class="chips">${GENRES.map(g => `<button class="chip" data-g="${g}">${g}</button>`).join('')}</div><div id="res"></div>`;
    let t, genre = '', n = 0;
    const run = async () => {
      const q = $('#q').value.trim(), res = $('#res'), my = ++n;
      if (!q && !genre) { res.innerHTML = '<div class="empty">Начни вводить название или выбери жанр</div>'; return; }
      const tracks = await getTracks({ q, genre });
      if (my !== n) return;
      res.innerHTML = listHtml(tracks); bindList(res, tracks);
    };
    $('#q').oninput = () => { clearTimeout(t); t = setTimeout(run, 250); };
    $$('[data-g]', view).forEach(b => b.onclick = () => {
      genre = genre === b.dataset.g ? '' : b.dataset.g;
      $$('[data-g]', view).forEach(x => x.classList.toggle('on', x.dataset.g === genre));
      run();
    });
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
      <h2>Мне нравится</h2><div id="liked"></div><h2>Мои загрузки</h2><div id="mine"></div>`;
    $('#liked').innerHTML = listHtml(liked); bindList($('#liked'), liked);
    $('#mine').innerHTML = listHtml(mine); bindList($('#mine'), mine);
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

  // ---------- роутер ----------
  async function route() {
    const [, page, arg] = (location.hash || '#/').split('/');
    const cur = page === 'playlist' ? 'collection' : (page || 'home');
    $$('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === cur));
    view.scrollTop = 0; $('#full').hidden = true; closeModal();
    try {
      if (page === 'search') await pageSearch();
      else if (page === 'collection') await pageCollection();
      else if (page === 'playlist') await pagePlaylist(arg);
      else if (page === 'upload') pageUpload();
      else if (page === 'create') pageCreate();
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
      if (was === S.user?.id && ev !== 'SIGNED_OUT') return;
      await loadUserData(); renderSideUser(); route();
    });
    route();
  }
  start();
})();
