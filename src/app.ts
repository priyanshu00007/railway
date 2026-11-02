import Fastify, {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { env } from "./config.js";
import { prisma } from "./db.js";
import { metrics, inc, renderMetrics } from "./metrics.js";

import { applyAuth, authRoutes } from "./modules/auth/routes.js";
import { inventoryRoutes } from "./modules/inventory/routes.js";
import { paymentRoutes } from "./modules/payments/routes.js";
import { bookingRoutes } from "./modules/bookings/routes.js";
import { adminRoutes } from "./modules/admin/routes.js";
import { ErrorCodes } from "./common/errors.js";

export interface ApiError {
  statusCode: number;
  code: string;
  message: string;
  requestId?: string;
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "password",
          "passwordHash",
        ],
        censor: "[REDACTED]",
      },
      genReqId: () => crypto.randomUUID(),
    },
    requestIdHeader: "x-request-id",
    trustProxy: true,
    bodyLimit: 20_000, // JSON payloads only; largest legal body is 6 passengers.
    ajv: { customOptions: { allErrors: true, removeAdditional: false } },
  });

  // CORS: browsers only; origins must be explicitly allow-listed in production.
  const allowedOrigins = (env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  await app.register(cors, {
    origin: env.NODE_ENV === "production"
      ? (origin, cb) => cb(null, !!origin && allowedOrigins.includes(origin))
      : true,
    credentials: true,
    methods: ["GET", "POST", "DELETE"],
  });

  // Security headers. Swagger UI at /docs needs inline scripts, so CSP headers
  // are attached per-request everywhere except /docs*.
  await app.register(helmet, {
    contentSecurityPolicy: false,
    frameguard: { action: "deny" },
    noSniff: true,
    referrerPolicy: { policy: "no-referrer" },
    hsts: env.NODE_ENV === "production" ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    crossOriginResourcePolicy: { policy: "same-site" },
  });
  app.addHook("onSend", async (req, reply, payload) => {
    if (!req.url.startsWith("/docs")) {
      reply.header(
        "Content-Security-Policy",
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      );
      reply.header("X-Content-Type-Options", "nosniff");
    }
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    return payload;
  });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    errorResponseBuilder: () => ({
      statusCode: 429,
      code: "RATE_LIMITED",
      message: "Rate limit exceeded",
    }),
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "RailBook API",
        description: "Railway reservation backend (synthetic data, simulated payments)",
        version: "0.2.0",
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  // Auth context attached on demand by requireAuth/requireAdmin.
  app.decorateRequest("user");
  app.addHook("onRequest", async (req) => {
    inc("railbook_requests_total");
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      const user = applyAuth(req);
      void user;
    }
  });

  // Consistent error envelope + stable codes; 5xx messages are never leaked.
  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    const statusCode = err.statusCode ?? 500;
    const knownCode = err.code && err.code in ErrorCodes && statusCode !== 500;
    const code = statusCode === 500 ? "INTERNAL_ERROR" : knownCode ? err.code! : mapFastifyCode(err, statusCode);
    if (statusCode >= 500) {
      req.log.error({ err }, "unhandled error");
    } else {
      req.log.info({ errCode: code }, "request error");
    }
    const body: ApiError = {
      statusCode,
      code,
      message: statusCode >= 500 ? "Internal server error" : err.message,
      requestId: req.id,
    };
    reply.status(statusCode).send(body);
  });

  // Consistent error envelope for 404s too.
  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({
      statusCode: 404,
      code: "NOT_FOUND",
      message: `Route ${req.method}:${req.url} not found`,
      requestId: req.id,
    } satisfies ApiError);
  });

  // ── Health & telemetry ────────────────────────────────────────────────────
  app.get("/healthz", async () => ({ status: "ok", time: new Date().toISOString() }));

  app.get("/readyz", async (req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: "ready", db: "up" };
    } catch (err) {
      req.log.error({ err }, "readyz db check failed");
      reply.status(503);
      return { status: "not_ready", db: "down" };
    }
  });

  app.get("/metrics", { schema: { hide: true } }, async () =>
    renderMetrics(),
  );

  // ── Feature modules ───────────────────────────────────────────────────────
  await app.register(authRoutes);
  await app.register(inventoryRoutes);
  await app.register(paymentRoutes);
  await app.register(bookingRoutes);
  await app.register(adminRoutes);

  return app;
}

function mapFastifyCode(err: FastifyError, statusCode: number): string {
  if (err.code === "FST_ERR_VALIDATION" || statusCode === 400) return "VALIDATION_ERROR";
  if (statusCode === 404) return "NOT_FOUND";
  if (statusCode === 401) return "UNAUTHORIZED";
  if (statusCode === 403) return "FORBIDDEN";
  if (statusCode === 429) return "RATE_LIMITED";
  return "CONFLICT";
}
