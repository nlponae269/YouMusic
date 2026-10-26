import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({
  connectionString: config.db.connectionString,
  ssl: config.db.ssl,
  max: 10,
  idleTimeoutMillis: 30_000,
});

const SCHEMA = `
create table if not exists tracks (
  id          uuid primary key,
  title       text not null,
  artist      text not null,
  album       text,
  duration    real not null default 0,
  audio_key   text not null,
  audio_type  text not null,
  cover_key   text,
  color       text not null default '#7a5cff',
  peaks       jsonb,
  lyrics      text,
  plays       integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists tracks_created_idx on tracks (created_at desc);
create index if not exists tracks_plays_idx on tracks (plays desc);

create table if not exists likes (
  client_id   text not null,
  track_id    uuid not null references tracks(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (client_id, track_id)
);

create table if not exists playlists (
  id          uuid primary key,
  client_id   text not null,
  title       text not null,
  created_at  timestamptz not null default now()
);
create index if not exists playlists_client_idx on playlists (client_id, created_at desc);

create table if not exists playlist_tracks (
  playlist_id uuid not null references playlists(id) on delete cascade,
  track_id    uuid not null references tracks(id) on delete cascade,
  added_at    timestamptz not null default now(),
  primary key (playlist_id, track_id)
);
`;

export async function migrate() {
  await pool.query(SCHEMA);
}
