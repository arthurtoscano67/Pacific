use std::sync::Arc;

use anyhow::{Context, Result};
use async_trait::async_trait;
use clap::Parser;
use diesel::sql_query;
use diesel::sql_types::{BigInt, Nullable, Text};
use diesel_async::RunQueryDsl;
use diesel_migrations::{EmbeddedMigrations, embed_migrations};
use prometheus::Registry;
use serde::Deserialize;
use serde_json::json;
use sui_indexer_alt_framework::ingestion::ClientArgs;
use sui_indexer_alt_framework::ingestion::IngestionConfig;
use sui_indexer_alt_framework::ingestion::ingestion_client::IngestionClientArgs;
use sui_indexer_alt_framework::pipeline::Processor;
use sui_indexer_alt_framework::pipeline::concurrent::ConcurrentConfig;
use sui_indexer_alt_framework::postgres::Connection;
use sui_indexer_alt_framework::postgres::DbArgs;
use sui_indexer_alt_framework::postgres::handler::Handler as PgHandler;
use sui_indexer_alt_framework::types::base_types::SuiAddress;
use sui_indexer_alt_framework::types::effects::TransactionEffectsAPI;
use sui_indexer_alt_framework::types::full_checkpoint_content::Checkpoint;
use sui_indexer_alt_framework::types::object::Owner;
use sui_indexer_alt_framework::{FieldCount, Indexer, IndexerArgs};
use tracing_subscriber::EnvFilter;
use url::Url;

pub const MIGRATIONS: EmbeddedMigrations = embed_migrations!("migrations");

#[derive(Parser, Debug)]
struct Args {
    #[arg(long, env = "DATABASE_URL")]
    database_url: Url,

    #[arg(long, env = "AVATAR_PACKAGE_ID")]
    avatar_package_id: String,

    #[arg(long, env = "SUI_RPC_API_URL", default_value = "https://fullnode.mainnet.sui.io:443")]
    rpc_api_url: Url,

    #[clap(flatten)]
    db_args: DbArgs,

    #[clap(flatten)]
    indexer_args: IndexerArgs,
}

#[derive(Clone)]
struct AvatarPipeline {
    package_id: String,
    avatar_type: String,
    minted_type: String,
    updated_type: String,
    child_attached_type: String,
    child_detached_type: String,
}

#[derive(Clone, FieldCount)]
struct IndexedMutation {
    action: String,
    wallet_address: String,
    avatar_object_id: String,
    manifest_blob_id: Option<String>,
    preview_blob_id: Option<String>,
    transaction_digest: String,
    checkpoint_sequence: i64,
    payload_json: String,
    field_name: Option<String>,
    child_object_id: Option<String>,
    child_type: Option<String>,
}

#[derive(Deserialize)]
struct AvatarMintedEvent {
    avatar_id: SuiAddress,
    owner: SuiAddress,
    manifest_blob_id: String,
    preview_blob_id: String,
    schema_version: u64,
}

#[derive(Deserialize)]
struct AvatarUpdatedEvent {
    avatar_id: SuiAddress,
    owner: SuiAddress,
    manifest_blob_id: String,
    preview_blob_id: String,
    schema_version: u64,
}

#[derive(Deserialize)]
struct AvatarChildEvent {
    avatar_id: SuiAddress,
    owner: SuiAddress,
    child_object_id: SuiAddress,
    field_name: String,
    child_type: String,
}

impl AvatarPipeline {
    fn new(package_id: String) -> Self {
        Self {
            avatar_type: format!("{package_id}::avatar::Avatar"),
            minted_type: format!("{package_id}::avatar::AvatarMinted"),
            updated_type: format!("{package_id}::avatar::AvatarUpdated"),
            child_attached_type: format!("{package_id}::avatar::AvatarChildAttached"),
            child_detached_type: format!("{package_id}::avatar::AvatarChildDetached"),
            package_id,
        }
    }
}

#[async_trait]
impl Processor for AvatarPipeline {
    const NAME: &'static str = "avatar_state";
    type Value = IndexedMutation;

    async fn process(&self, checkpoint: &Arc<Checkpoint>) -> Result<Vec<Self::Value>> {
        let checkpoint_sequence = checkpoint.summary.sequence_number as i64;
        let mut rows = Vec::new();

        for tx in &checkpoint.transactions {
            let digest = tx.effects.transaction_digest().to_string();

            if let Some(events) = &tx.events {
                for event in &events.data {
                    let event_type = event.type_.to_canonical_string(true);
                    if event.package_id.to_canonical_string(true) != self.package_id {
                        continue;
                    }

                    if event_type == self.minted_type {
                        let decoded: AvatarMintedEvent =
                            bcs::from_bytes(&event.contents).context("decode AvatarMinted")?;
                        rows.push(IndexedMutation {
                            action: "mint".to_string(),
                            wallet_address: decoded.owner.to_string(),
                            avatar_object_id: decoded.avatar_id.to_string(),
                            manifest_blob_id: Some(decoded.manifest_blob_id),
                            preview_blob_id: Some(decoded.preview_blob_id),
                            transaction_digest: digest.clone(),
                            checkpoint_sequence,
                            payload_json: json!({ "schemaVersion": decoded.schema_version }).to_string(),
                            field_name: None,
                            child_object_id: None,
                            child_type: None,
                        });
                    } else if event_type == self.updated_type {
                        let decoded: AvatarUpdatedEvent =
                            bcs::from_bytes(&event.contents).context("decode AvatarUpdated")?;
                        rows.push(IndexedMutation {
                            action: "update".to_string(),
                            wallet_address: decoded.owner.to_string(),
                            avatar_object_id: decoded.avatar_id.to_string(),
                            manifest_blob_id: Some(decoded.manifest_blob_id),
                            preview_blob_id: Some(decoded.preview_blob_id),
                            transaction_digest: digest.clone(),
                            checkpoint_sequence,
                            payload_json: json!({ "schemaVersion": decoded.schema_version }).to_string(),
                            field_name: None,
                            child_object_id: None,
                            child_type: None,
                        });
                    } else if event_type == self.child_attached_type {
                        let decoded: AvatarChildEvent =
                            bcs::from_bytes(&event.contents).context("decode AvatarChildAttached")?;
                        rows.push(IndexedMutation {
                            action: "child-attach".to_string(),
                            wallet_address: decoded.owner.to_string(),
                            avatar_object_id: decoded.avatar_id.to_string(),
                            manifest_blob_id: None,
                            preview_blob_id: None,
                            transaction_digest: digest.clone(),
                            checkpoint_sequence,
                            payload_json: "{}".to_string(),
                            field_name: Some(decoded.field_name),
                            child_object_id: Some(decoded.child_object_id.to_string()),
                            child_type: Some(decoded.child_type),
                        });
                    } else if event_type == self.child_detached_type {
                        let decoded: AvatarChildEvent =
                            bcs::from_bytes(&event.contents).context("decode AvatarChildDetached")?;
                        rows.push(IndexedMutation {
                            action: "child-detach".to_string(),
                            wallet_address: decoded.owner.to_string(),
                            avatar_object_id: decoded.avatar_id.to_string(),
                            manifest_blob_id: None,
                            preview_blob_id: None,
                            transaction_digest: digest.clone(),
                            checkpoint_sequence,
                            payload_json: "{}".to_string(),
                            field_name: Some(decoded.field_name),
                            child_object_id: Some(decoded.child_object_id.to_string()),
                            child_type: Some(decoded.child_type),
                        });
                    }
                }
            }

            for output in tx.output_objects(&checkpoint.object_set) {
                let Some(move_type) = output.type_() else {
                    continue;
                };

                if move_type.to_canonical_string(true) != self.avatar_type {
                    continue;
                }

                let Some(new_owner) = owner_as_address(output.owner()) else {
                    continue;
                };

                let old_owner = tx
                    .input_objects(&checkpoint.object_set)
                    .find(|candidate| candidate.id() == output.id())
                    .and_then(|object| owner_as_address(object.owner()));

                if let Some(old_owner) = old_owner {
                    if old_owner != new_owner {
                        rows.push(IndexedMutation {
                            action: "transfer".to_string(),
                            wallet_address: new_owner.to_string(),
                            avatar_object_id: output.id().to_canonical_string(true),
                            manifest_blob_id: None,
                            preview_blob_id: None,
                            transaction_digest: digest.clone(),
                            checkpoint_sequence,
                            payload_json: json!({
                                "previousOwner": old_owner.to_string(),
                                "nextOwner": new_owner.to_string()
                            })
                            .to_string(),
                            field_name: None,
                            child_object_id: None,
                            child_type: None,
                        });
                    }
                }
            }
        }

        Ok(rows)
    }
}

#[async_trait]
impl PgHandler for AvatarPipeline {
    async fn commit<'a>(values: &[Self::Value], conn: &mut Connection<'a>) -> Result<usize> {
        let mut applied = 0usize;

        for value in values {
            match value.action.as_str() {
                "mint" | "update" => {
                    upsert_avatar_state(conn, value).await?;
                    upsert_active_wallet(conn, value).await?;
                    insert_history(conn, value).await?;
                    applied += 1;
                }
                "transfer" => {
                    apply_transfer(conn, value).await?;
                    insert_history(conn, value).await?;
                    applied += 1;
                }
                "child-attach" => {
                    attach_child(conn, value).await?;
                    insert_history(conn, value).await?;
                    applied += 1;
                }
                "child-detach" => {
                    detach_child(conn, value).await?;
                    insert_history(conn, value).await?;
                    applied += 1;
                }
                _ => {}
            }
        }

        Ok(applied)
    }
}

fn owner_as_address(owner: &Owner) -> Option<SuiAddress> {
    match owner {
        Owner::AddressOwner(address) => Some(*address),
        _ => None,
    }
}

async fn upsert_avatar_state<'a>(conn: &mut Connection<'a>, value: &IndexedMutation) -> Result<()> {
    sql_query(
        "insert into avatar_object_state (
            avatar_object_id,
            wallet_address,
            manifest_blob_id,
            preview_blob_id,
            updated_at,
            checkpoint_sequence,
            transaction_digest
         ) values ($1, $2, $3, $4, now(), $5, $6)
         on conflict (avatar_object_id) do update
         set wallet_address = excluded.wallet_address,
             manifest_blob_id = excluded.manifest_blob_id,
             preview_blob_id = excluded.preview_blob_id,
             updated_at = excluded.updated_at,
             checkpoint_sequence = excluded.checkpoint_sequence,
             transaction_digest = excluded.transaction_digest",
    )
    .bind::<Text, _>(&value.avatar_object_id)
    .bind::<Text, _>(&value.wallet_address)
    .bind::<Text, _>(value.manifest_blob_id.as_deref().unwrap_or_default())
    .bind::<Text, _>(value.preview_blob_id.as_deref().unwrap_or_default())
    .bind::<BigInt, _>(value.checkpoint_sequence)
    .bind::<Text, _>(&value.transaction_digest)
    .execute(conn)
    .await?;

    Ok(())
}

async fn upsert_active_wallet<'a>(conn: &mut Connection<'a>, value: &IndexedMutation) -> Result<()> {
    sql_query(
        "insert into avatar_active_wallet (
            wallet_address,
            avatar_object_id,
            manifest_blob_id,
            updated_at,
            checkpoint_sequence,
            transaction_digest
         ) values ($1, $2, $3, now(), $4, $5)
         on conflict (wallet_address) do update
         set avatar_object_id = excluded.avatar_object_id,
             manifest_blob_id = excluded.manifest_blob_id,
             updated_at = excluded.updated_at,
             checkpoint_sequence = excluded.checkpoint_sequence,
             transaction_digest = excluded.transaction_digest",
    )
    .bind::<Text, _>(&value.wallet_address)
    .bind::<Text, _>(&value.avatar_object_id)
    .bind::<Text, _>(value.manifest_blob_id.as_deref().unwrap_or_default())
    .bind::<BigInt, _>(value.checkpoint_sequence)
    .bind::<Text, _>(&value.transaction_digest)
    .execute(conn)
    .await?;

    Ok(())
}

async fn apply_transfer<'a>(conn: &mut Connection<'a>, value: &IndexedMutation) -> Result<()> {
    let payload: serde_json::Value = serde_json::from_str(&value.payload_json)?;
    let previous_owner = payload
        .get("previousOwner")
        .and_then(|value| value.as_str())
        .unwrap_or_default();

    sql_query(
        "update avatar_object_state
         set wallet_address = $1,
             updated_at = now(),
             checkpoint_sequence = $2,
             transaction_digest = $3
         where avatar_object_id = $4",
    )
    .bind::<Text, _>(&value.wallet_address)
    .bind::<BigInt, _>(value.checkpoint_sequence)
    .bind::<Text, _>(&value.transaction_digest)
    .bind::<Text, _>(&value.avatar_object_id)
    .execute(conn)
    .await?;

    if !previous_owner.is_empty() {
        sql_query(
            "delete from avatar_active_wallet
             where wallet_address = $1
               and avatar_object_id = $2",
        )
        .bind::<Text, _>(previous_owner)
        .bind::<Text, _>(&value.avatar_object_id)
        .execute(conn)
        .await?;
    }

    sql_query(
        "insert into avatar_active_wallet (
            wallet_address,
            avatar_object_id,
            manifest_blob_id,
            updated_at,
            checkpoint_sequence,
            transaction_digest
         )
         select $1, avatar_object_id, manifest_blob_id, now(), $2, $3
         from avatar_object_state
         where avatar_object_id = $4
         on conflict (wallet_address) do update
         set avatar_object_id = excluded.avatar_object_id,
             manifest_blob_id = excluded.manifest_blob_id,
             updated_at = excluded.updated_at,
             checkpoint_sequence = excluded.checkpoint_sequence,
             transaction_digest = excluded.transaction_digest",
    )
    .bind::<Text, _>(&value.wallet_address)
    .bind::<BigInt, _>(value.checkpoint_sequence)
    .bind::<Text, _>(&value.transaction_digest)
    .bind::<Text, _>(&value.avatar_object_id)
    .execute(conn)
    .await?;

    Ok(())
}

async fn attach_child<'a>(conn: &mut Connection<'a>, value: &IndexedMutation) -> Result<()> {
    sql_query(
        "insert into avatar_child_objects (
            avatar_object_id,
            field_name,
            child_object_id,
            child_type,
            attached_at,
            detached_at
         ) values ($1, $2, $3, $4, now(), null)
         on conflict (avatar_object_id, field_name, child_object_id) do update
         set child_type = excluded.child_type,
             attached_at = excluded.attached_at,
             detached_at = null",
    )
    .bind::<Text, _>(&value.avatar_object_id)
    .bind::<Text, _>(value.field_name.as_deref().unwrap_or_default())
    .bind::<Text, _>(value.child_object_id.as_deref().unwrap_or_default())
    .bind::<Text, _>(value.child_type.as_deref().unwrap_or_default())
    .execute(conn)
    .await?;

    Ok(())
}

async fn detach_child<'a>(conn: &mut Connection<'a>, value: &IndexedMutation) -> Result<()> {
    sql_query(
        "update avatar_child_objects
         set detached_at = now()
         where avatar_object_id = $1
           and field_name = $2
           and child_object_id = $3",
    )
    .bind::<Text, _>(&value.avatar_object_id)
    .bind::<Text, _>(value.field_name.as_deref().unwrap_or_default())
    .bind::<Text, _>(value.child_object_id.as_deref().unwrap_or_default())
    .execute(conn)
    .await?;

    Ok(())
}

async fn insert_history<'a>(conn: &mut Connection<'a>, value: &IndexedMutation) -> Result<()> {
    sql_query(
        "insert into avatar_history (
            wallet_address,
            avatar_object_id,
            manifest_blob_id,
            action,
            transaction_digest,
            checkpoint_sequence,
            event_payload
         ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)",
    )
    .bind::<Text, _>(&value.wallet_address)
    .bind::<Text, _>(&value.avatar_object_id)
    .bind::<Nullable<Text>, _>(value.manifest_blob_id.as_deref())
    .bind::<Text, _>(&value.action)
    .bind::<Text, _>(&value.transaction_digest)
    .bind::<BigInt, _>(value.checkpoint_sequence)
    .bind::<Text, _>(&value.payload_json)
    .execute(conn)
    .await?;

    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let args = Args::parse();
    let registry = Registry::new();

    let mut indexer = Indexer::new_from_pg(
        args.database_url,
        args.db_args,
        args.indexer_args,
        ClientArgs {
            ingestion: IngestionClientArgs {
                rpc_api_url: Some(args.rpc_api_url),
                ..Default::default()
            },
            ..Default::default()
        },
        IngestionConfig::default(),
        Some(&MIGRATIONS),
        Some("pacific"),
        &registry,
    )
    .await?;

    indexer
        .concurrent_pipeline(AvatarPipeline::new(args.avatar_package_id), ConcurrentConfig::default())
        .await?;

    indexer.run().await?.join().await?;
    Ok(())
}
