import postgres, { type Sql } from "postgres";
import { apiConfig } from "./config.js";

export type Database = Sql<{}>;
export type OptionalDatabase = Database | null;

export function createDatabase() {
  if (!apiConfig.DATABASE_URL) {
    return null;
  }

  return postgres(apiConfig.DATABASE_URL, {
    max: 10,
    idle_timeout: 20,
  });
}

export async function initDatabase(sql: OptionalDatabase) {
  if (!sql) {
    return;
  }

  await sql`
    create table if not exists avatar_sessions (
      token_hash text primary key,
      wallet_address text not null,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null
    )
  `;

  await sql`
    create index if not exists avatar_sessions_wallet_idx
    on avatar_sessions (wallet_address)
  `;

  await sql`
    create table if not exists avatar_upload_intents (
      id uuid primary key,
      wallet_address text not null,
      kind text not null,
      filename text not null,
      size_bytes bigint not null,
      mime text not null,
      status text not null default 'requested',
      created_at timestamptz not null default now(),
      expires_at timestamptz not null
    )
  `;

  await sql`
    create table if not exists avatar_manifests (
      manifest_blob_id text primary key,
      wallet_address text not null,
      avatar_blob_id text not null,
      avatar_blob_object_id text not null,
      preview_blob_id text not null,
      preview_blob_object_id text not null,
      manifest_blob_object_id text not null,
      avatar_object_id text not null,
      transaction_digest text,
      manifest_json jsonb not null,
      epochs integer not null,
      validation_status text not null default 'stored',
      validation_errors jsonb not null default '[]'::jsonb,
      runtime_ready boolean not null default false,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;

  await sql`
    create index if not exists avatar_manifests_wallet_idx
    on avatar_manifests (wallet_address)
  `;

  await sql`
    create table if not exists walrus_blob_cache (
      blob_id text primary key,
      content_type text not null,
      body bytea not null,
      cached_at timestamptz not null default now()
    )
  `;

  await sql`
    create table if not exists avatar_active_wallet (
      wallet_address text primary key,
      avatar_object_id text not null,
      manifest_blob_id text not null,
      updated_at timestamptz not null default now(),
      checkpoint_sequence bigint,
      transaction_digest text
    )
  `;

  await sql`
    create table if not exists avatar_object_state (
      avatar_object_id text primary key,
      wallet_address text not null,
      manifest_blob_id text not null,
      preview_blob_id text not null,
      updated_at timestamptz not null default now(),
      checkpoint_sequence bigint,
      transaction_digest text
    )
  `;

  await sql`
    create table if not exists avatar_history (
      id bigserial primary key,
      wallet_address text not null,
      avatar_object_id text not null,
      manifest_blob_id text,
      action text not null,
      transaction_digest text,
      checkpoint_sequence bigint,
      event_payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    )
  `;

  await sql`
    create table if not exists avatar_child_objects (
      avatar_object_id text not null,
      field_name text not null,
      child_object_id text not null,
      child_type text not null,
      attached_at timestamptz not null default now(),
      detached_at timestamptz,
      primary key (avatar_object_id, field_name, child_object_id)
    )
  `;

  await sql`
    create table if not exists walrus_asset_expiry (
      blob_object_id text primary key,
      blob_id text not null,
      wallet_address text not null,
      start_epoch bigint,
      end_epoch bigint,
      deletable boolean,
      updated_at timestamptz not null default now()
    )
  `;

  await sql`
    alter table walrus_asset_expiry
    add column if not exists start_epoch bigint
  `;

  await sql`
    alter table walrus_asset_expiry
    add column if not exists end_epoch bigint
  `;

  await sql`
    alter table walrus_asset_expiry
    add column if not exists deletable boolean
  `;

  await sql`
    create table if not exists avatar_shooter_stats (
      avatar_object_id text primary key,
      wallet_address text not null,
      wins integer not null default 0,
      losses integer not null default 0,
      hp integer not null default 100,
      updated_at timestamptz not null default now()
    )
  `;

  await sql`
    create index if not exists avatar_shooter_stats_wallet_idx
    on avatar_shooter_stats (wallet_address)
  `;

  await sql`
    create table if not exists avatar_shooter_matches (
      id bigserial primary key,
      match_id text,
      winner_avatar_object_id text not null,
      loser_avatar_object_id text not null,
      winner_wallet_address text,
      loser_wallet_address text,
      winner_hp integer not null default 100,
      loser_hp integer not null default 0,
      created_at timestamptz not null default now()
    )
  `;

  await sql`
    create table if not exists avatar_shooter_match_results (
      id bigserial primary key,
      match_id text,
      avatar_object_id text not null,
      wallet_address text not null,
      result text not null,
      hp integer not null default 100,
      created_at timestamptz not null default now()
    )
  `;
}
