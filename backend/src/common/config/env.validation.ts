/**
 * ==============================================================================
 * FILE: backend/src/common/config/env.validation.ts
 * PURPOSE:
 *   Validates and parses environment variables at application startup.
 *   Provides a strongly-typed configuration object for the HookPulse system.
 *
 * RESPONSIBILITIES:
 *   - Define the schema of required and optional environment variables using Zod.
 *   - Parse raw string variables from process.env into appropriate types (numbers, booleans).
 *   - Implement the "Fail-Fast" engineering principle: immediately crash on startup
 *     with actionable error logs if critical configuration (e.g. DATABASE_URL) is missing.
 *   - Export a TypeScript type (EnvConfig) for compile-time safety across all modules.
 *
 * WHY IT EXISTS:
 *   In production, distributed microservices often fail silently or crash midway through
 *   execution when an expected environment variable is undefined or formatted incorrectly.
 *   Validating the environment during bootstrap guarantees that the service only runs
 *   when its operational dependencies are completely satisfied.
 *
 * INTERACTIONS:
 *   - Injected into NestJS's ConfigModule in AppModule and WorkerModule.
 *   - Read by database connection pools, Redis clients, and BullMQ worker options.
 *
 * IMPLEMENTATION NOTES:
 *   - Uses Zod transforms (`z.coerce.number()`) because process.env always stores values as strings.
 *   - Formats validation errors into human-readable bullet points for junior developers.
 * ==============================================================================
 */

import { z } from 'zod';

/**
 * Zod schema defining the contract for all environment variables in HookPulse.
 *
 * Junior Dev Tip:
 * Notice we use `z.coerce.number()`. Why? Because `process.env.PORT` is always the string "3001",
 * not the number 3001. Zod's `coerce` automatically parses the string into a JavaScript number!
 */
export const envSchema = z.object({
  // Runtime environment mode
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development')
    .describe('Current operating environment mode'),

  // Port for the HTTP Ingestion API
  PORT: z.coerce
    .number()
    .min(1024, 'Port must be a non-privileged port (>= 1024)')
    .max(65535, 'Port cannot exceed maximum TCP limit (65535)')
    .default(3001),

  // PostgreSQL Connection String (e.g. postgres://user:pass@localhost:5432/dbname)
  DATABASE_URL: z
    .string({
      required_error: 'DATABASE_URL is required for PostgreSQL persistence.',
    })
    .url('DATABASE_URL must be a valid connection URI (e.g., postgres://user:pass@host:5432/db)'),

  // Redis Hostname (e.g. "localhost" locally or "redis" inside Docker)
  REDIS_HOST: z
    .string()
    .default('localhost')
    .describe('Redis host for BullMQ and distributed locks'),

  // Redis TCP Port
  REDIS_PORT: z.coerce
    .number()
    .default(6379),

  // Optional authentication password for Redis
  REDIS_PASSWORD: z
    .string()
    .optional()
    .describe('Redis password authentication secret'),

  // Redis logical database index (0-15)
  REDIS_DB: z.coerce
    .number()
    .min(0)
    .max(15)
    .default(0),

  // Cryptographic master secret key (used for encrypting stored secrets at rest or auth tokens)
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET / Master key must be at least 32 characters long for cryptographic safety.')
    .default('hookpulse_super_secret_master_encryption_key_32bytes'),

  // Number of concurrent jobs a single worker node will process simultaneously
  BULLMQ_CONCURRENCY: z.coerce
    .number()
    .min(1, 'Concurrency must be at least 1')
    .max(100, 'Concurrency above 100 may saturate Node event loop thread pool')
    .default(20),

  // Outbound HTTP socket timeout in milliseconds
  OUTBOUND_TIMEOUT_MS: z.coerce
    .number()
    .min(500, 'Timeout too low (< 500ms) will cause false positive failure spikes')
    .max(30000, 'Timeout too high (> 30s) risks exhausting worker sockets')
    .default(5000),

  // Maximum number of retry attempts before quarantining an event to the Dead-Letter Queue
  MAX_RETRY_ATTEMPTS: z.coerce
    .number()
    .min(1)
    .max(10)
    .default(5),

  // Base delay in milliseconds for exponential backoff calculations
  BASE_RETRY_DELAY_MS: z.coerce
    .number()
    .min(100)
    .default(1000),
});

/**
 * TypeScript type inferred directly from the Zod schema.
 * Any update to the schema above immediately updates this type!
 */
export type EnvConfig = z.infer<typeof envSchema>;

/**
 * Validation function passed to NestJS ConfigModule:
 * ConfigModule.forRoot({ validate: validateEnv })
 *
 * @param config Raw process.env object
 * @returns Fully validated and typed EnvConfig object
 * @throws Error with detailed explanations if validation fails
 */
export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const result = envSchema.safeParse(config);

  if (!result.success) {
    // Collect all validation errors into a clean, human-readable terminal output
    const errorMessages = result.error.errors
      .map((issue) => `  - [${issue.path.join('.')}] ${issue.message}`)
      .join('\n');

    const formattedBanner = `
================================================================================
🚨 HOOKPULSE CONFIGURATION ERROR: INVALID ENVIRONMENT VARIABLES 🚨
================================================================================
The application cannot start because the following environment variables failed validation:

${errorMessages}

Please check your .env file or Docker environment settings before restarting.
================================================================================
`;
    // Fail Fast: log clearly and throw to halt container bootstrap
    console.error(formattedBanner);
    throw new Error('Invalid environment configuration');
  }

  return result.data;
}
