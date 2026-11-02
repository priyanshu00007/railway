import { FastifyInstance, FastifyRequest } from "fastify";
import { Type } from "@sinclair/typebox";
import * as svc from "./service.js";
import { verifyAccessToken } from "../../common/tokens.js";
import { apiError } from "../../common/errors.js";

export interface AuthUser {
  id: string;
  role: "CUSTOMER" | "ADMIN";
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export const RegisterSchema = Type.Object({
  email: Type.String({ format: "email" }),
  password: Type.String({ minLength: 8, maxLength: 200 }),
});

export const SessionSchema = Type.Object({
  accessToken: Type.String(),
  refreshToken: Type.String(),
  userId: Type.String(),
});

export function applyAuth(req: FastifyRequest): AuthUser {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw apiError("UNAUTHORIZED", "missing bearer token");
  const payload = verifyAccessToken(header.slice(7));
  if (!payload) throw apiError("UNAUTHORIZED", "invalid or expired token");
  req.user = { id: payload.sub, role: payload.role === "ADMIN" ? "ADMIN" : "CUSTOMER" };
  return req.user;
}

export function requireAuth(req: FastifyRequest): AuthUser {
  return applyAuth(req);
}

export function requireAdmin(req: FastifyRequest): AuthUser {
  const user = applyAuth(req);
  if (user.role !== "ADMIN") throw apiError("FORBIDDEN", "admin role required");
  return user;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/v1/auth/register",
    {
      schema: { body: RegisterSchema, response: { 201: SessionSchema } },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { email, password } = req.body as { email: string; password: string };
      const session = await svc.register(email, password);
      await svc.persistRefreshToken(session);
      reply.code(201);
      return { accessToken: session.accessToken, refreshToken: session.refreshToken, userId: session.userId };
    },
  );

  app.post(
    "/api/v1/auth/login",
    {
      schema: { body: RegisterSchema, response: { 200: SessionSchema } },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req) => {
      const { email, password } = req.body as { email: string; password: string };
      const session = await svc.login(email, password);
      await svc.persistRefreshToken(session);
      return { accessToken: session.accessToken, refreshToken: session.refreshToken, userId: session.userId };
    },
  );

  app.post("/api/v1/auth/refresh", { schema: { body: Type.Object({ refreshToken: Type.String() }) } }, async (req) => {
    const { refreshToken } = req.body as { refreshToken: string };
    const session = await svc.rotate(refreshToken);
    await svc.persistRefreshToken(session);
    return { accessToken: session.accessToken, refreshToken: session.refreshToken, userId: session.userId };
  });

  app.post("/api/v1/auth/logout", { schema: { body: Type.Object({ refreshToken: Type.String() }) } }, async (req, reply) => {
    const { refreshToken } = req.body as { refreshToken: string };
    await svc.logout(refreshToken);
    reply.code(204);
  });
}
