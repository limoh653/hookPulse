/**
 * ==============================================================================
 * FILE: backend/src/infrastructure/database/database.module.ts
 * PURPOSE:
 *   Configures and provides the PostgreSQL connection pool and Drizzle ORM client.
 *   Manages the lifecycle of database connections across application startup and shutdown.
 *
 * RESPONSIBILITIES:
 *   - Initialize a managed `pg.Pool` connection pool using validated DATABASE_URL.
 *   - Instantiate and export the Drizzle ORM database instance (`DRIZZLE_DB`).
 *   - Implement graceful shutdown (`OnApplicationShutdown`) to drain active connections.
 *   - Verify database reachability on startup with a heartbeat query (`SELECT 1`).
 *
 * WHY IT EXISTS:
 *   Creating a new database connection for every incoming HTTP request or queue job
 *   introduces severe latency (20-50ms per connection handshake) and quickly exhausts
 *   PostgreSQL's max_connections limit. A connection pool keeps a warm set of reusable
 *   connections available for immediate execution.
 *
 * INTERACTIONS:
 *   - Consumes DATABASE_URL from NestJS ConfigService (validated by env.validation.ts).
 *   - Provides DRIZZLE_DB and PG_POOL to application repositories and worker handlers.
 *
 * IMPLEMENTATION NOTES:
 *   - Decorated with `@Global()` so database access is universally available across modules.
 *   - Sets connection pool size to max 20 connections per container instance.
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
import { Pool } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './drizzle.schema';

// -----------------------------------------------------------------------------
// Dependency Injection Tokens
// Junior Dev Tip: In NestJS, when injecting something that isn't a class (like a
// configured object or connection pool), we use unique string/symbol tokens.
// -----------------------------------------------------------------------------
export const PG_POOL = 'PG_POOL';
export const DRIZZLE_DB = 'DRIZZLE_DB';

export type DrizzleDB = NodePgDatabase<typeof schema>;

@Global()
@Module({
  providers: [
    // 1. Provider for the underlying PostgreSQL Connection Pool
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: async (configService: ConfigService): Promise<Pool> => {
        const logger = new Logger('DatabasePool');
        const databaseUrl = configService.getOrThrow<string>('DATABASE_URL');

        logger.log('Initializing PostgreSQL connection pool...');

        const pool = new Pool({
          connectionString: databaseUrl,
          // Maximum active connections in the pool
          max: 20,
          // How long a client is allowed to remain idle before being closed (30 seconds)
          idleTimeoutMillis: 30000,
          // How long to wait when connecting a new client before timing out (5 seconds)
          connectionTimeoutMillis: 5000,
        });

        // Test the connection immediately on startup (Fail-Fast principle)
        try {
          const client = await pool.connect();
          await client.query('SELECT 1;');
          client.release();
          logger.log('✅ PostgreSQL connection pool established successfully.');
        } catch (error) {
          logger.error('❌ Failed to connect to PostgreSQL database:', error);
          throw error;
        }

        // Log pool-level errors to prevent silent unhandled error crashes
        pool.on('error', (err) => {
          logger.error('Unexpected error on idle PostgreSQL client:', err);
        });

        return pool;
      },
    },

    // 2. Provider for the Drizzle ORM client wrapped around the connection pool
    {
      provide: DRIZZLE_DB,
      inject: [PG_POOL],
      useFactory: (pool: Pool): DrizzleDB => {
        return drizzle(pool, { schema });
      },
    },
  ],
  exports: [PG_POOL, DRIZZLE_DB],
})
export class DatabaseModule implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseModule.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Graceful Shutdown Hook:
   * Called when NestJS receives SIGINT or SIGTERM (e.g. during a Docker stop or deploy).
   * Ensures all in-flight queries finish before the pool terminates its TCP connections.
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`Received ${signal || 'shutdown signal'}. Draining PostgreSQL pool...`);
    try {
      await this.pool.end();
      this.logger.log('PostgreSQL connection pool drained cleanly.');
    } catch (err) {
      this.logger.error('Error while draining PostgreSQL pool:', err);
    }
  }
}
