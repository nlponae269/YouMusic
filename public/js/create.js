// Экран «Создать песню»: заявка на генерацию нейросетью ACE-Step.
import { account, configured } from './api.js';
import { $, esc, icon, toast } from './util.js';

// Подписи на русском, а модели уходят английские теги — так она понимает стиль лучше
const GENRES = [
  ['Поп', 'pop'], ['Рэп', 'hip-hop, rap'], ['Рок', 'rock, electric guitar'], ['Электроника', 'electronic, synth'],
  ['Лоу-фай', 'lo-fi, chill'], ['R&B', 'r&b, soul'], ['Инди', 'indie'], ['Танцевальная', 'dance, edm'],
];
const MOODS = [['Весёлая', 'happy, upbeat'], ['Грустная', 'sad, melancholic'], ['Энергичная', 'energetic'], ['Спокойная', 'calm, relaxing']];
const VOICES = [['Мужской вокал', 'male vocal'], ['Женский вокал', 'female vocal']];
const LENGTHS = [[30, '30 с'], [60, '1 мин'], [120, '2 мин'], [180, '3 мин']];

const EXAMPLE = `[Verse]
Ночной город гасит окна
Мы летим по пустым дворам
Фонари считают метры
От тебя и до меня

[Chorus]
Не отпускай, пока играет бас
Эта ночь только для нас`;

function chips(name, items, multi, def = 0) {
  return `<div class="chips" data-group="${name}" data-multi="${multi ? 1 : 0}">${items.map(([label, value], i) => `
    <button type="button" class="chip-toggle ${!multi && i === def ? 'is-on' : ''}" data-value="${esc(value)}">${esc(label)}</button>`).join('')}</div>`;
}

export async function viewCreate() {
  const user = configured ? await account.user() : null;
  if (!user) {
    return `
      <header class="greet"><h1 class="greet__hi">Создать песню</h1>
        <span class="greet__sub">Нейросеть напишет музыку и споёт твой текст</span></header>
      <div class="empty">${icon('wave')}<b>Нужен аккаунт</b><span>Войди или зарегистрируйся, чтобы создавать песни</span>
        <a class="btn btn--primary" href="#/account?mode=signup">Регистрация</a></div>`;
  }
  return `
    <header class="greet">
      <h1 class="greet__hi">Создать песню ✨</h1>
      <span class="greet__sub">Нейросеть ACE-Step напишет музыку и споёт твой текст. Бесплатно.</span>
    </header>
    <form class="panel create" id="create-form">
      <div class="create__row">
        <label class="create__field"><span>Название</span>
          <input class="field" name="title" maxlength="200" required placeholder="Ночной город"></label>
        <label class="create__field"><span>Исполнитель</span>
          <input class="field" name="artist" maxlength="200" required value="${esc(account.nickname(user))}"></label>
      </div>

      <div class="create__field"><span>Жанр</span>${chips('genre', GENRES, true)}</div>
      <div class="create__field"><span>Настроение</span>${chips('mood', MOODS, true)}</div>
      <div class="create__field"><span>Голос</span>${chips('voice', VOICES, false)}</div>
      <label class="create__field"><span>Своё описание (необязательно)</span>
        <input class="field" name="caption" maxlength="300" placeholder="например: синтезаторы, 100 bpm, ночное настроение"></label>

      <div class="create__row">
        <div class="create__field"><span>Язык</span>${chips('language', [['Русский', 'ru'], ['English', 'en']], false)}</div>
        <div class="create__field"><span>Длина</span>${chips('duration', LENGTHS.map(([v, l]) => [l, String(v)]), false, 1)}</div>
      </div>

      <label class="check"><input type="checkbox" name="instrumental"> Без слов (только музыка)</label>
      <label class="create__field" id="lyrics-field"><span>Текст песни
          <button type="button" class="chip" data-example>Вставить пример</button></span>
        <textarea class="field create__lyrics" name="lyrics" maxlength="4000"
          placeholder="[Verse]&#10;Первый куплет…&#10;&#10;[Chorus]&#10;Припев…"></textarea></label>

      <p class="section__hint">Запрещённые слова (мат, наркотики, суицид) вырезаются из текста до генерации,
        а готовую песню ещё раз проверяет нейросеть. Песня появится в профиле через 10–30 минут.</p>
      <button class="btn btn--primary btn--lg btn--block">${icon('wave')}Сгенерировать песню</button>
    </form>`;
}

export function mountCreate(root) {
  const form = $('#create-form', root);
  if (!form) return;

  form.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip-toggle');
    if (chip) {
      const group = chip.parentElement;
      if (group.dataset.multi !== '1') group.querySelectorAll('.chip-toggle').forEach((c) => c.classList.remove('is-on'));
      chip.classList.toggle('is-on', group.dataset.multi === '1' ? !chip.classList.contains('is-on') : true);
    }
    if (e.target.closest('[data-example]')) form.lyrics.value = EXAMPLE;
  });
  form.instrumental.addEventListener('change', () => {
    $('#lyrics-field', form).hidden = form.instrumental.checked;
  });

  const picked = (group) => [...form.querySelectorAll(`[data-group="${group}"] .is-on`)].map((c) => c.dataset.value);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const instrumental = form.instrumental.checked;
    const lyrics = form.lyrics.value.trim();
    if (!instrumental && !lyrics) return toast('Напиши текст или включи «Без слов»');
    const caption = [...picked('genre'), ...picked('mood'), ...(instrumental ? ['instrumental'] : picked('voice')),
      form.caption.value.trim()].filter(Boolean).join(', ');
    const btn = form.querySelector('.btn--primary');
    btn.disabled = true;
    try {
      await account.requestSong({
        title: form.title.value,
        artist: form.artist.value,
        caption: caption || 'pop',
        lyrics: instrumental ? '' : lyrics,
        language: picked('language')[0] || 'ru',
        duration: Number(picked('duration')[0]) || 60,
        instrumental,
      });
      toast('Заявка принята! Песня появится в профиле');
      location.hash = '#/account';
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  });
}
