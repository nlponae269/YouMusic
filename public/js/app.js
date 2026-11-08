'use strict';
(() => {
  const cfg = window.SUP_CFG || {};
  const sb = cfg.url && cfg.key && window.supabase ? window.supabase.createClient(cfg.url, cfg.key) : null;

  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = s => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const pubUrl = (bucket, path) => path ? sb.storage.from(bucket).getPublicUrl(path).data.publicUrl : '';
  const shuffleArr = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const NOCOVER = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#222"/><text x="24" y="31" font-size="22" text-anchor="middle" fill="#666">♪</text></svg>');

  let toastT;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2600);
  }

  // ---------- состояние ----------
  const S = { user: null, profile: null, likes: new Set(), playlists: [], queue: [], qi: -1, shuffle: false, repeat: 0, list: [] };
  const audio = new Audio(); audio.preload = 'metadata';
  audio.volume = 0.8;

  // ---------- данные ----------
  async function getTracks({ q, owner, genre, order = 'created_at', limit = 100 } = {}) {
    let r = sb.from('sup_tracks').select('*').order(order, { ascending: false }).limit(limit);
    if (q) { const p = `%${q.replace(/[%,()]/g, ' ')}%`; r = r.or(`title.ilike.${p},artist.ilike.${p}`); }
    if (owner) r = r.eq('owner', owner);
    if (genre) r = r.eq('genre', genre);
    const { data, error } = await r;
    if (error) throw error;
    return data || [];
  }
  async function loadUserData() {
    S.likes = new Set(); S.playlists = [];
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
    if (S.likes.has(id)) { S.likes.delete(id); await sb.from('sup_likes').delete().eq('user_id', S.user.id).eq('track_id', id); }
    else { S.likes.add(id); await sb.from('sup_likes').insert({ user_id: S.user.id, track_id: id }); }
    syncLikes();
  }
  function syncLikes() {
    document.querySelectorAll('[data-like]').forEach(b => {
      const on = S.likes.has(b.dataset.like); b.textContent = on ? '♥' : '♡'; b.classList.toggle('on', on);
    });
    const cur = S.queue[S.qi]; const pl = $('#pLike');
    if (cur) { const on = S.likes.has(cur.id); pl.textContent = on ? '♥' : '♡'; pl.classList.toggle('on', on); }
  }

  // ---------- плеер ----------
  function setQueue(list, idx) {
    S.queue = list.slice(); S.qi = idx; playCurrent();
  }
  function playCurrent() {
    const t = S.queue[S.qi]; if (!t) return;
    audio.src = pubUrl('audio', t.audio_path);
    audio.play().catch(() => toast('Не удалось воспроизвести'));
    $('#pTitle').textContent = t.title; $('#pArtist').textContent = t.artist;
    $('#pCover').src = t.cover_path ? pubUrl('covers', t.cover_path) : NOCOVER;
    document.title = `${t.title} — supMUSIC`;
    markNow(); syncLikes();
    sb.rpc('sup_inc_plays', { track: t.id }).then(() => {});
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, artwork: t.cover_path ? [{ src: pubUrl('covers', t.cover_path) }] : [] });
    }
  }
  function markNow() {
    const cur = S.queue[S.qi];
    document.querySelectorAll('.row').forEach(r => r.classList.toggle('now', !!cur && r.dataset.id === cur.id));
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
    if (!S.queue.length) { if (S.list.length) setQueue(S.list, 0); return; }
    audio.paused ? audio.play() : audio.pause();
  }
  audio.addEventListener('play', () => $('#pPlay').textContent = '⏸');
  audio.addEventListener('pause', () => $('#pPlay').textContent = '▶');
  audio.addEventListener('ended', () => next(true));
  audio.addEventListener('timeupdate', () => {
    if (!audio.duration) return;
    $('#pCur').textContent = fmt(audio.currentTime); $('#pDur').textContent = fmt(audio.duration);
    if (!seeking) $('#pSeek').value = audio.currentTime / audio.duration * 1000;
  });
  let seeking = false;
  $('#pSeek').addEventListener('input', () => { seeking = true; });
  $('#pSeek').addEventListener('change', e => { if (audio.duration) audio.currentTime = e.target.value / 1000 * audio.duration; seeking = false; });
  $('#pVol').addEventListener('input', e => audio.volume = e.target.value / 100);
  $('#pPlay').onclick = togglePlay;
  $('#pNext').onclick = () => next(false);
  $('#pPrev').onclick = prev;
  $('#pShuffle').onclick = e => { S.shuffle = !S.shuffle; e.currentTarget.classList.toggle('on', S.shuffle); };
  $('#pRepeat').onclick = e => {
    S.repeat = (S.repeat + 1) % 3;
    e.currentTarget.textContent = S.repeat === 2 ? '🔂' : '🔁';
    e.currentTarget.classList.toggle('on', S.repeat > 0);
  };
  $('#pLike').onclick = () => { const t = S.queue[S.qi]; if (t) toggleLike(t.id); };
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => audio.play());
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('nexttrack', () => next(false));
    navigator.mediaSession.setActionHandler('previoustrack', prev);
  }
  document.addEventListener('keydown', e => {
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  });

  // ---------- разметка списков ----------
  function rowHtml(t, i, opts = {}) {
    const mine = S.user && t.owner === S.user.id;
    const on = S.likes.has(t.id);
    return `<div class="row" data-id="${t.id}" data-i="${i}">
      <img class="cover" loading="lazy" src="${t.cover_path ? esc(pubUrl('covers', t.cover_path)) : NOCOVER}" alt="">
      <div class="info" data-play><div class="t">${esc(t.title)}</div><div class="a">${esc(t.artist)}${t.genre ? ' · ' + esc(t.genre) : ''}</div></div>
      <button class="icon ${on ? 'on' : ''}" data-like="${t.id}" title="Нравится">${on ? '♥' : '♡'}</button>
      <button class="icon add" data-add="${t.id}" title="В плейлист">＋</button>
      <span class="d">${fmt(t.duration)}</span>
      ${opts.remove ? `<button class="icon" data-remove="${t.id}" title="Убрать из плейлиста">✕</button>`
        : mine ? `<button class="icon" data-del="${t.id}" title="Удалить трек">🗑</button>` : '<span></span>'}
    </div>`;
  }
  function listHtml(tracks, opts) {
    return tracks.length ? `<div class="list">${tracks.map((t, i) => rowHtml(t, i, opts)).join('')}</div>` : '<div class="empty">Здесь пока пусто</div>';
  }
  function bindList(root, tracks, opts = {}) {
    S.list = tracks;
    root.querySelectorAll('.row').forEach(r => {
      const i = +r.dataset.i, t = tracks[i];
      r.querySelector('[data-play]').onclick = () => setQueue(tracks, i);
      r.querySelector('.cover').onclick = () => setQueue(tracks, i);
      r.querySelector('[data-like]').onclick = () => toggleLike(t.id);
      r.querySelector('[data-add]').onclick = () => addToPlaylist(t);
      const del = r.querySelector('[data-del]');
      if (del) del.onclick = async () => {
        if (!confirm(`Удалить «${t.title}»?`)) return;
        await sb.storage.from('audio').remove([t.audio_path]);
        if (t.cover_path) await sb.storage.from('covers').remove([t.cover_path]);
        const { error } = await sb.from('sup_tracks').delete().eq('id', t.id);
        if (error) return toast(error.message);
        toast('Трек удалён'); route();
      };
      const rm = r.querySelector('[data-remove]');
      if (rm) rm.onclick = () => opts.remove(t);
    });
    markNow();
  }

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
      if (r.error) { err.textContent = r.error.message; return; }
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
    m.querySelectorAll('[data-pl]').forEach(b => b.onclick = () => put(b.dataset.pl));
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

  async function pageHome() {
    view.innerHTML = '<div class="empty">Загрузка…</div>';
    const [fresh, top] = await Promise.all([getTracks({ limit: 30 }), getTracks({ order: 'plays', limit: 10 })]);
    view.innerHTML = `<div class="wave"><div><h1>Моя волна</h1><p>Случайная музыка из всего каталога</p></div><button id="waveBtn" title="Включить">▶</button></div>
      <h2>Популярное</h2><div id="top"></div><h2>Новое</h2><div id="fresh"></div>`;
    $('#top').innerHTML = listHtml(top); $('#fresh').innerHTML = listHtml(fresh);
    $('#waveBtn').onclick = async () => {
      const pool = shuffleArr(await getTracks({ limit: 200 }));
      if (!pool.length) return toast('Каталог пока пуст');
      S.shuffle = true; $('#pShuffle').classList.add('on'); setQueue(pool, 0);
    };
    bindList($('#top'), top); bindList($('#fresh'), fresh);
  }

  async function pageSearch() {
    view.innerHTML = `<h1>Поиск</h1><input id="q" placeholder="Трек или исполнитель" autofocus>
      <div class="chips">${GENRES.map(g => `<button class="chip" data-g="${g}">${g}</button>`).join('')}</div><div id="res"></div>`;
    let t, genre = '';
    const run = async () => {
      const q = $('#q').value.trim();
      const res = $('#res');
      if (!q && !genre) { res.innerHTML = '<div class="empty">Начни вводить название или выбери жанр</div>'; return; }
      const tracks = await getTracks({ q, genre });
      res.innerHTML = listHtml(tracks); bindList(res, tracks);
    };
    $('#q').oninput = () => { clearTimeout(t); t = setTimeout(run, 250); };
    view.querySelectorAll('[data-g]').forEach(b => b.onclick = () => {
      genre = genre === b.dataset.g ? '' : b.dataset.g;
      view.querySelectorAll('[data-g]').forEach(x => x.style.color = x.dataset.g === genre ? 'var(--accent)' : '');
      run();
    });
    run();
  }

  async function pageCollection() {
    if (!S.user) { view.innerHTML = '<h1>Коллекция</h1><div class="empty">Войди, чтобы лайкать треки и собирать плейлисты.</div><button class="btn" id="goIn">Войти</button>'; $('#goIn').onclick = () => openAuth(); return; }
    view.innerHTML = '<div class="empty">Загрузка…</div>';
    const ids = [...S.likes];
    const liked = ids.length ? (await sb.from('sup_tracks').select('*').in('id', ids)).data || [] : [];
    const mine = await getTracks({ owner: S.user.id });
    view.innerHTML = `<h1>Коллекция</h1>
      <h2>Плейлисты</h2><div class="grid" id="pls">
        ${S.playlists.map(p => `<div class="card" data-pl="${p.id}"><div class="pic">🎵</div><b>${esc(p.title)}</b><span>Плейлист</span></div>`).join('')}
        <div class="card" id="newPl"><div class="pic">＋</div><b>Новый плейлист</b><span>&nbsp;</span></div></div>
      <h2>Мне нравится</h2><div id="liked"></div><h2>Мои загрузки</h2><div id="mine"></div>`;
    $('#liked').innerHTML = listHtml(liked); bindList($('#liked'), liked);
    $('#mine').innerHTML = listHtml(mine); bindList($('#mine'), mine);
    view.querySelectorAll('[data-pl]').forEach(c => c.onclick = () => location.hash = `#/playlist/${c.dataset.pl}`);
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
    const { data } = await sb.from('sup_playlist_tracks').select('position, sup_tracks(*)').eq('playlist_id', id).order('position');
    const tracks = (data || []).map(x => x.sup_tracks).filter(Boolean);
    view.innerHTML = `<h1>${esc(pl.title)}</h1>
      <p><button class="btn" id="plPlay">▶ Играть</button> <button class="btn ghost" id="plDel">Удалить плейлист</button></p><div id="pt"></div>`;
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
    if (!S.user) { view.innerHTML = '<h1>Загрузить трек</h1><div class="empty">Чтобы загружать музыку, нужно войти.</div><button class="btn" id="goIn">Войти</button>'; $('#goIn').onclick = () => openAuth(); return; }
    view.innerHTML = `<h1>Загрузить трек</h1><div class="form">
      <label>Аудиофайл (mp3, m4a, ogg, wav · до 50 МБ)<input type="file" id="uFile" accept="audio/*"></label>
      <label>Название<input id="uTitle"></label>
      <label>Исполнитель<input id="uArtist" value="${esc(S.profile?.name || '')}"></label>
      <label>Жанр<select id="uGenre">${GENRES.map(g => `<option>${g}</option>`).join('')}</select></label>
      <label>Обложка (необязательно)<input type="file" id="uCover" accept="image/*"></label>
      <div class="err" id="uErr"></div>
      <button class="btn" id="uGo">Опубликовать</button>
      <p class="empty" style="padding:0">Загружай только то, на что у тебя есть права.</p></div>`;
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
        const ext = (f.name.split('.').pop() || 'mp3').toLowerCase().replace(/[^a-z0-9]/g, '');
        const key = () => `${S.user.id}/${crypto.randomUUID()}`;
        const audioPath = `${key()}.${ext}`;
        let r = await sb.storage.from('audio').upload(audioPath, f, { contentType: f.type || 'audio/mpeg' });
        if (r.error) throw r.error;
        let coverPath = null;
        if (c) {
          coverPath = `${key()}.${(c.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '')}`;
          r = await sb.storage.from('covers').upload(coverPath, c, { contentType: c.type });
          if (r.error) throw r.error;
        }
        r = await sb.from('sup_tracks').insert({ title, artist, genre: $('#uGenre').value, duration, audio_path: audioPath, cover_path: coverPath });
        if (r.error) throw r.error;
        toast('Трек опубликован'); location.hash = '#/';
      } catch (e) { err.textContent = e.message || String(e); btn.disabled = false; btn.textContent = 'Опубликовать'; }
    };
  }

  // ---------- роутер ----------
  async function route() {
    const [, page, arg] = (location.hash || '#/').split('/');
    document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === (page || 'home') || (!page && a.dataset.nav === 'home') || (page === 'playlist' && a.dataset.nav === 'collection')));
    view.scrollTop = 0;
    try {
      if (page === 'search') await pageSearch();
      else if (page === 'collection') await pageCollection();
      else if (page === 'playlist') await pagePlaylist(arg);
      else if (page === 'upload') pageUpload();
      else await pageHome();
    } catch (e) { view.innerHTML = `<div class="err">Ошибка: ${esc(e.message || e)}</div>`; }
  }
  window.addEventListener('hashchange', route);

  function renderSideUser() {
    const el = $('#sideUser');
    el.innerHTML = S.user
      ? `<b>${esc(S.profile?.name || S.user.email)}</b><button class="btn ghost" id="outBtn" style="margin-top:8px">Выйти</button>`
      : '<button class="btn" id="inBtn">Войти</button>';
    const o = $('#outBtn'), i = $('#inBtn');
    if (o) o.onclick = () => sb.auth.signOut();
    if (i) i.onclick = () => openAuth();
  }

  // ---------- старт ----------
  async function start() {
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
