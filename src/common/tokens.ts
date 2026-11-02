import { createHmac, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { env } from "../config.js";

// Minimal dependency-free auth plumbing:
// - Passwords: scrypt with per-user random salt (modern KDF).
// - Access token: HMAC-SHA256 JWT-style compact tokens.
// - Refresh tokens: opaque random strings stored as SHA-256 hashes.

export function hashPassword(password: string): string {
  const salt = randomUUID().replace(/-/g, "");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function b64u(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payload: object, ttlSeconds: number): string {
  const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64u(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  const sig = createHmac("sha256", env.JWT_SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

export function issueAccessToken(userId: string, role: string): string {
  return sign({ sub: userId, role }, 15 * 60);
}

export type TokenPayload = { sub: string; role: string };

export function verifyAccessToken(token: string): TokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts as [string, string, string];
  const expected = createHmac("sha256", env.JWT_SECRET).update(`${header}.${body}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as TokenPayload & { exp?: number };
    if (!payload.sub || !payload.role) return null;
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return { sub: payload.sub, role: payload.role };
  } catch {
    return null;
  }
}

export function newRefreshToken(): { token: string; tokenHash: string; expiresAt: Date } {
  const token = randomUUID() + randomUUID().replace(/-/g, "");
  return {
    token,
    tokenHash: createHmac("sha256", env.JWT_SECRET).update(token).digest("hex"),
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
  };
}

export function hashRefreshToken(token: string): string {
  return createHmac("sha256", env.JWT_SECRET).update(token).digest("hex");
}

export function hmacSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}
