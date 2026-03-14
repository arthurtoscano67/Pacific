create table if not exists avatar_active_wallet (
  wallet_address text primary key,
  avatar_object_id text not null,
  manifest_blob_id text not null,
  updated_at timestamptz not null default now(),
  checkpoint_sequence bigint,
  transaction_digest text
);

create table if not exists avatar_object_state (
  avatar_object_id text primary key,
  wallet_address text not null,
  manifest_blob_id text not null,
  preview_blob_id text not null,
  updated_at timestamptz not null default now(),
  checkpoint_sequence bigint,
  transaction_digest text
);

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
);

create table if not exists avatar_child_objects (
  avatar_object_id text not null,
  field_name text not null,
  child_object_id text not null,
  child_type text not null,
  attached_at timestamptz not null default now(),
  detached_at timestamptz,
  primary key (avatar_object_id, field_name, child_object_id)
);

create index if not exists avatar_history_wallet_idx
on avatar_history (wallet_address, created_at desc);

create index if not exists avatar_history_avatar_idx
on avatar_history (avatar_object_id, created_at desc);
