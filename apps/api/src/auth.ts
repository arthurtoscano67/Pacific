import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import type { OptionalDatabase } from "./db.js";
import { apiConfig } from "./config.js";
import {
  getLocalWalletSessionByTokenHash,
  upsertLocalWalletSession,
} from "./local-api-store.js";

export type SessionContext = {
  walletAddress: string;
  token: string;
};

type ParsedSessionMessage = {
  address: string;
  origin: string;
  issuedAt: Date;
  expiresAt: Date;
};

const sessionPrefix = "Pacific wallet session";

function allowedSessionOrigins() {
  const allowed = new Set<string>([apiConfig.APP_ORIGIN]);

  try {
    const configured = new URL(apiConfig.APP_ORIGIN);
    const isLocalHost =
      configured.hostname === "127.0.0.1" || configured.hostname === "localhost";
    if (!isLocalHost) {
      return allowed;
    }

    for (const host of ["127.0.0.1", "localhost"]) {
      allowed.add(`${configured.protocol}//${host}${configured.port ? `:${configured.port}` : ""}`);
    }
  } catch {
    // Fall back to the configured origin only.
  }

  return allowed;
}

const sessionOrigins = allowedSessionOrigins();

function parseSessionMessage(message: string): ParsedSessionMessage {
  const lines = message.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines[0] !== sessionPrefix) {
    throw new Error("Session message prefix is invalid.");
  }

  const values = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const [key, ...rest] = line.split(":");
    values.set(key.trim().toLowerCase(), rest.join(":").trim());
  }

  const address = values.get("address");
  const origin = values.get("origin");
  const issuedAt = values.get("issued at");
  const expiresAt = values.get("expires at");

  if (!address || !origin || !issuedAt || !expiresAt) {
    throw new Error("Session message is missing required fields.");
  }

  return {
    address,
    origin,
    issuedAt: new Date(issuedAt),
    expiresAt: new Date(expiresAt),
  };
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function createWalletSession(
  sql: OptionalDatabase,
  address: string,
  message: string,
  signature: string,
) {
  const parsed = parseSessionMessage(message);
  if (parsed.address !== address) {
    throw new Error("Signed address does not match request address.");
  }

  if (!sessionOrigins.has(parsed.origin)) {
    throw new Error("Wallet session origin does not match the configured app origin.");
  }

  const now = Date.now();
  if (Number.isNaN(parsed.issuedAt.getTime()) || Number.isNaN(parsed.expiresAt.getTime())) {
    throw new Error("Wallet session timestamps are invalid.");
  }

  if (parsed.issuedAt.getTime() > now + 60_000) {
    throw new Error("Wallet session is issued in the future.");
  }

  if (parsed.expiresAt.getTime() <= now) {
    throw new Error("Wallet session has expired.");
  }

  if (parsed.expiresAt.getTime() - parsed.issuedAt.getTime() > apiConfig.SESSION_TTL_HOURS * 3_600_000) {
    throw new Error("Wallet session expiration exceeds the server policy.");
  }

  await verifyPersonalMessageSignature(new TextEncoder().encode(message), signature, {
    address,
  });

  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  if (sql) {
    await sql`
      insert into avatar_sessions (token_hash, wallet_address, expires_at)
      values (${tokenHash}, ${address}, ${parsed.expiresAt.toISOString()})
      on conflict (token_hash) do update
      set wallet_address = excluded.wallet_address,
          expires_at = excluded.expires_at
    `;
  } else {
    await upsertLocalWalletSession({
      tokenHash,
      walletAddress: address,
      expiresAt: parsed.expiresAt.toISOString(),
    });
  }

  return {
    token,
    walletAddress: address,
    expiresAt: parsed.expiresAt.toISOString(),
  };
}

export async function requireWalletSession(
  sql: OptionalDatabase,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionContext | null> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    await reply.code(401).send({ error: "Missing bearer token." });
    return null;
  }

  const token = authHeader.slice("Bearer ".length).trim();
  const tokenHash = hashToken(token);
  const row = sql
    ? ((await sql`
        select wallet_address, expires_at
        from avatar_sessions
        where token_hash = ${tokenHash}
        limit 1
      `)[0] as { wallet_address: string; expires_at: string } | undefined)
    : await (async () => {
        const session = await getLocalWalletSessionByTokenHash(tokenHash);
        if (!session) {
          return undefined;
        }

        return {
          wallet_address: session.walletAddress,
          expires_at: session.expiresAt,
        };
      })();

  if (!row) {
    await reply.code(401).send({ error: "Wallet session is invalid." });
    return null;
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await reply.code(401).send({ error: "Wallet session has expired." });
    return null;
  }

  return {
    walletAddress: row.wallet_address,
    token,
  };
}

export function sessionTokenEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
