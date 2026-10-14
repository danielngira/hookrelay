import { Pool } from "pg";
import type { RedisOptions } from "ioredis";
export const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://hookrelay:hookrelay@postgres:5432/hookrelay" });
export const redisConnection: RedisOptions = {
  host: process.env.REDIS_HOST ?? "redis",
  port: Number(process.env.REDIS_PORT ?? 6379),
  maxRetriesPerRequest: null,
};
