import { prisma } from "../../db.js";
import { newRefreshToken, hashRefreshToken, issueAccessToken, verifyPassword, hashPassword } from "../../common/tokens.js";
import { apiError } from "../../common/errors.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type Session = { accessToken: string; refreshToken: string; userId: string; role: string };

export async function register(email: string, password: string): Promise<Session> {
  if (!EMAIL_RE.test(email)) throw apiError("VALIDATION_ERROR", "invalid email");
  if (password.length < 8 || password.length > 200) {
    throw apiError("VALIDATION_ERROR", "password must be 8-200 characters");
  }
  const passwordHash = hashPassword(password);
  let user;
  try {
    user = await prisma.user.create({ data: { email: email.toLowerCase(), passwordHash, role: "CUSTOMER" } });
  } catch (e) {
    if (String(e).includes("Unique constraint")) {
      throw apiError("CONFLICT", "email already registered");
    }
    throw e;
  }
  return createSession(user.id, user.role);
}

export async function login(email: string, password: string): Promise<Session> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user || !verifyPassword(password, user.passwordHash)) {
    throw apiError("UNAUTHORIZED", "invalid credentials");
  }
  return createSession(user.id, user.role);
}

export async function rotate(refreshToken: string): Promise<Session> {
  const tokenHash = hashRefreshToken(refreshToken);
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    throw apiError("UNAUTHORIZED", "invalid refresh token");
  }
  // Rotation: revoke old token, issue a fresh pair (replay of a revoked token fails).
  await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
  const user = await prisma.user.findUniqueOrThrow({ where: { id: stored.userId } });
  return createSession(user.id, user.role);
}

export async function logout(refreshToken: string): Promise<void> {
  await prisma.refreshToken.update({
    where: { tokenHash: hashRefreshToken(refreshToken) },
    data: { revokedAt: new Date() },
  }).catch(() => undefined);
}

function createSession(userId: string, role: string): Session {
  const rt = newRefreshToken();
  return {
    accessToken: issueAccessToken(userId, role),
    refreshToken: rt.token,
    userId,
    role,
  };
}

export async function persistRefreshToken(session: Session): Promise<void> {
  const { token, tokenHash, expiresAt } = newRefreshToken();
  await prisma.refreshToken.create({ data: { userId: session.userId, tokenHash, expiresAt } });
  session.refreshToken = token;
}

export { hashRefreshToken };
