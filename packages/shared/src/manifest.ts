import { z } from "zod";
import {
  READY_AVATAR_MANIFEST_MIME,
  READY_AVATAR_NETWORK,
  READY_AVATAR_PREVIEW_MIME,
  READY_AVATAR_RUNTIME_FORMAT,
  READY_AVATAR_RUNTIME_SKELETON,
  READY_AVATAR_SCHEMA,
  READY_AVATAR_TYPE,
  READY_AVATAR_VRM_MIME,
} from "./constants.js";

const walrusAssetSchema = z.object({
  blobId: z.string().min(1),
  blobObjectId: z.string().startsWith("0x").nullable().optional(),
  mime: z.string().min(1),
  filename: z.string().min(1),
  size: z.number().int().nonnegative(),
});

const runtimeAvatarVrmSchema = walrusAssetSchema.extend({
  mime: z.literal(READY_AVATAR_VRM_MIME),
  filename: z.string().toLowerCase().endsWith(".vrm"),
  format: z.literal(READY_AVATAR_RUNTIME_FORMAT),
});

const runtimeAvatarSchema = walrusAssetSchema.extend({
  format: z.string().min(1),
});

const previewAssetSchema = walrusAssetSchema.extend({
  mime: z.literal(READY_AVATAR_PREVIEW_MIME),
  filename: z.string().toLowerCase().endsWith(".png"),
});

export const shooterStatsSchema = z.object({
  wins: z.number().int().nonnegative().default(0),
  losses: z.number().int().nonnegative().default(0),
  hp: z.number().int().nonnegative().max(500).default(100),
});

export const shooterCharacterSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  prefabResource: z.string().min(1),
  role: z.string().min(1).optional(),
  source: z.enum(["preset", "uploaded-file"]).default("preset"),
  runtimeAssetMime: z.string().min(1).optional(),
  runtimeAssetFilename: z.string().min(1).optional(),
});

export const shooterGameMetadataSchema = z.object({
  mode: z.literal("shooter"),
  package: z.string().min(1).optional(),
  character: shooterCharacterSchema,
  multiplayer: z
    .object({
      maxPlayers: z.number().int().positive(),
      maxConcurrentMatches: z.number().int().positive().optional(),
      tickRate: z.number().int().positive().optional(),
    })
    .optional(),
  stats: shooterStatsSchema.default({
    wins: 0,
    losses: 0,
    hp: 100,
  }),
});

const animationReferenceSchema = z
  .object({
    name: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    blobId: z.string().min(1).optional(),
    blobObjectId: z.string().startsWith("0x").nullable().optional(),
    mime: z.string().min(1).optional(),
    filename: z.string().min(1).optional(),
  })
  .refine((value) => Boolean(value.url || value.blobId), {
    message: "Animation references require a url or blobId.",
  });

const legacyReadyAvatarManifestSchema = z.object({
  schema: z.literal("ready-avatar/1.0"),
  type: z.literal("vrm-avatar"),
  name: z.string().min(1),
  owner: z.string().startsWith("0x"),
  network: z.literal(READY_AVATAR_NETWORK),
  avatarObjectId: z.string().startsWith("0x").optional(),
  assets: z.object({
    avatar: z.object({
      blobId: z.string().min(1),
      mime: z.literal(READY_AVATAR_VRM_MIME),
      filename: z.string().toLowerCase().endsWith(".vrm"),
    }),
    preview: z.object({
      blobId: z.string().min(1),
      mime: z.literal(READY_AVATAR_PREVIEW_MIME),
      filename: z.string().toLowerCase().endsWith(".png"),
    }),
  }),
  runtime: z.object({
    format: z.literal(READY_AVATAR_RUNTIME_FORMAT),
    skeleton: z.literal(READY_AVATAR_RUNTIME_SKELETON),
    playable: z.literal(true),
  }),
  storage: z.object({
    blobObjectId: z.string().startsWith("0x"),
    epochs: z.number().int().positive(),
  }),
});

export const readyAvatarManifestSchema = z
  .object({
    schema: z.literal(READY_AVATAR_SCHEMA),
    type: z.literal(READY_AVATAR_TYPE),
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    owner: z.string().startsWith("0x"),
    network: z.literal(READY_AVATAR_NETWORK),
    sourceAsset: walrusAssetSchema.nullable().optional(),
    runtimeAvatar: runtimeAvatarSchema,
    preview: previewAssetSchema,
    animations: z
      .object({
        idle: animationReferenceSchema.optional(),
        walk: animationReferenceSchema.optional(),
        run: animationReferenceSchema.optional(),
        jump: animationReferenceSchema.optional(),
      })
      .optional(),
    game: shooterGameMetadataSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.game?.mode === "shooter") {
      return;
    }

    const runtimeAvatarResult = runtimeAvatarVrmSchema.safeParse(value.runtimeAvatar);
    if (!runtimeAvatarResult.success) {
      for (const issue of runtimeAvatarResult.error.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["runtimeAvatar", ...issue.path],
          message: issue.message,
        });
      }
    }
  });

export const walletSessionRequestSchema = z.object({
  address: z.string().startsWith("0x"),
  message: z.string().min(1),
  signature: z.string().min(1),
});

export const uploadIntentSchema = z.object({
  filename: z.string().min(1),
  kind: z.enum(["avatar", "preview", "manifest", "source-asset", "generic-asset"]),
  size: z.number().int().positive(),
  mime: z.string().min(1),
});

export const manifestRecordSchema = z.object({
  avatarBlobId: z.string().min(1),
  avatarBlobObjectId: z.string().startsWith("0x"),
  sourceAssetBlobId: z.string().min(1).nullable().optional(),
  sourceAssetBlobObjectId: z.string().startsWith("0x").nullable().optional(),
  previewBlobId: z.string().min(1),
  previewBlobObjectId: z.string().startsWith("0x"),
  manifestBlobId: z.string().min(1),
  manifestBlobObjectId: z.string().startsWith("0x"),
  avatarObjectId: z.string().startsWith("0x"),
  transactionDigest: z.string().optional(),
  epochs: z.number().int().positive(),
  runtimeReady: z.boolean().default(false),
});

export const walrusCachedBlobSchema = z.object({
  blobId: z.string().min(1),
  contentType: z.string().min(1),
  body: z.instanceof(Uint8Array),
});

export const manifestUploadEnvelopeSchema = z.object({
  manifest: readyAvatarManifestSchema,
  mime: z.literal(READY_AVATAR_MANIFEST_MIME),
});

export type ReadyAvatarManifest = z.infer<typeof readyAvatarManifestSchema>;
export type ShooterStats = z.infer<typeof shooterStatsSchema>;
export type ShooterCharacter = z.infer<typeof shooterCharacterSchema>;
export type ShooterGameMetadata = z.infer<typeof shooterGameMetadataSchema>;
export type WalletSessionRequest = z.infer<typeof walletSessionRequestSchema>;
export type UploadIntentRequest = z.infer<typeof uploadIntentSchema>;
export type ManifestRecord = z.infer<typeof manifestRecordSchema>;

export function parseReadyAvatarManifest(payload: unknown): ReadyAvatarManifest {
  const current = readyAvatarManifestSchema.safeParse(payload);
  if (current.success) {
    return current.data;
  }

  const legacy = legacyReadyAvatarManifestSchema.safeParse(payload);
  if (legacy.success) {
    return {
      schema: READY_AVATAR_SCHEMA,
      type: READY_AVATAR_TYPE,
      name: legacy.data.name,
      owner: legacy.data.owner,
      network: legacy.data.network,
      sourceAsset: null,
      runtimeAvatar: {
        blobId: legacy.data.assets.avatar.blobId,
        blobObjectId: legacy.data.storage.blobObjectId,
        mime: legacy.data.assets.avatar.mime,
        filename: legacy.data.assets.avatar.filename,
        size: 0,
        format: READY_AVATAR_RUNTIME_FORMAT,
      },
      preview: {
        blobId: legacy.data.assets.preview.blobId,
        blobObjectId: null,
        mime: legacy.data.assets.preview.mime,
        filename: legacy.data.assets.preview.filename,
        size: 0,
      },
    };
  }

  throw current.error;
}
