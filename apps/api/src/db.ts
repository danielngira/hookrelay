import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://hookrelay:hookrelay@localhost:5432/hookrelay",
  max: Number(process.env.PG_POOL_SIZE ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (error) => console.error(JSON.stringify({ level: "error", message: "Unexpected idle PostgreSQL client error", error: error.message })));
