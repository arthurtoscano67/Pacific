import { z } from "zod";
import {
  READY_AVATAR_DEFAULT_EPOCHS,
  READY_AVATAR_DEFAULT_MAX_RUNTIME_AVATAR_BYTES,
  READY_AVATAR_DEFAULT_MAX_SOURCE_ASSET_BYTES,
} from "@pacific/shared";

const envSchema = z.object({
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().default(3001),
  APP_ORIGIN: z.string().default("http://127.0.0.1:4173"),
  PROJECT_URL: z.string().default("https://pacific.ready-avatar.local"),
  DATABASE_URL: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed && trimmed.length > 0 ? trimmed : null;
    }),
  SUI_GRPC_URL: z.string().default("https://fullnode.mainnet.sui.io:443"),
  SUI_NETWORK: z.literal("mainnet").default("mainnet"),
  WALRUS_UPLOAD_RELAY_URL: z.string().default("https://upload-relay.mainnet.walrus.space"),
  WALRUS_READ_CACHE_TTL_MS: z.coerce.number().int().positive().default(300_000),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24),
  MAX_RUNTIME_AVATAR_FILE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(READY_AVATAR_DEFAULT_MAX_RUNTIME_AVATAR_BYTES),
  MAX_SOURCE_ASSET_FILE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(READY_AVATAR_DEFAULT_MAX_SOURCE_ASSET_BYTES),
  WALRUS_EPOCHS: z.coerce.number().int().positive().default(READY_AVATAR_DEFAULT_EPOCHS),
  SHOOTER_MAX_PLAYERS_PER_MATCH: z.coerce.number().int().positive().default(64),
  SHOOTER_MAX_CONCURRENT_MATCHES: z.coerce.number().int().positive().default(512),
  SHOOTER_SERVER_TICK_RATE: z.coerce.number().int().positive().default(30),
  SHOOTER_DEFAULT_HP: z.coerce.number().int().positive().default(100),
  AVATAR_PACKAGE_ID: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed && trimmed.length > 0 ? trimmed : null;
    }),
});

export const apiConfig = envSchema.parse(process.env);
