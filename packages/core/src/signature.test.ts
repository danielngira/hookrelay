import assert from "node:assert/strict";
import test from "node:test";
import { signWebhook, verifyWebhookSignature } from "./signature.js";

test("webhook signatures verify only for the original body and fresh timestamp", () => {
  const timestamp = "1700000000";
  const body = JSON.stringify({ id: "evt_1", amount: 42 });
  const signature = signWebhook(timestamp, body, "test-secret");
  assert.equal(verifyWebhookSignature(signature, timestamp, body, "test-secret", 1_700_000_000), true);
  assert.equal(verifyWebhookSignature(signature, timestamp, `${body} `, "test-secret", 1_700_000_000), false);
  assert.equal(verifyWebhookSignature(signature, timestamp, body, "test-secret", 1_700_000_400), false);
});
