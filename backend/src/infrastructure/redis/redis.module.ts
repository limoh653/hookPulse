/**
 * ==============================================================================
 * FILE: backend/src/infrastructure/redis/redis.module.ts
 * PURPOSE:
 *   Configures and provides the managed Redis (ioredis) client instance.
 *   Registers atomic Lua scripts for high-performance distributed operations.
 *
 * RESPONSIBILITIES:
 *   - Establish a persistent, auto-reconnecting connection to Redis 7.
 *   - Load and compile custom Lua scripts (e.g. Token Bucket rate limiter) via EVALSHA.
 *   - Provide the REDIS_CLIENT injection token for services and BullMQ queues.
 *   - Handle connection lifecycle events and graceful shutdown.
 *
 * WHY IT EXISTS:
 *   HookPulse requires Redis for sub-millisecond atomic operations:
 *   1) Ingestion event deduplication (24-hour idempotency keys via SET NX EX).
 *   2) Per-endpoint distributed rate limiting without multi-worker race conditions.
 *   3) Underpinning BullMQ job scheduling queues.
 *
 * INTERACTIONS:
 *   - Consumes Redis configuration from ConfigService (validated by env.validation.ts).
 *   - Injects REDIS_CLIENT into IngestionService, RateLimiterService, and BullMQ providers.
 *
 * IMPLEMENTATION NOTES:
 *   - Uses `defineCommand` to pre-compile Lua scripts into Redis SHA1 hashes.
 *   - Decorated with `@Global()` so all modules can inject the shared Redis client.
 * ==============================================================================
 */

import {
  Module,
  Global,
  OnApplicationShutdown,
  Logger,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import * as fs from 'fs';
import * as path from 'path';

// Injection token for the Redis client
export const REDIS_CLIENT = 'REDIS_CLIENT';

/**
 * Extended ioredis client type declaring custom Lua commands registered via `defineCommand`.
 */
export interface HookPulseRedis extends Redis {
  /**
   * Custom atomic Token Bucket command defined in token-bucket.lua.
   *
   * @param key Redis key for endpoint bucket (e.g. "ratelimit:endpoint:<id>")
   * @param capacity Max bucket burst capacity (number of tokens)
   * @param refillRate Tokens added per millisecond (refill_per_sec / 1000)
   * @param now Current timestamp in milliseconds (Date.now())
   * @param cost Number of tokens requested (usually 1)
   * @returns 1 if permitted (token deducted), 0 if throttled (empty bucket)
   */
  tokenBucket(
    key: string,
    capacity: number,
    refillRate: number,
    now: number,
    cost: number,
  ): Promise<number>;
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: async (configService: ConfigService): Promise<HookPulseRedis> => {
        const logger = new Logger('RedisClient');

        const host = configService.get<string>('REDIS_HOST', 'localhost');
        const port = configService.get<number>('REDIS_PORT', 6379);
        const password = configService.get<string | undefined>('REDIS_PASSWORD');
        const db = configService.get<number>('REDIS_DB', 0);

        logger.log(`Connecting to Redis at ${host}:${port} (db: ${db})...`);

        const redis = new Redis({
          host,
          port,
          password: password || undefined,
          db,
          // Reconnect strategy with exponential backoff up to 3 seconds
          retryStrategy: (times: number) => {
            const delay = Math.min(times * 100, 3000);
            logger.warn(`Redis disconnected. Reconnecting in ${delay}ms (attempt ${times})...`);
            return delay;
          },
          // Maximum number of reconnect attempts before giving up
          maxRetriesPerRequest: null, // Required by BullMQ for blocking pop commands
          enableReadyCheck: true,
        }) as HookPulseRedis;

        // Listen to connection lifecycle events
        redis.on('connect', () => {
          logger.log('Connected to Redis server.');
        });

        redis.on('ready', () => {
          logger.log('✅ Redis client is ready to accept commands.');
        });

        redis.on('error', (err) => {
          logger.error('❌ Redis client connection error:', err);
        });

        // -----------------------------------------------------------------------
        // Load and register the Token Bucket Lua Script
        // Junior Dev Tip: Redis Lua scripts run atomically! Using `defineCommand`
        // sends the script to Redis once via SCRIPT LOAD, returning a SHA1 hash.
        // Subsequent calls execute EVALSHA for microsecond speed.
        // -----------------------------------------------------------------------
        try {
          const luaPath = path.join(__dirname, 'lua', 'token-bucket.lua');
          const luaScript = fs.readFileSync(luaPath, 'utf8');

          redis.defineCommand('tokenBucket', {
            numberOfKeys: 1,
            lua: luaScript,
          });

          logger.log('✅ Registered atomic "tokenBucket" Lua script into Redis.');
        } catch (err) {
          logger.error('Failed to load token-bucket.lua script:', err);
          throw err;
        }

        return redis;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisModule.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Graceful Shutdown Hook:
   * Disconnects from Redis cleanly when the application terminates.
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`Received ${signal || 'shutdown signal'}. Quitting Redis client...`);
    try {
      await this.redis.quit();
      this.logger.log('Redis connection closed cleanly.');
    } catch (err) {
      this.logger.error('Error while disconnecting Redis:', err);
    }
  }
}
