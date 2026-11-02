import { buildApp } from "./app.js";
import { env } from "./config.js";
import { prisma } from "./db.js";

const app = await buildApp();

const shutdown = async () => {
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err, "failed to start");
  process.exit(1);
}
