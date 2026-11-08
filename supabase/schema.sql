-- supMUSIC: схема базы. Выполни целиком в Supabase → SQL Editor (можно повторно).

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.tracks (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  artist text not null check (char_length(artist) between 1 and 200),
  genre text,
  duration int not null default 0,
  audio_path text not null,
  cover_path text,
  plays bigint not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists tracks_created_idx on public.tracks (created_at desc);
create index if not exists tracks_plays_idx on public.tracks (plays desc);

create table if not exists public.likes (
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  track_id uuid not null references public.tracks(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, track_id)
);

create table if not exists public.playlists (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 100),
  created_at timestamptz not null default now()
);

create table if not exists public.playlist_tracks (
  playlist_id uuid not null references public.playlists(id) on delete cascade,
  track_id uuid not null references public.tracks(id) on delete cascade,
  position int not null default 0,
  primary key (playlist_id, track_id)
);

-- профиль создаётся автоматически при регистрации
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)))
  on conflict do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- счётчик прослушиваний
create or replace function public.inc_plays(track uuid) returns void
language sql security definer set search_path = public as $$
  update public.tracks set plays = plays + 1 where id = track;
$$;
grant execute on function public.inc_plays(uuid) to anon, authenticated;

-- права доступа (RLS)
alter table public.profiles enable row level security;
alter table public.tracks enable row level security;
alter table public.likes enable row level security;
alter table public.playlists enable row level security;
alter table public.playlist_tracks enable row level security;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select using (true);
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update using (id = auth.uid());

drop policy if exists tracks_read on public.tracks;
create policy tracks_read on public.tracks for select using (true);
drop policy if exists tracks_insert on public.tracks;
create policy tracks_insert on public.tracks for insert to authenticated with check (owner = auth.uid());
drop policy if exists tracks_update on public.tracks;
create policy tracks_update on public.tracks for update to authenticated using (owner = auth.uid());
drop policy if exists tracks_delete on public.tracks;
create policy tracks_delete on public.tracks for delete to authenticated using (owner = auth.uid());

drop policy if exists likes_all on public.likes;
create policy likes_all on public.likes for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists playlists_all on public.playlists;
create policy playlists_all on public.playlists for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());

drop policy if exists pt_all on public.playlist_tracks;
create policy pt_all on public.playlist_tracks for all to authenticated
  using (exists (select 1 from public.playlists p where p.id = playlist_id and p.owner = auth.uid()))
  with check (exists (select 1 from public.playlists p where p.id = playlist_id and p.owner = auth.uid()));

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
