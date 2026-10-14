import { Queue } from "bullmq";
import { DELIVERY_QUEUE } from "@hookrelay/core";

export const redisConnection = {
  host: process.env.REDIS_HOST ?? "localhost",
  port: Number(process.env.REDIS_PORT ?? 6379),
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
};

export const deliveryQueue = new Queue(DELIVERY_QUEUE, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: Number(process.env.MAX_ATTEMPTS ?? 5),
    backoff: { type: "hookrelay", delay: 0 },
    removeOnComplete: { age: 86_400, count: 2_000 },
    removeOnFail: { age: 7 * 86_400, count: 2_000 },
  },
});
