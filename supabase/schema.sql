-- YouMusic: база, хранилище и права доступа в Supabase.
-- Вставить целиком в Supabase → SQL Editor → New query → Run. Повторный запуск безопасен.

-- ---------- Треки ----------
create table if not exists public.tracks (
  id            uuid primary key default gen_random_uuid(),
  owner         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  uploader      text,
  title         text not null check (char_length(title) between 1 and 200),
  artist        text not null check (char_length(artist) between 1 and 200),
  album         text check (char_length(album) <= 200),
  lyrics        text check (char_length(lyrics) <= 20000),
  -- pending → processing → ready | failed
  status        text not null default 'pending' check (status in ('pending', 'processing', 'ready', 'failed')),
  error         text,
  source_path   text not null,   -- оригинал в приватном бакете incoming: <uid>/<id>.<ext>
  cover_source  text,            -- обложка в incoming (необязательно)
  audio_path    text,            -- отцензуренная версия в публичном бакете tracks
  cover_path    text,
  duration      real,
  color         text,
  peaks         jsonb,
  censored      integer not null default 0,
  processing_started timestamptz,
  created_at    timestamptz not null default now(),
  published_at  timestamptz
);
alter table public.tracks add column if not exists processing_started timestamptz;
alter table public.tracks add column if not exists has_lyrics boolean generated always as (coalesce(lyrics, '') <> '') stored;
create index if not exists tracks_status_idx on public.tracks (status, published_at desc);
create index if not exists tracks_owner_idx on public.tracks (owner, created_at desc);

-- Администраторы сайта (могут удалять любые треки)
create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- Защита от спама: не больше 20 загрузок в сутки на пользователя
create or replace function public.uploads_today() returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.tracks
  where owner = auth.uid() and created_at > now() - interval '1 day';
$$;

alter table public.tracks enable row level security;
alter table public.admins enable row level security;

drop policy if exists "tracks: читать опубликованные и свои" on public.tracks;
create policy "tracks: читать опубликованные и свои" on public.tracks
  for select using (status = 'ready' or owner = auth.uid() or public.is_admin());

-- Пользователь может только поставить трек в очередь; публикует его обработчик модерации
drop policy if exists "tracks: загружать свои" on public.tracks;
create policy "tracks: загружать свои" on public.tracks
  for insert to authenticated with check (
    owner = auth.uid()
    and status = 'pending'
    and audio_path is null and cover_path is null and peaks is null and published_at is null
    and split_part(source_path, '/', 1) = auth.uid()::text
    and (cover_source is null or split_part(cover_source, '/', 1) = auth.uid()::text)
    and public.uploads_today() < 20
  );

drop policy if exists "tracks: удалять свои" on public.tracks;
create policy "tracks: удалять свои" on public.tracks
  for delete to authenticated using (owner = auth.uid() or public.is_admin());

-- ---------- Хранилище ----------
-- incoming — приватный, сюда браузер загружает оригиналы (до 50 МБ)
-- tracks   — публичный, сюда обработчик кладёт отцензуренные треки и обложки
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('incoming', 'incoming', false, 52428800, array['audio/*', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public)
values ('tracks', 'tracks', true)
on conflict (id) do update set public = true;

drop policy if exists "incoming: загрузка в свою папку" on storage.objects;
create policy "incoming: загрузка в свою папку" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'incoming' and (storage.foldername(name))[1] = auth.uid()::text);
