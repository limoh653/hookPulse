/**
 * ==============================================================================
 * FILE: backend/src/infrastructure/database/drizzle.schema.ts
 * PURPOSE:
 *   Provides the strongly-typed Drizzle ORM schema mapping for PostgreSQL 16.
 *   Enables type-safe database queries, inserts, and relational joins.
 *
 * RESPONSIBILITIES:
 *   - Define TypeScript representations of PostgreSQL tables: tenants, endpoints,
 *     events, and delivery_attempts.
 *   - Define foreign key relationships and cascade delete rules between tables.
 *   - Infer and export TypeScript types (Insert and Select models) for every table.
 *
 * WHY IT EXISTS:
 *   While raw SQL migrations (schema.sql) build the database tables, application
 *   code needs compile-time type checking. Drizzle ORM guarantees that if a column
 *   name changes or a type is modified, TypeScript catches errors before deployment.
 *
 * INTERACTIONS:
 *   - Used by repositories in the infrastructure layer to execute typed SQL queries.
 *   - Maps directly to the tables created in schema.sql.
 *
 * IMPLEMENTATION NOTES:
 *   - Uses `jsonb()` for arbitrary webhook payloads and response headers.
 *   - Uses `timestamp({ withTimezone: true })` to prevent UTC offset discrepancies.
 * ==============================================================================
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// -----------------------------------------------------------------------------
// 1. Tenants Table Definition
// -----------------------------------------------------------------------------
export const tenants = pgTable('tenants', {
  // Unique UUID primary key generated natively by PostgreSQL
  id: uuid('id').defaultRandom().primaryKey(),

  // Human-readable organization or service name
  name: varchar('name', { length: 255 }).notNull(),

  // SHA-256 hash of the client's API key
  apiKeyHash: varchar('api_key_hash', { length: 255 }).notNull().unique(),

  // Audit timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// -----------------------------------------------------------------------------
// 2. Endpoints Table Definition
// -----------------------------------------------------------------------------
export const endpoints = pgTable(
  'endpoints',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    // Scoped tenant foreign key with cascading delete
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    // Outbound destination URL
    targetUrl: text('target_url').notNull(),

    // HMAC-SHA256 signing secret
    secretKey: varchar('secret_key', { length: 255 }).notNull(),

    // Max requests per second allowed for this endpoint
    rateLimitPerSec: integer('rate_limit_per_sec').default(50).notNull(),

    // Circuit breaker state: 'ACTIVE' | 'CIRCUIT_OPEN' | 'DISABLED'
    status: varchar('status', { length: 50 }).default('ACTIVE').notNull(),

    // Number of consecutive failed dispatches
    consecutiveFailures: integer('consecutive_failures').default(0).notNull(),

    // When the circuit breaker was tripped open
    circuitOpenedAt: timestamp('circuit_opened_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // Index for quick lookups of a tenant's endpoints
    tenantIdx: index('idx_endpoints_tenant').on(table.tenantId),
  }),
);

// -----------------------------------------------------------------------------
// 3. Events Table Definition
// -----------------------------------------------------------------------------
export const events = pgTable(
  'events',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => endpoints.id, { onDelete: 'cascade' }),

    // Event type category (e.g. "payment.succeeded")
    eventType: varchar('event_type', { length: 100 }).notNull(),

    // Raw payload stored as queryable binary JSON (JSONB)
    payload: jsonb('payload').notNull(),

    // Upstream idempotency deduplication key
    idempotencyKey: varchar('idempotency_key', { length: 255 }).unique(),

    // Event status: 'PENDING' | 'DELIVERED' | 'FAILED' | 'DLQ'
    status: varchar('status', { length: 50 }).default('PENDING').notNull(),

    // Total retry attempts made so far
    retryCount: integer('retry_count').default(0).notNull(),

    // Scheduled timestamp for next retry attempt
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    tenantEndpointIdx: index('idx_events_tenant_endpoint').on(table.tenantId, table.endpointId),
    statusCreatedAtIdx: index('idx_events_status_created_at').on(table.status, table.createdAt),
  }),
);

// -----------------------------------------------------------------------------
// 4. Delivery Attempts Table Definition
// -----------------------------------------------------------------------------
export const deliveryAttempts = pgTable(
  'delivery_attempts',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    // Associated event
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),

    // Attempt count (1, 2, 3...)
    attemptNumber: integer('attempt_number').notNull(),

    // Response HTTP status code (e.g. 200, 500)
    responseStatusCode: integer('response_status_code'),

    // Response headers returned by client endpoint
    responseHeaders: jsonb('response_headers'),

    // Snippet of response body
    responseBody: text('response_body'),

    // Roundtrip duration in milliseconds
    executionTimeMs: integer('execution_time_ms').notNull(),

    // Network or DNS error description if request failed before HTTP response
    errorMessage: text('error_message'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    eventIdIdx: index('idx_attempts_event_id').on(table.eventId),
  }),
);

// -----------------------------------------------------------------------------
// 5. Relational Graph Definitions (for Drizzle relational queries)
// -----------------------------------------------------------------------------
export const tenantsRelations = relations(tenants, ({ many }) => ({
  endpoints: many(endpoints),
  events: many(events),
}));

export const endpointsRelations = relations(endpoints, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [endpoints.tenantId],
    references: [tenants.id],
  }),
  events: many(events),
}));

export const eventsRelations = relations(events, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [events.tenantId],
    references: [tenants.id],
  }),
  endpoint: one(endpoints, {
    fields: [events.endpointId],
    references: [endpoints.id],
  }),
  deliveryAttempts: many(deliveryAttempts),
}));

export const deliveryAttemptsRelations = relations(deliveryAttempts, ({ one }) => ({
  event: one(events, {
    fields: [deliveryAttempts.eventId],
    references: [events.id],
  }),
}));

// -----------------------------------------------------------------------------
// 6. Inferred TypeScript Types
// -----------------------------------------------------------------------------
export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;

export type Endpoint = typeof endpoints.$inferSelect;
export type NewEndpoint = typeof endpoints.$inferInsert;

export type WebhookEventRecord = typeof events.$inferSelect;
export type NewWebhookEventRecord = typeof events.$inferInsert;

export type DeliveryAttemptRecord = typeof deliveryAttempts.$inferSelect;
export type NewDeliveryAttemptRecord = typeof deliveryAttempts.$inferInsert;
