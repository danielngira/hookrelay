import express from "express";
import { Pool } from "pg";
import { decryptSecret, verifyWebhookSignature } from "@hookrelay/core";
const app = express(); app.use(express.json({ limit:"64kb" }));
const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://hookrelay:hookrelay@postgres:5432/hookrelay" });
app.get("/health", (_req,res) => res.json({ status:"ok" }));
app.post("/receive/:destinationId", async (req,res,next) => {
  try {
    const { rows } = await pool.query("SELECT simulator_mode,simulator_config,encrypted_secret FROM destinations WHERE id=$1", [req.params.destinationId]);
    if (!rows.length) return res.status(404).json({ error:"Unknown simulator" });
    const { simulator_mode:mode, simulator_config:config, encrypted_secret:encryptedSecret } = rows[0];
    const rawBody=JSON.stringify(req.body);
    if(!verifyWebhookSignature(req.header("x-hookrelay-signature"),req.header("x-hookrelay-timestamp"),rawBody,decryptSecret(encryptedSecret)))return res.status(401).json({error:"Invalid webhook signature"});
    const eventId = String(req.header("x-hookrelay-event-id") ?? "");
    const { rows: observed } = await pool.query("INSERT INTO receiver_observations(destination_id,event_id,attempt_count) VALUES($1,$2,1) ON CONFLICT(destination_id,event_id) DO UPDATE SET attempt_count=receiver_observations.attempt_count+1,updated_at=NOW() RETURNING attempt_count", [req.params.destinationId,eventId]);
    const seen = Number(observed[0].attempt_count);
    if (mode === "slow") await new Promise(resolve => setTimeout(resolve, Math.min(Number(config.delayMs ?? 6500), 9000)));
    if ((mode === "retry_then_recover" || mode === "rate_limited") && seen <= Number(config.failuresBeforeSuccess ?? 1)) {
      if (mode === "rate_limited") res.setHeader("Retry-After", String(config.retryAfterSeconds ?? 2));
      return res.status(mode === "rate_limited" ? 429 : 503).json({ accepted:false, attempt:seen });
    }
    if (mode === "always_fails") return res.status(400).json({ accepted:false, reason:"Permanent failure demo" });
    if (mode === "exhaust_retries") return res.status(503).json({ accepted:false, reason:"Transient failure demo" });
    res.json({ accepted:true, eventId, duplicate:seen > 1, attempt:seen });
  } catch (e) { next(e); }
});
app.use((e:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction) => { console.error(e); res.status(500).json({ error:"Receiver error" }); });
const server=app.listen(Number(process.env.RECEIVER_PORT ?? 4002),"0.0.0.0",()=>console.log("HookRelay receiver simulator ready"));
const stop=()=>{server.close();void pool.end()}; process.on("SIGINT",stop);process.on("SIGTERM",stop);
