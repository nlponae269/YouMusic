// Экран профиля: вход, регистрация, загрузка треков, «Мои треки», модерация для админа.
import { account, configured, MAX_UPLOAD } from './api.js';
import { readTags } from './tags.js';
import { $, esc, icon, toast } from './util.js';

const STATUS = {
  pending: ['В очереди на проверку', ''],
  processing: ['Проверяется нейросетью…', ''],
  ready: ['Опубликован', 'is-ok'],
  failed: ['Ошибка', 'is-error'],
};

let mode = 'login';
let pendingFiles = [];
let pollTimer = null;

export async function viewAccount(route = {}) {
  if (route.mode === 'signup' || route.mode === 'login') {
    mode = route.mode;
    route.mode = null;
    history.replaceState(null, '', '#/account');
  }
  if (!configured) {
    return `<h1 class="page-title">Профиль</h1>
      <div class="empty">${icon('user')}<b>Сайт ещё не подключён</b>
      <span>Владельцу сайта нужно подключить Supabase — см. инструкцию в README репозитория.</span></div>`;
  }
  const user = await account.user();
  if (!user) return authForm();

  const [mine, admin] = await Promise.all([account.myTracks(), account.isAdmin()]);
  const all = admin ? await account.myTracks(true) : [];
  return `
    <section class="hero" style="--c:var(--tc)">
      <span class="hero__top">${icon('user')} Профиль${admin ? ' · администратор' : ''}</span>
      <h1 class="hero__title">${esc(account.nickname(user))}</h1>
      <span class="hero__sub">${esc(user.email || '')}</span>
      <div class="hero__actions"><button class="btn btn--ghost" data-acc="logout">Выйти из аккаунта</button></div>
    </section>

    <section class="panel">
      <h2 class="section__title">Загрузить треки</h2>
      <ol class="steps">
        <li>Выбери файлы — название, обложка и текст подтянутся сами</li>
        <li>Проверь название и нажми «Опубликовать»</li>
        <li>Через 10–30 минут трек появится на сайте</li>
      </ol>
      <label class="btn btn--accent btn--lg btn--block" id="drop">
        ${icon('plus')}Выбрать треки
        <input type="file" id="files" accept="audio/*,.mp3,.m4a,.ogg,.flac,.wav,.opus" multiple hidden>
      </label>
      <span class="section__hint">MP3, M4A, OGG, FLAC, WAV · до 50 МБ</span>
      <div id="items" class="items"></div>
      <div id="upload-bar" class="upload-bar" hidden>
        <label class="check"><input type="checkbox" id="rights"> У меня есть права на эту музыку</label>
        <button class="btn btn--accent" data-acc="upload">${icon('check')}Опубликовать</button>
      </div>
      <p class="section__hint">Каждый трек проверяет нейросеть: мат и упоминания наркотиков вырезаются, на их месте остаётся бит.
        Текст песни найдётся сам в открытой базе текстов или будет записан нейросетью.</p>
    </section>

    <section>
      <div class="section__head"><h2 class="section__title">Мои треки</h2><span class="section__hint">${mine.length}</span></div>
      ${trackList(mine)}
    </section>
    ${admin ? `
    <section>
      <div class="section__head"><h2 class="section__title">Все треки</h2><span class="section__hint">модерация</span></div>
      ${trackList(all, true)}
    </section>` : ''}`;
}

function authForm() {
  const signup = mode === 'signup';
  return `
    <h1 class="page-title">${signup ? 'Регистрация' : 'Вход'}</h1>
    <form class="panel auth" id="auth-form">
      <p class="section__hint">${signup ? 'Зарегистрируйся, чтобы загружать свою музыку.' : 'Войди, чтобы загружать треки.'}</p>
      ${signup ? '<input class="field" name="nickname" placeholder="Ник" maxlength="40" required autocomplete="nickname">' : ''}
      <input class="field" name="email" type="email" placeholder="Почта" required autocomplete="email">
      <input class="field" name="password" type="password" placeholder="Пароль (минимум 6 символов)" minlength="6" required
        autocomplete="${signup ? 'new-password' : 'current-password'}">
      <button class="btn btn--accent">${signup ? 'Зарегистрироваться' : 'Войти'}</button>
      <button type="button" class="chip" data-acc="switch">${signup ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Регистрация'}</button>
    </form>`;
}

function trackList(tracks, admin = false) {
  if (!tracks.length) return '<p class="section__hint">Пока ничего нет</p>';
  return `<div class="list">${tracks.map((t) => {
    const [label, cls] = STATUS[t.status] || [t.status, ''];
    const extra = t.status === 'ready' && t.censored ? ` · вырезано фрагментов: ${t.censored}`
      : t.status === 'failed' && t.error ? `: ${esc(t.error)}` : '';
    return `
    <div class="row" data-track="${t.id}">
      <span class="row__art" style="--c:${esc(t.color || '#333')}">${t.cover ? `<img src="${t.cover}" alt="" loading="lazy">` : ''}</span>
      <span class="row__meta">
        <span class="row__title">${esc(t.title)}</span>
        <span class="row__artist">${esc(t.artist)}${admin && t.uploader ? ` · загрузил ${esc(t.uploader)}` : ''}</span>
        <span class="status ${cls}">${label}${extra}</span>
      </span>
      <span></span>
      <button class="btn btn--ghost btn--sm" data-acc="delete">${icon('trash')}Удалить</button>
    </div>`;
  }).join('')}</div>`;
}

/* ---------- Поведение экрана ---------- */

export function mountAccount(root, rerender) {
  root._accountCleanup?.();
  clearInterval(pollTimer);
  pendingFiles = [];

  const form = $('#auth-form', root);
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('.btn');
    btn.disabled = true;
    const f = new FormData(form);
    try {
      if (mode === 'signup') {
        const { needsConfirm } = await account.signUp(f.get('email').trim(), f.get('password'), f.get('nickname').trim());
        toast(needsConfirm ? 'Проверь почту и подтверди регистрацию' : 'Добро пожаловать!');
        mode = 'login';
      } else {
        await account.signIn(f.get('email').trim(), f.get('password'));
        toast('Вход выполнен');
      }
      rerender();
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  });

  const filesInput = $('#files', root);
  filesInput?.addEventListener('change', () => {
    addFiles([...filesInput.files], root);
    filesInput.value = '';
  });

  root.addEventListener('click', onClick);
  root._accountCleanup = () => root.removeEventListener('click', onClick);

  async function onClick(e) {
    const btn = e.target.closest('[data-acc]');
    if (!btn) return;
    const act = btn.dataset.acc;
    if (act === 'switch') {
      mode = mode === 'signup' ? 'login' : 'signup';
      rerender();
    } else if (act === 'logout') {
      await account.signOut();
      mode = 'login';
      toast('Вы вышли');
      rerender();
    } else if (act === 'remove-file') {
      const item = btn.closest('.item');
      pendingFiles = pendingFiles.filter((p) => p.el !== item);
      item.remove();
      syncBar(root);
    } else if (act === 'upload') {
      uploadAll(btn, root, rerender);
    } else if (act === 'delete') {
      const row = btn.closest('[data-track]');
      const title = row.querySelector('.row__title').textContent;
      if (!confirm(`Удалить «${title}»?`)) return;
      try {
        await account.deleteTrack(row.dataset.track);
        row.remove();
        toast('Трек удалён');
      } catch (err) {
        toast(err.message);
      }
    }
  }

  // пока есть треки на проверке — обновляем статусы
  if (root.querySelector('.status:not(.is-ok):not(.is-error)')) {
    pollTimer = setInterval(() => {
      if (!document.body.contains(root) || location.hash !== '#/account') return clearInterval(pollTimer);
      if (!pendingFiles.length) rerender();
    }, 30_000);
  }
}

function guessFromName(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').replace(/^\d+[\s.-]+/, '').trim();
  const m = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: base };
}

async function addFiles(files, root) {
  for (const file of files) {
    if (file.size > MAX_UPLOAD) {
      toast(`«${file.name}» больше 50 МБ`);
      continue;
    }
    const guess = guessFromName(file.name);
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `
      <label class="item__cover" title="Обложка"><img alt=""><span>Обложка</span>
        <input type="file" accept="image/jpeg,image/png,image/webp" hidden></label>
      <div class="item__fields">
        <input class="field" name="title" placeholder="Название" value="${esc(guess.title)}" maxlength="200">
        <input class="field" name="artist" placeholder="Исполнитель" value="${esc(guess.artist)}" maxlength="200">
        <input class="field wide" name="album" placeholder="Альбом (необязательно)" maxlength="200">
        <details class="wide"><summary>Текст песни (обычный или LRC с таймкодами)</summary>
          <textarea class="field" name="lyrics" placeholder="[00:12.50] Первая строка"></textarea></details>
        <div class="item__info"><span data-status>${esc(file.name)}</span><span class="item__bar"><i></i></span></div>
      </div>
      <button class="row__btn item__remove" data-acc="remove-file" aria-label="Убрать">${icon('close')}</button>`;
    const entry = { file, cover: null, el };
    pendingFiles.push(entry);
    $('#items', root).append(el);
    const coverInput = el.querySelector('input[type="file"]');
    coverInput.addEventListener('change', () => coverInput.files[0] && setCover(entry, coverInput.files[0]));
    syncBar(root);
    try {
      const tags = await readTags(file);
      if (tags.title) el.querySelector('[name="title"]').value = tags.title;
      if (tags.artist) el.querySelector('[name="artist"]').value = tags.artist;
      if (tags.album) el.querySelector('[name="album"]').value = tags.album;
      if (tags.lyrics) el.querySelector('[name="lyrics"]').value = tags.lyrics;
      if (tags.cover) setCover(entry, tags.cover);
    } catch { /* теги не обязательны */ }
  }
}

function setCover(entry, file) {
  entry.cover = file;
  entry.el.querySelector('.item__cover img').src = URL.createObjectURL(file);
}

function syncBar(root) {
  $('#upload-bar', root).hidden = !pendingFiles.length;
}

async function uploadAll(btn, root, rerender) {
  if (!$('#rights', root).checked) return toast('Подтверди, что у тебя есть права на музыку');
  btn.disabled = true;
  let ok = 0;
  for (const entry of pendingFiles.slice()) {
    const { el } = entry;
    const val = (n) => el.querySelector(`[name="${n}"]`).value;
    const status = el.querySelector('[data-status]');
    const bar = el.querySelector('.item__bar i');
    if (!val('title').trim() || !val('artist').trim()) {
      status.textContent = 'Укажи название и исполнителя';
      el.classList.add('is-error');
      continue;
    }
    el.classList.remove('is-error');
    try {
      await account.upload({
        file: entry.file, cover: entry.cover,
        title: val('title'), artist: val('artist'), album: val('album'), lyrics: val('lyrics'),
      }, (p) => { status.textContent = `Загрузка ${Math.round(p * 100)}%`; bar.style.width = `${p * 100}%`; });
      status.textContent = 'Загружено — ждёт проверки';
      el.classList.add('is-done');
      pendingFiles = pendingFiles.filter((p) => p !== entry);
      ok++;
    } catch (err) {
      status.textContent = err.message;
      el.classList.add('is-error');
    }
  }
  btn.disabled = false;
  if (ok) {
    toast(`Загружено: ${ok}. Появится на сайте после проверки`);
    if (!pendingFiles.length) setTimeout(rerender, 800);
  }
}
