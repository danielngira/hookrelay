# HookRelay roadmap

## MVP shipped in this repository

- [x] Compose-based local stack with PostgreSQL, Redis, API, worker, receiver simulator, and dashboard.
- [x] Transactional event acceptance and PostgreSQL outbox dispatch.
- [x] Idempotency key behavior, signed webhook requests, and encrypted simulator secrets.
- [x] Retryable/permanent HTTP classification, jittered backoff, Retry-After, and bounded attempts.
- [x] Run batches, saved results, latency/throughput/error metrics, delivery detail, and replay.
- [x] Core unit tests for retry policy, signatures/encryption, metric calculation, and run comparison.

## Next

1. Add PostgreSQL integration tests for event idempotency, transaction/outbox behavior, retry progression, and replay.
2. Add a dead-letter browser with filtering, pagination, bulk replay, and retention controls.
3. Record queue wait separately from receiver response time; chart time-series throughput and status codes.
4. Make benchmark settings truly per-run under overlapping tests, and report the configured versus effective worker concurrency.
5. Add automated Compose smoke tests to CI, including healthy, 429 retry, permanent failure, and exhaustion cases.
6. Add operator-facing settings for worker rate limits and pool sizes, with validation and before/after comparison.

## Current limitations

- The UI benchmark creates a bounded batch through one API request. It measures delivery throughput and receiver latency; it is not an HTTP load generator for arbitrary API endpoints.
- Worker concurrency is process-wide. A later run can change it while older work remains in the queue, so avoid overlapping runs when comparing concurrency settings.
- The receiver simulator writes an observation for every attempt. Production-grade receiver deduplication is outside the demo.
- Outbox polling is intended for the single local API instance. Multi-instance leasing and `SKIP LOCKED` claims need integration tests before horizontal scaling.
- No global ordering or exactly-once guarantee is provided.
