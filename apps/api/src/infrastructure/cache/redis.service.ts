import { Injectable, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import { getEnv } from "../config/env";

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client = new Redis(getEnv().redisUrl, {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true
  });

  async incrementWindow(
    key: string,
    windowSeconds: number
  ): Promise<number> {
    const value = await this.client.incr(key);
    if (value === 1) {
      await this.client.expire(key, windowSeconds);
    }
    return value;
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }

  async acquireSemaphore(
    key: string,
    token: string,
    limit: number,
    ttlSeconds: number
  ): Promise<boolean> {
    const now = Date.now();
    const expiresAt = now + Math.max(1, ttlSeconds) * 1000;

    const result = await this.client.eval(
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

  async releaseSemaphore(key: string, token: string): Promise<void> {
    await this.client.zrem(key, token);
  }

  async ping(): Promise<string> {
    return this.client.ping();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}
