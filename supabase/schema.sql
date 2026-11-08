-- supMUSIC: схема базы. Выполни целиком в Supabase → SQL Editor (можно повторно).
-- Все таблицы с префиксом sup_, поэтому с другими проектами в этой базе не конфликтуют.

create table if not exists public.sup_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.sup_tracks (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references public.sup_profiles(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  artist text not null check (char_length(artist) between 1 and 200),
  genre text,
  duration int not null default 0,
  audio_path text not null,
  cover_path text,
  plays bigint not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists sup_tracks_created_idx on public.sup_tracks (created_at desc);
create index if not exists sup_tracks_plays_idx on public.sup_tracks (plays desc);

create table if not exists public.sup_likes (
  user_id uuid not null default auth.uid() references public.sup_profiles(id) on delete cascade,
  track_id uuid not null references public.sup_tracks(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, track_id)
);

create table if not exists public.sup_playlists (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references public.sup_profiles(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 100),
  created_at timestamptz not null default now()
);

create table if not exists public.sup_playlist_tracks (
  playlist_id uuid not null references public.sup_playlists(id) on delete cascade,
  track_id uuid not null references public.sup_tracks(id) on delete cascade,
  position int not null default 0,
  primary key (playlist_id, track_id)
);

-- профиль создаётся автоматически при регистрации
create or replace function public.sup_handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.sup_profiles (id, name)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)))
  on conflict do nothing;
  return new;
end $$;
drop trigger if exists sup_on_auth_user_created on auth.users;
create trigger sup_on_auth_user_created after insert on auth.users
  for each row execute function public.sup_handle_new_user();

-- счётчик прослушиваний
create or replace function public.sup_inc_plays(track uuid) returns void
language sql security definer set search_path = public as $$
  update public.sup_tracks set plays = plays + 1 where id = track;
$$;
grant execute on function public.sup_inc_plays(uuid) to anon, authenticated;

-- права доступа (RLS)
alter table public.sup_profiles enable row level security;
alter table public.sup_tracks enable row level security;
alter table public.sup_likes enable row level security;
alter table public.sup_playlists enable row level security;
alter table public.sup_playlist_tracks enable row level security;

drop policy if exists sup_profiles_read on public.sup_profiles;
create policy sup_profiles_read on public.sup_profiles for select using (true);
drop policy if exists sup_profiles_update on public.sup_profiles;
create policy sup_profiles_update on public.sup_profiles for update using (id = auth.uid());

drop policy if exists sup_tracks_read on public.sup_tracks;
create policy sup_tracks_read on public.sup_tracks for select using (true);
drop policy if exists sup_tracks_insert on public.sup_tracks;
create policy sup_tracks_insert on public.sup_tracks for insert to authenticated with check (owner = auth.uid());
drop policy if exists sup_tracks_update on public.sup_tracks;
create policy sup_tracks_update on public.sup_tracks for update to authenticated using (owner = auth.uid());
drop policy if exists sup_tracks_delete on public.sup_tracks;
create policy sup_tracks_delete on public.sup_tracks for delete to authenticated using (owner = auth.uid());

drop policy if exists sup_likes_all on public.sup_likes;
create policy sup_likes_all on public.sup_likes for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists sup_playlists_all on public.sup_playlists;
create policy sup_playlists_all on public.sup_playlists for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());

drop policy if exists sup_pt_all on public.sup_playlist_tracks;
create policy sup_pt_all on public.sup_playlist_tracks for all to authenticated
  using (exists (select 1 from public.sup_playlists p where p.id = playlist_id and p.owner = auth.uid()))
  with check (exists (select 1 from public.sup_playlists p where p.id = playlist_id and p.owner = auth.uid()));

-- хранилище: публичные бакеты, писать можно только в свою папку <user_id>/
insert into storage.buckets (id, name, public, file_size_limit) values
  ('audio', 'audio', true, 52428800),
  ('covers', 'covers', true, 5242880)
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit;

drop policy if exists "sup upload" on storage.objects;
create policy "sup upload" on storage.objects for insert to authenticated
  with check (bucket_id in ('audio', 'covers') and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "sup delete" on storage.objects;
create policy "sup delete" on storage.objects for delete to authenticated
  using (bucket_id in ('audio', 'covers') and (storage.foldername(name))[1] = auth.uid()::text);
