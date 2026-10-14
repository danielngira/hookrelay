import assert from "node:assert/strict";
import test from "node:test";
import { calculateRetryDelay, isRetryableStatus, parseRetryAfter } from "./retry.js";

test("retry classification retries transient failures only", () => {
  assert.equal(isRetryableStatus(200), false);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(408), true);
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(503), true);
});

test("backoff increases, applies bounded jitter, and respects the cap", () => {
  assert.equal(calculateRetryDelay(1, undefined, () => 0), 1_600);
  assert.equal(calculateRetryDelay(2, undefined, () => 0.5), 4_000);
  assert.equal(calculateRetryDelay(8, undefined, () => 1), 30_000);
  assert.equal(calculateRetryDelay(1, 8_000, () => 0), 8_000);
});

test("Retry-After accepts seconds and HTTP dates", () => {
  assert.equal(parseRetryAfter("2"), 2_000);
  assert.equal(parseRetryAfter("not a date"), undefined);
  assert.equal(parseRetryAfter("Thu, 01 Jan 1970 00:00:05 GMT", 2_000), 3_000);
});
