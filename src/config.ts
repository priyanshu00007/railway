// Environment validation — fail fast on missing/misconfigured values.
// No zod dependency yet; plain strict validation keeps deps light.

export type Env = {
  NODE_ENV: "development" | "test" | "production";
  PORT: number;
  DATABASE_URL: string;
  JWT_SECRET: string;
  PAYMENT_WEBHOOK_SECRET: string;
  LOG_LEVEL: string;
  CORS_ORIGINS: string;
};

export type Source = Record<string, string | undefined>;

function readValue(source: Source, key: string): string | undefined {
  const raw = source[key];
  // Strip CRLF artifacts from Windows .env files.
  return typeof raw === "string" ? raw.trim() : undefined;
}

function requireString(source: Source, key: string): string {
  const value = readValue(source, key);
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export function loadEnv(source: Source = process.env): Env {
  const env: Env = {
    NODE_ENV: (readValue(source, "NODE_ENV") as Env["NODE_ENV"]) ?? "development",
    PORT: parsePort(readValue(source, "PORT"), source["NODE_ENV"]),
    DATABASE_URL: requireString(source, "DATABASE_URL"),
    // Allow short dev secrets in development only.
    JWT_SECRET: process.env.NODE_ENV === "production"
      ? requireString(source, "JWT_SECRET")
      : (readValue(source, "JWT_SECRET") ?? "dev-only-secret-change-me"),
    LOG_LEVEL: readValue(source, "LOG_LEVEL") ?? "info",
    CORS_ORIGINS: readValue(source, "CORS_ORIGINS") ?? "",
    PAYMENT_WEBHOOK_SECRET: readValue(source, "PAYMENT_WEBHOOK_SECRET") ?? "sim-webhook-secret-dev-only",
  };
  if (
    env.NODE_ENV !== "development" &&
    env.NODE_ENV !== "test" &&
    env.NODE_ENV !== "production"
  ) {
    throw new Error("NODE_ENV must be development | test | production");
  }
  if (
    (!Number.isInteger(env.PORT) || env.PORT <= 0) &&
    env.NODE_ENV === "production"
  ) {
    throw new Error("PORT must be a positive integer in production");
  }
  return env;
}

function parsePort(
  rawPort: string | undefined,
  nodeEnv: string | undefined,
): number {
  // Invalid or 0 falls back to 3000 outside production; hosts sometimes inject
  // PORT=0 into the environment.
  const parsed = rawPort ? Number(rawPort) : NaN;
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : nodeEnv === "production"
      ? parsed
      : 3000;
}

export const env: Env = loadEnv();
