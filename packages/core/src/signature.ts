import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function signWebhook(timestamp: string, rawBody: string, secret: string): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

export function signPayload(rawBody: string, secret: string): string {
  return signWebhook(String(Math.floor(Date.now() / 1_000)), rawBody, secret);
}

export function verifyWebhookSignature(
  signature: string | undefined,
  timestamp: string | undefined,
  rawBody: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): boolean {
  if (!signature || !timestamp || !/^\d+$/.test(timestamp)) return false;
  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > 300) return false;
  const expected = signWebhook(timestamp, rawBody, secret).split(",v1=")[1];
  const actual = signature.split(",v1=")[1];
  if (!expected || !actual || !/^[a-f\d]{64}$/i.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}

function encryptionKey(): Buffer {
  const value = process.env.APP_ENCRYPTION_KEY;
  if (!value || Buffer.byteLength(value) !== 32) {
    throw new Error("APP_ENCRYPTION_KEY must be exactly 32 bytes");
  }
  return Buffer.from(value, "utf8");
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}

export function decryptSecret(value: string): string {
  const [ivPart, tagPart, ciphertextPart] = value.split(".");
  if (!ivPart || !tagPart || !ciphertextPart) throw new Error("Malformed encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
