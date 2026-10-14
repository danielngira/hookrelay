import { randomUUID, createHash } from "node:crypto";
import cors from "cors";
import express from "express";
import { z } from "zod";
import { MAX_EVENT_BYTES, calculateRunMetrics } from "@hookrelay/core";
import { pool } from "./db.js";
import { deliveryQueue } from "./queue.js";
import { newOutboxId, startOutboxDispatcher } from "./outbox.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: `${MAX_EVENT_BYTES}b` }));
app.use((req, res, next) => {
  const started = performance.now();
  res.on("finish", () => console.log(JSON.stringify({ method: req.method, path: req.path, status: res.statusCode, durationMs: Math.round(performance.now() - started) })));
  next();
});

const eventSchema = z.object({
  type: z.string().min(1).max(200),
  payload: z.record(z.unknown()),
  destinationIds: z.array(z.string().min(1)).min(1).max(20),
}).strict();

app.get("/health", async (_req, res) => {
  try { await pool.query("SELECT 1"); res.json({ status: "ok", database: "connected" }); }
  catch { res.status(503).json({ status: "unavailable", database: "disconnected" }); }
});

app.get("/api/summary", async (_req, res, next) => {
  try {
    const [deliveryResult, queueCounts, appResult] = await Promise.all([
      pool.query(`SELECT status, COUNT(*)::int AS count FROM deliveries GROUP BY status`),
      deliveryQueue.getJobCounts("waiting", "active", "delayed", "failed", "completed"),
      pool.query(`SELECT (SELECT COUNT(*)::int FROM deliveries WHERE status='in_progress') AS active_deliveries,
                         COUNT(*)::int AS recent_attempts, COALESCE(AVG(duration_ms), 0)::float AS avg_delivery_ms
                  FROM delivery_attempts WHERE started_at > NOW() - INTERVAL '1 hour'`),
    ]);
    res.json({ deliveries: Object.fromEntries(deliveryResult.rows.map((r: {status:string;count:number}) => [r.status, r.count])), queue: queueCounts, application: appResult.rows[0] });
  } catch (e) { next(e); }
});

app.get("/api/destinations", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT d.id, d.name, d.simulator_mode AS mode, d.enabled,
       COUNT(DISTINCT o.event_id)::int AS received_events
       FROM destinations d LEFT JOIN receiver_observations o ON o.destination_id = d.id
       GROUP BY d.id ORDER BY d.created_at`);
    res.json(rows);
  } catch (e) { next(e); }
});

app.post("/api/events", async (req, res, next) => {
  const parsed = eventSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid event", details: parsed.error.flatten() });
  const key = req.header("idempotency-key");
  if (!key || key.length > 200) return res.status(400).json({ error: "A valid Idempotency-Key header is required" });
  const body = parsed.data;
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
    const existing = await client.query("SELECT id, request_hash FROM events WHERE idempotency_key = $1", [key]);
    if (existing.rowCount) {
      if (existing.rows[0].request_hash !== hash) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Idempotency-Key was already used with a different request body" }); }
      const prior = await client.query("SELECT id FROM deliveries WHERE event_id = $1 ORDER BY created_at", [existing.rows[0].id]);
      await client.query("COMMIT");
      return res.status(202).json({ eventId: existing.rows[0].id, deliveryIds: prior.rows.map((r: {id:string}) => r.id), duplicate: true });
    }
    const destinations = await client.query("SELECT id FROM destinations WHERE id = ANY($1::text[]) AND enabled = TRUE", [body.destinationIds]);
    if (destinations.rowCount !== body.destinationIds.length) { await client.query("ROLLBACK"); return res.status(400).json({ error: "One or more destinations are unknown or disabled" }); }
    const eventId = randomUUID();
    await client.query("INSERT INTO events (id, event_type, payload, idempotency_key, request_hash) VALUES ($1,$2,$3,$4,$5)", [eventId, body.type, JSON.stringify(body.payload), key, hash]);
    const deliveryIds: string[] = [];
    for (const destinationId of body.destinationIds) {
      const deliveryId = randomUUID(); deliveryIds.push(deliveryId);
      await client.query("INSERT INTO deliveries (id,event_id,destination_id) VALUES ($1,$2,$3)", [deliveryId, eventId, destinationId]);
      await client.query("INSERT INTO outbox (id,delivery_id) VALUES ($1,$2)", [newOutboxId(), deliveryId]);
    }
    await client.query("COMMIT");
    res.status(202).json({ eventId, deliveryIds, duplicate: false });
  } catch (e) { await client.query("ROLLBACK"); next(e); }
  finally { client.release(); }
});

app.post("/api/runs", async (req,res,next) => {
  const input = z.object({ scenario:z.string().min(1).max(100), destinationIds:z.array(z.string()).min(1).max(6),
    eventCount:z.number().int().min(1).max(500), concurrency:z.number().int().min(1).max(50),
    maxP95Ms:z.number().int().min(1).max(60000).default(1000),maxErrorRate:z.number().min(0).max(100).default(5) }).safeParse(req.body);
  if (!input.success) return res.status(400).json({error:"Invalid run settings",details:input.error.flatten()});
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    const found=await client.query("SELECT id FROM destinations WHERE id=ANY($1::text[]) AND enabled=TRUE",[input.data.destinationIds]);
    if(found.rowCount!==input.data.destinationIds.length){await client.query("ROLLBACK");return res.status(400).json({error:"Unknown or disabled destination"});}
    const runId=randomUUID();
    await client.query("INSERT INTO test_runs(id,scenario,event_count,concurrency,max_p95_ms,max_error_rate,destination_ids) VALUES($1,$2,$3,$4,$5,$6,$7)",[runId,input.data.scenario,input.data.eventCount,input.data.concurrency,input.data.maxP95Ms,input.data.maxErrorRate,input.data.destinationIds]);
    for(let i=0;i<input.data.eventCount;i++){
      const eventId=randomUUID();
      await client.query("INSERT INTO events(id,run_id,event_type,payload,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,$6)",
        [eventId,runId,"demo.performance_check",JSON.stringify({sequence:i+1,scenario:input.data.scenario,generatedAt:new Date().toISOString()}),`run:${runId}:${i}`,"run-generated"]);
      for(const destinationId of input.data.destinationIds){const deliveryId=randomUUID();
        await client.query("INSERT INTO deliveries(id,event_id,destination_id) VALUES($1,$2,$3)",[deliveryId,eventId,destinationId]);
        await client.query("INSERT INTO outbox(id,delivery_id) VALUES($1,$2)",[newOutboxId(),deliveryId]);}
    }
    await client.query("COMMIT");
    res.status(202).json({runId,scenario:input.data.scenario,eventCount:input.data.eventCount,concurrency:input.data.concurrency,maxP95Ms:input.data.maxP95Ms,maxErrorRate:input.data.maxErrorRate,destinationIds:input.data.destinationIds});
  }catch(e){await client.query("ROLLBACK");next(e);}finally{client.release();}
});

app.get("/api/runs",async(_req,res,next)=>{
  try{const {rows}=await pool.query(`SELECT r.id,r.scenario,r.event_count AS "eventCount",r.concurrency,r.max_p95_ms AS "maxP95Ms",r.max_error_rate AS "maxErrorRate",r.destination_ids AS "destinationIds",r.created_at AS "createdAt",
    COUNT(d.id)::int AS "deliveryCount",COUNT(d.id) FILTER(WHERE d.status IN ('succeeded','dead_letter'))::int AS completed,
    COUNT(d.id) FILTER(WHERE d.status='succeeded')::int AS succeeded,COUNT(d.id) FILTER(WHERE d.status='dead_letter')::int AS failed
    FROM test_runs r LEFT JOIN events e ON e.run_id=r.id LEFT JOIN deliveries d ON d.event_id=e.id GROUP BY r.id ORDER BY r.created_at DESC LIMIT 30`);res.json(rows);}
  catch(e){next(e);}
});

app.get("/api/runs/:id/results",async(req,res,next)=>{
  try{
    const {rows:runs}=await pool.query("SELECT * FROM test_runs WHERE id=$1",[req.params.id]);
    if(!runs.length)return res.status(404).json({error:"Run not found"});const run=runs[0];
    const {rows}=await pool.query(`SELECT d.id,d.destination_id AS "destinationId",dest.name AS "destinationName",d.status,d.attempt_count AS "attemptCount",
      d.last_http_status AS "lastHttpStatus",d.last_error AS "lastError",d.created_at AS "createdAt",d.updated_at AS "updatedAt",
      COALESCE(a.duration_ms,0)::float AS "durationMs",a.response_status AS "responseStatus",a.retry_delay_ms AS "retryDelayMs",a.attempt_number AS "attemptNumber"
      FROM events e JOIN deliveries d ON d.event_id=e.id JOIN destinations dest ON dest.id=d.destination_id
      LEFT JOIN LATERAL(SELECT duration_ms,response_status,retry_delay_ms,attempt_number FROM delivery_attempts WHERE delivery_id=d.id ORDER BY attempt_number DESC LIMIT 1)a ON TRUE
      WHERE e.run_id=$1 ORDER BY d.created_at`,[req.params.id]);
    const elapsed=Math.max(1,(Date.now()-new Date(run.created_at).getTime())/1000);
    const metrics=calculateRunMetrics(rows,elapsed*1000);
    const passed=metrics.pending?null:metrics.p95Ms<=run.max_p95_ms&&metrics.errorRate<=Number(run.max_error_rate);
    res.json({run:{id:run.id,scenario:run.scenario,eventCount:run.event_count,concurrency:run.concurrency,maxP95Ms:run.max_p95_ms,maxErrorRate:Number(run.max_error_rate),destinationIds:run.destination_ids,createdAt:run.created_at},metrics,passed,deliveries:rows});
  }catch(e){next(e);}
});

app.get("/api/deliveries", async (req, res, next) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const { rows } = await pool.query(`SELECT d.id, d.event_id AS "eventId", d.destination_id AS "destinationId",
      dest.name AS "destinationName", ev.event_type AS "eventType", d.status, d.attempt_count AS "attemptCount",
      d.last_http_status AS "lastHttpStatus", d.last_error AS "lastError", d.next_attempt_at AS "nextAttemptAt",
      d.replayed_from_delivery_id AS "replayedFrom", d.created_at AS "createdAt", d.updated_at AS "updatedAt"
      FROM deliveries d JOIN destinations dest ON dest.id=d.destination_id JOIN events ev ON ev.id=d.event_id
      ORDER BY d.created_at DESC LIMIT $1`, [limit]);
    res.json(rows);
  } catch (e) { next(e); }
});

app.get("/api/events/:id/results", async (req, res, next) => {
  try {
    const exists = await pool.query("SELECT id,event_type,created_at FROM events WHERE id=$1", [req.params.id]);
    if (!exists.rowCount) return res.status(404).json({ error: "Run not found" });
    const { rows } = await pool.query(`SELECT d.id,d.destination_id AS "destinationId",dest.name AS "destinationName",d.status,
      d.attempt_count AS "attemptCount",d.last_http_status AS "lastHttpStatus",d.last_error AS "lastError",
      d.created_at AS "createdAt",d.updated_at AS "updatedAt",COALESCE(a.duration_ms,0)::float AS "durationMs",
      a.response_status AS "responseStatus",a.retry_delay_ms AS "retryDelayMs",a.attempt_number AS "attemptNumber"
      FROM deliveries d JOIN destinations dest ON dest.id=d.destination_id
      LEFT JOIN LATERAL (SELECT duration_ms,response_status,retry_delay_ms,attempt_number FROM delivery_attempts
        WHERE delivery_id=d.id ORDER BY attempt_number DESC LIMIT 1) a ON TRUE
      WHERE d.event_id=$1 ORDER BY d.created_at`, [req.params.id]);
    const durations = rows.map((row: {durationMs:number}) => row.durationMs).filter((n:number) => n > 0).sort((a:number,b:number) => a-b);
    const percentile = (p:number) => durations.length ? durations[Math.min(durations.length-1, Math.ceil(p*durations.length)-1)] : 0;
    const total = rows.length;
    const terminal = rows.filter((r: {status:string}) => ["succeeded","dead_letter"].includes(r.status)).length;
    const successes = rows.filter((r: {status:string}) => r.status === "succeeded").length;
    const doneTimes = rows.map((r: {updatedAt:string}) => new Date(r.updatedAt).getTime());
    const elapsedSeconds = doneTimes.length > 1 ? Math.max(1, (Math.max(...doneTimes)-new Date(exists.rows[0].created_at).getTime())/1000) : 1;
    res.json({ event:{ id:exists.rows[0].id,type:exists.rows[0].event_type,createdAt:exists.rows[0].created_at },
      metrics:{ p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99),rps:Number((terminal/elapsedSeconds).toFixed(2)),
        errorRate:total ? Number(((total-successes)/total*100).toFixed(1)) : 0, total, completed:terminal, succeeded:successes,
        pending:total-terminal }, deliveries:rows });
  } catch(e) { next(e); }
});

app.get("/api/deliveries/:id", async (req, res, next) => {
  try {
    const result = await pool.query(`SELECT d.id, d.event_id AS "eventId", d.destination_id AS "destinationId", dest.name AS "destinationName",
      ev.event_type AS "eventType", ev.payload, d.status, d.attempt_count AS "attemptCount", d.last_http_status AS "lastHttpStatus",
      d.last_error AS "lastError", d.next_attempt_at AS "nextAttemptAt", d.replayed_from_delivery_id AS "replayedFrom",
      d.created_at AS "createdAt", d.updated_at AS "updatedAt" FROM deliveries d JOIN destinations dest ON dest.id=d.destination_id
      JOIN events ev ON ev.id=d.event_id WHERE d.id=$1`, [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: "Delivery not found" });
    const attempts = await pool.query(`SELECT attempt_number AS "attemptNumber", started_at AS "startedAt", completed_at AS "completedAt",
      response_status AS "responseStatus", response_excerpt AS "responseExcerpt", error_category AS "errorCategory",
      duration_ms AS "durationMs", retry_delay_ms AS "retryDelayMs" FROM delivery_attempts WHERE delivery_id=$1 ORDER BY attempt_number`, [req.params.id]);
    res.json({ ...result.rows[0], attempts: attempts.rows });
  } catch (e) { next(e); }
});

app.post("/api/deliveries/:id/replay", async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM deliveries WHERE id=$1 FOR UPDATE", [req.params.id]);
    if (!rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Delivery not found" }); }
    const source = rows[0];
    const id = randomUUID();
    await client.query(`INSERT INTO deliveries (id,event_id,destination_id,replayed_from_delivery_id) VALUES ($1,$2,$3,$4)`, [id, source.event_id, source.destination_id, source.id]);
    await client.query("INSERT INTO outbox (id,delivery_id) VALUES ($1,$2)", [newOutboxId(), id]);
    await client.query("COMMIT");
    res.status(202).json({ deliveryId: id, replayedFrom: source.id });
  } catch (e) { await client.query("ROLLBACK"); next(e); }
  finally { client.release(); }
});

app.get("/api/metrics/timeseries", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT date_trunc('minute', created_at) AS time, COUNT(*)::int AS attempts,
      COUNT(*) FILTER (WHERE response_status BETWEEN 200 AND 299)::int AS successes,
      COUNT(*) FILTER (WHERE response_status IS NULL OR response_status >= 400)::int AS errors,
      COALESCE(AVG(duration_ms),0)::float AS "avgDurationMs" FROM delivery_attempts
      WHERE created_at > NOW() - INTERVAL '30 minutes' GROUP BY 1 ORDER BY 1`);
    res.json(rows);
  } catch (e) { next(e); }
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(JSON.stringify({ level: "error", message: err instanceof Error ? err.message : String(err) }));
  if (typeof err === "object" && err !== null && "type" in err && err.type === "entity.too.large") return res.status(413).json({ error: "Request body exceeds the 64 KiB event limit" });
  res.status(500).json({ error: "Internal server error" });
});

const port = Number(process.env.API_PORT ?? 4000);
const stopOutbox = startOutboxDispatcher();
const server = app.listen(port, "0.0.0.0", () => console.log(`HookRelay API listening on ${port}`));
const shutdown = () => { stopOutbox(); server.close(); void deliveryQueue.close(); void pool.end(); };
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
