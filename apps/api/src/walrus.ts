import { Buffer } from "node:buffer";
import { LRUCache } from "lru-cache";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { walrus } from "@mysten/walrus";
import { READY_AVATAR_MANIFEST_MIME, READY_AVATAR_PREVIEW_MIME, READY_AVATAR_VRM_MIME } from "@pacific/shared";
import type { OptionalDatabase } from "./db.js";
import { apiConfig } from "./config.js";

const suiClient = new SuiGrpcClient({
  network: apiConfig.SUI_NETWORK,
  baseUrl: apiConfig.SUI_GRPC_URL,
}).$extend(walrus());

const memoryCache = new LRUCache<string, { body: Buffer; contentType: string }>({
  max: 200,
  ttl: apiConfig.WALRUS_READ_CACHE_TTL_MS,
});

export async function readBlobFromGateway(
  sql: OptionalDatabase,
  blobId: string,
  contentTypeHint?: string,
) {
  const cached = memoryCache.get(blobId);
  if (cached) {
    return cached;
  }

  if (sql) {
    const rows = await sql`
      select content_type, body
      from walrus_blob_cache
      where blob_id = ${blobId}
        and cached_at > now() - (${apiConfig.WALRUS_READ_CACHE_TTL_MS} * interval '1 millisecond')
      limit 1
    `;

    if (rows.length > 0) {
      const dbRow = rows[0] as { content_type: string; body: Buffer };
      const result = { body: dbRow.body, contentType: dbRow.content_type };
      memoryCache.set(blobId, result);
      return result;
    }
  }

  const bytes = await suiClient.walrus.readBlob({ blobId });
  const result = {
    body: Buffer.from(bytes),
    contentType: contentTypeHint ?? "application/octet-stream",
  };

  memoryCache.set(blobId, result);
  if (sql) {
    await sql`
      insert into walrus_blob_cache (blob_id, content_type, body, cached_at)
      values (${blobId}, ${result.contentType}, ${result.body}, now())
      on conflict (blob_id) do update
      set content_type = excluded.content_type,
          body = excluded.body,
          cached_at = excluded.cached_at
    `;
  }

  return result;
}

export async function resolveBlobContentType(sql: OptionalDatabase, blobId: string) {
  if (!sql) {
    return "application/octet-stream";
  }

  const manifestRows = await sql`
      select
        case
          when avatar_blob_id = ${blobId} then ${READY_AVATAR_VRM_MIME}
          when preview_blob_id = ${blobId} then ${READY_AVATAR_PREVIEW_MIME}
          when manifest_blob_id = ${blobId} then ${READY_AVATAR_MANIFEST_MIME}
          else null
        end as content_type
      from avatar_manifests
      where avatar_blob_id = ${blobId}
         or preview_blob_id = ${blobId}
         or manifest_blob_id = ${blobId}
      limit 1
    `;

  const row = manifestRows[0] as { content_type: string | null } | undefined;
  return row?.content_type ?? "application/octet-stream";
}
