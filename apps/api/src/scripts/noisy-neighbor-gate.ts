import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";

if (process.env.COREBIZ_CONFIRM_DISPOSABLE_DB !== "YES") {
  throw new Error(
    "BLOCKED: noisy-neighbor gate requires COREBIZ_CONFIRM_DISPOSABLE_DB=YES"
  );
}

const redisUrl = process.env.REDIS_URL?.trim();
if (!redisUrl) {
  throw new Error("BLOCKED: REDIS_URL is required");
}

const redis = new Redis(redisUrl, {
  lazyConnect: false,
  maxRetriesPerRequest: 1,
  enableReadyCheck: true
});

const prefix = "corebiz:release:noisy:" + randomUUID();

async function acquire(
  key: string,
  token: string,
  limit: number,
  ttlSeconds: number
): Promise<boolean> {
  const now = Date.now();
  const expiresAt = now + Math.max(1, ttlSeconds) * 1000;

  const result = await redis.eval(
    `
    redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])
    local count = redis.call("ZCARD", KEYS[1])
    if count >= tonumber(ARGV[3]) then
      return 0
    end
    redis.call("ZADD", KEYS[1], ARGV[2], ARGV[4])
    redis.call("EXPIRE", KEYS[1], ARGV[5])
    return 1
    `,
    1,
    key,
    String(now),
    String(expiresAt),
    String(limit),
    token,
    String(Math.max(1, ttlSeconds))
  );

  return Number(result) === 1;
}

async function main(): Promise<void> {
  assert.equal(await redis.ping(), "PONG", "Redis must be reachable");

  const concurrencyKey = prefix + ":concurrency";
  const tokens = Array.from({ length: 20 }, () => randomUUID());

  const results = await Promise.all(
    tokens.map((token) => acquire(concurrencyKey, token, 2, 30))
  );

  const accepted = results.filter(Boolean).length;
  assert.equal(
    accepted,
    2,
    "Atomic semaphore must accept exactly the configured concurrency limit"
  );

  const acceptedTokens = tokens.filter((_, index) => results[index]);
  await redis.zrem(concurrencyKey, acceptedTokens[0]!);

  assert.equal(
    await acquire(concurrencyKey, randomUUID(), 2, 30),
    true,
    "Released semaphore slot must become available immediately"
  );

  const ttlKey = prefix + ":ttl";
  assert.equal(
    await acquire(ttlKey, "first", 1, 1),
    true,
    "Initial TTL lease must be acquired"
  );
  assert.equal(
    await acquire(ttlKey, "second", 1, 1),
    false,
    "Second lease must be denied while first lease is active"
  );

  await new Promise((resolve) => setTimeout(resolve, 1200));

  assert.equal(
    await acquire(ttlKey, "after-expiry", 1, 1),
    true,
    "Expired lease must not permanently block the semaphore"
  );

  const report = {
    ok: true,
    concurrentAttempts: tokens.length,
    limit: 2,
    accepted,
    releaseRecovery: true,
    ttlRecovery: true
  };

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(
    "PASS: atomic Redis noisy-neighbor semaphore and TTL recovery\n"
  );
}

main()
  .catch((error) => {
    process.stderr.write(
      "FAIL: noisy-neighbor gate: " +
        (error instanceof Error ? error.stack ?? error.message : String(error)) +
        "\n"
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      const keys = await redis.keys(prefix + "*");
      if (keys.length) await redis.del(...keys);
    } finally {
      await redis.quit();
    }
  });
