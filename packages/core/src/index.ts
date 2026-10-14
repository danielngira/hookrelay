export * from "./retry.js";
export * from "./signature.js";
export * from "./results.js";

export const DELIVERY_QUEUE = "hookrelay-deliveries";
export const MAX_EVENT_BYTES = 64 * 1024;
export const RESPONSE_PREVIEW_BYTES = 2 * 1024;

export type DeliveryStatus =
  | "queued"
  | "in_progress"
  | "retry_scheduled"
  | "succeeded"
  | "dead_letter";

export type SimulatorMode =
  | "healthy"
  | "retry_then_recover"
  | "rate_limited"
  | "slow"
  | "always_fails"
  | "exhaust_retries";
