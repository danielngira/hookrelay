import { randomUUID } from "node:crypto";
import { Worker, type Job, type MinimalJob } from "bullmq";
import { DELIVERY_QUEUE, decryptSecret, MAX_EVENT_BYTES, RESPONSE_PREVIEW_BYTES, classifyResponse, retryDelayMs, signPayload } from "@hookrelay/core";
import { pool, redisConnection } from "./runtime.js";

type DeliveryJob = { deliveryId: string; runConcurrency?:number };
const maxAttempts = 5;
const retryDelays = new Map<string, number>();

let worker: Worker<DeliveryJob>;
worker = new Worker<DeliveryJob>(DELIVERY_QUEUE, async (job: Job<DeliveryJob>) => {
  if(job.data.runConcurrency) worker.concurrency=Math.min(50,Math.max(1,job.data.runConcurrency));
  const started = Date.now();
  const client = await pool.connect();
  let attemptId = randomUUID();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT d.id,d.event_id,d.destination_id,d.attempt_count,d.status,ev.event_type,ev.payload,
      dest.simulator_mode,dest.encrypted_secret FROM deliveries d JOIN events ev ON ev.id=d.event_id
      JOIN destinations dest ON dest.id=d.destination_id WHERE d.id=$1 FOR UPDATE OF d`, [job.data.deliveryId]);
    if (!rows.length) { await client.query("ROLLBACK"); return; }
    const d = rows[0];
    if (["succeeded", "dead_letter"].includes(d.status)) { await client.query("COMMIT"); return; }
    const attempt = Number(d.attempt_count) + 1;
    attemptId = randomUUID();
    await client.query("UPDATE deliveries SET status='in_progress',attempt_count=$2,updated_at=NOW() WHERE id=$1", [d.id, attempt]);
    await client.query(`INSERT INTO delivery_attempts (id,delivery_id,attempt_number,started_at) VALUES ($1,$2,$3,NOW())`, [attemptId,d.id,attempt]);
    await client.query("COMMIT");

    const payload = JSON.stringify({ id: d.event_id, type: d.event_type, data: d.payload });
    if (Buffer.byteLength(payload) > MAX_EVENT_BYTES) throw new Error("Event payload exceeds the receiver limit");
    const secret = decryptSecret(d.encrypted_secret);
    const signature = signPayload(payload, secret);
    const timestamp = signature.split(",")[0]?.split("=")[1] ?? "";
    const timeout = AbortSignal.timeout(10_000);
    const response = await fetch(`${process.env.RECEIVER_URL ?? "http://receiver:4002"}/receive/${d.destination_id}`, {
      method: "POST", headers: { "content-type":"application/json", "x-hookrelay-event-id":d.event_id,
        "x-hookrelay-timestamp":timestamp,"x-hookrelay-signature":signature, "x-hookrelay-attempt":String(attempt) }, body:payload, signal:timeout,
    });
    const excerpt = (await response.text()).slice(0, RESPONSE_PREVIEW_BYTES);
    const category = classifyResponse(response.status);
    const elapsed = Date.now() - started;
    if (category === "success") {
      await pool.query(`UPDATE delivery_attempts SET completed_at=NOW(),response_status=$2,response_excerpt=$3,duration_ms=$4 WHERE id=$1`, [attemptId,response.status,excerpt,elapsed]);
      await pool.query(`UPDATE deliveries SET status='succeeded',last_http_status=$2,last_error=NULL,next_attempt_at=NULL,updated_at=NOW() WHERE id=$1`, [d.id,response.status]);
      return;
    }
    const transient = category === "retryable";
    const exhausted = !transient || attempt >= maxAttempts;
    const delay = transient && !exhausted ? retryDelayMs(attempt, response.headers.get("retry-after")) : 0;
    retryDelays.set(job.id!, delay);
    await pool.query(`UPDATE delivery_attempts SET completed_at=NOW(),response_status=$2,response_excerpt=$3,error_category=$4,duration_ms=$5,retry_delay_ms=$6 WHERE id=$1`,
      [attemptId,response.status,excerpt,category,elapsed,delay || null]);
    await pool.query(`UPDATE deliveries SET status=$2,last_http_status=$3,last_error=$4,next_attempt_at=CASE WHEN $5 > 0 THEN NOW()+($5::text || ' milliseconds')::interval ELSE NULL END,updated_at=NOW() WHERE id=$1`,
      [d.id, exhausted ? "dead_letter" : "retry_scheduled",response.status,`Receiver returned HTTP ${response.status}`,delay]);
    if (exhausted) return;
    throw new Error(`Retryable receiver response: HTTP ${response.status}`);
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError" || error.message.startsWith("fetch failed"))) {
      const elapsed = Date.now() - started;
      const attempt = job.attemptsMade + 1;
      const delay = attempt < maxAttempts ? retryDelayMs(attempt) : 0;
      retryDelays.set(job.id!, delay);
      await pool.query(`UPDATE delivery_attempts SET completed_at=NOW(),error_category='network',response_excerpt=$2,duration_ms=$3,retry_delay_ms=$4 WHERE id=$1`, [attemptId,error.message.slice(0,RESPONSE_PREVIEW_BYTES),elapsed,delay || null]);
      await pool.query(`UPDATE deliveries SET status=$2,last_error=$3,next_attempt_at=CASE WHEN $4 > 0 THEN NOW()+($4::text || ' milliseconds')::interval ELSE NULL END,updated_at=NOW() WHERE id=$1`,
        [job.data.deliveryId,delay ? "retry_scheduled" : "dead_letter",error.message.slice(0,500),delay]);
      if (delay) throw error;
      return;
    }
    throw error;
  } finally { client.release(); }
}, {
  connection: redisConnection,
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 10),
  limiter: { max: Number(process.env.WORKER_RATE_MAX ?? 100), duration: 1000 },
  settings: { backoffStrategy: (attemptsMade: number, _type?: string, _error?: Error, job?: MinimalJob) => retryDelays.get(job?.id ?? "") ?? retryDelayMs(attemptsMade) },
});

worker.on("completed", (job) => console.log(JSON.stringify({ level:"info", message:"Delivery job finished", jobId:job.id })));
worker.on("failed", (job, error) => console.warn(JSON.stringify({ level:"warn", message:"Delivery will retry or failed", jobId:job?.id, error:error.message })));
worker.on("error", (error) => console.error(JSON.stringify({ level:"error", message:"Worker error", error:error.message })));
console.log("HookRelay worker started");
const shutdown = async () => { await worker.close(); await pool.end(); };
process.on("SIGINT", () => void shutdown()); process.on("SIGTERM", () => void shutdown());
