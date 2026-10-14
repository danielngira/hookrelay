import { randomUUID } from "node:crypto";
import { pool } from "./db.js";
import { deliveryQueue } from "./queue.js";

let running = false;

export async function publishOutboxBatch(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const { rows } = await pool.query(
      `SELECT o.id, o.delivery_id, COALESCE(r.concurrency, 10) AS concurrency
       FROM outbox o JOIN deliveries d ON d.id=o.delivery_id JOIN events e ON e.id=d.event_id
       LEFT JOIN test_runs r ON r.id=e.run_id WHERE o.published_at IS NULL
       ORDER BY o.created_at LIMIT 50`,
    );
    for (const row of rows as Array<{ id: string; delivery_id: string; concurrency:number }>) {
      try {
        await deliveryQueue.add("deliver", { deliveryId: row.delivery_id, runConcurrency:row.concurrency }, { jobId: `delivery-${row.delivery_id}` });
        await pool.query(
          "UPDATE outbox SET published_at = NOW(), publish_attempts = publish_attempts + 1, last_error = NULL WHERE id = $1",
          [row.id],
        );
      } catch (error) {
        await pool.query(
          "UPDATE outbox SET publish_attempts = publish_attempts + 1, last_error = $2 WHERE id = $1",
          [row.id, error instanceof Error ? error.message.slice(0, 500) : "Queue publication failed"],
        );
      }
    }
  } finally {
    running = false;
  }
}

export function startOutboxDispatcher(): () => void {
  const timer = setInterval(() => {
    void publishOutboxBatch().catch((error: unknown) => {
      console.error(JSON.stringify({ level: "error", message: "Outbox polling failed", error: String(error) }));
    });
  }, 500);
  timer.unref();
  void publishOutboxBatch();
  return () => clearInterval(timer);
}

export function newOutboxId(): string {
  return randomUUID();
}
