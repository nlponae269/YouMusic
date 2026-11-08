# supMUSIC

Музыкальный стриминг в духе Яндекс Музыки: «Моя волна», поиск по трекам и жанрам, лайки, плейлисты, загрузка своих треков, плеер с очередью, перемешиванием и повтором. Сайт на **GitHub Pages**, аккаунты, база и файлы в **Supabase**.

## Запуск

1. В Supabase откройте **SQL Editor** и выполните [`supabase/schema.sql`](supabase/schema.sql): таблицы, права и хранилище для треков и обложек.
2. В репозитории, в **Settings → Secrets and variables → Actions**, должны быть секреты `SUPABASE_URL` и `SUPABASE_ANON_KEY` (Project Settings → API в Supabase).
3. **Settings → Pages → Source: GitHub Actions**. Сайт публикуется при каждом пуше в основную ветку, секреты подставляются в `public/config.js` во время сборки.
4. В Supabase → Authentication можно отключить подтверждение почты, если не нужно письмо при регистрации.

Локально: впишите URL и ключ в `public/config.js` и откройте `public/` любым статическим сервером (`python3 -m http.server -d public`). Файл с ключами не коммитьте.
