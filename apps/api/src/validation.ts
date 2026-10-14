import { z } from "zod";

export const eventSchema = z.object({
  type: z.string().min(1).max(200),
  payload: z.record(z.unknown()),
  destinationIds: z.array(z.string().min(1)).min(1).max(20),
}).strict();

export const runSchema = z.object({
  scenario:z.string().min(1).max(100),
  destinationIds:z.array(z.string()).min(1).max(6),
  eventCount:z.number().int().min(1).max(500),
  concurrency:z.number().int().min(1).max(50),
  maxP95Ms:z.number().int().min(1).max(60000).default(1000),
  maxErrorRate:z.number().min(0).max(100).default(5),
});
