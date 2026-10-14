import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { encryptSecret } from "@hookrelay/core";
import { pool } from "./db.js";

const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));
const destinations = [
  { id: "healthy", name: "Healthy receiver", mode: "healthy", config: {} },
  { id: "retry-then-recover", name: "Retry, then recover", mode: "retry_then_recover", config: { failuresBeforeSuccess: 2 } },
  { id: "rate-limited", name: "Rate limited receiver", mode: "rate_limited", config: { failuresBeforeSuccess: 1, retryAfterSeconds: 2 } },
  { id: "slow", name: "Slow receiver", mode: "slow", config: { delayMs: 6500 } },
  { id: "always-fails", name: "Always failing receiver", mode: "always_fails", config: {} },
  { id: "retry-exhaustion", name: "Retry exhaustion receiver", mode: "exhaust_retries", config: {} },
];

try {
  await pool.query(await readFile(schemaPath, "utf8"));
  for (const destination of destinations) {
    const secret = encryptSecret(`hookrelay-demo-secret-${destination.id}-change-for-real-use`);
    await pool.query(
      `INSERT INTO destinations (id, name, simulator_mode, simulator_config, encrypted_secret)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [destination.id, destination.name, destination.mode, JSON.stringify(destination.config), secret],
    );
  }
  console.log(JSON.stringify({ level: "info", message: "Database schema ready", seededDestinations: destinations.length }));
} finally {
  await pool.end();
}
