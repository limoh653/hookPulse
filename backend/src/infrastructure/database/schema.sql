-- ==============================================================================
-- FILE: backend/src/infrastructure/database/schema.sql
-- PURPOSE:
--   Defines the complete PostgreSQL 16 database schema, tables, constraints,
--   and performance indexes for HookPulse.
--
-- RESPONSIBILITIES:
--   - Enable native UUID generation via the standard PostgreSQL pgcrypto extension.
--   - Establish multi-tenant relational isolation (tenants -> endpoints -> events -> delivery_attempts).
--   - Enforce data integrity via CHECK constraints, NOT NULL constraints, and foreign keys.
--   - Provide optimized composite B-tree indexes for fast dashboard lookups and queue filtering.
--
-- WHY IT EXISTS:
--   Durable event logging and multi-tenant audit ledgers require ACID transactional guarantees.
--   While Redis handles volatile queueing, PostgreSQL acts as the single source of truth for
--   webhook lifecycle states, endpoint configurations, and historical delivery attempt records.
--
-- INTERACTIONS:
--   - Executed automatically on container initialization by docker-compose.yml.
--   - Mapped to TypeScript models and queries via Drizzle ORM in the application layer.
--
-- IMPLEMENTATION NOTES:
--   - Uses TIMESTAMPTZ (timestamp with time zone) everywhere to eliminate timezone conversion bugs.
--   - Uses JSONB for webhook payloads and HTTP response headers for queryable JSON storage.
--   - Implements ON DELETE CASCADE on child records to ensure clean tenant offboarding.
-- ==============================================================================

-- -----------------------------------------------------------------------------
-- 0. Extensions
-- Ensure cryptographic functions like gen_random_uuid() are available.
-- In PostgreSQL 13+, gen_random_uuid() is built-in, but pgcrypto provides extra safety.
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -----------------------------------------------------------------------------
-- 1. Tenants Table
-- Represents individual B2B customers or internal teams using HookPulse.
-- Every resource (endpoints, events) is strictly scoped to a tenant_id.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
    -- Unique identifier for each tenant
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Human-readable name of the organization or application (e.g., "PayQuick Prod")
    name VARCHAR(255) NOT NULL,

    -- Secure SHA-256 hash of the tenant's API secret key.
    -- We NEVER store raw API keys in plaintext to mitigate database leak risks.
    api_key_hash VARCHAR(255) NOT NULL UNIQUE,

    -- Audit timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Junior Dev Note: Add an explanatory comment to the table for database exploration tools
COMMENT ON TABLE tenants IS 'Represents isolated SaaS tenants or organizations using HookPulse.';
COMMENT ON COLUMN tenants.api_key_hash IS 'Cryptographic hash of the API key used for upstream ingestion authentication.';

-- -----------------------------------------------------------------------------
-- 2. Endpoints Table
-- Destination URLs where webhooks will be dispatched, registered per tenant.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS endpoints (
    -- Unique endpoint identifier
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Enforces multi-tenant isolation. Deleting a tenant automatically cleans up its endpoints.
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    -- Target destination URL (e.g., "https://api.customer.com/webhooks")
    target_url TEXT NOT NULL,

    -- Pre-shared secret key used to compute the HMAC-SHA256 signature for this endpoint.
    -- Must be securely generated and shared with the client endpoint owner.
    secret_key VARCHAR(255) NOT NULL,

    -- Maximum number of HTTP requests HookPulse is allowed to send per second to this destination.
    -- Defaults to 50 RPS to protect client infrastructure from being overwhelmed.
    rate_limit_per_sec INT NOT NULL DEFAULT 50 CHECK (rate_limit_per_sec > 0),

    -- Circuit breaker state:
    -- 'ACTIVE': Normal operation; dispatches proceed.
    -- 'CIRCUIT_OPEN': Paused temporarily due to high consecutive failures (e.g., 50 consecutive 5xxs).
    -- 'DISABLED': Administratively disabled by user or admin.
    status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CIRCUIT_OPEN', 'DISABLED')),

    -- Tracks consecutive network or 5xx failures to trip the circuit breaker.
    consecutive_failures INT NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),

    -- Records when the circuit was opened so workers know when the cooling-off period expires.
    circuit_opened_at TIMESTAMPTZ,

    -- Audit timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE endpoints IS 'Target third-party webhook destination URLs and their security configurations.';
COMMENT ON COLUMN endpoints.rate_limit_per_sec IS 'Max requests per second enforced by Redis Token Bucket algorithm.';
COMMENT ON COLUMN endpoints.status IS 'Circuit breaker lifecycle state protecting downstream receivers.';

-- -----------------------------------------------------------------------------
-- 3. Events Table
-- Durable ledger of every webhook event ingested into the system.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
    -- Unique identifier returned to the upstream caller on HTTP 202 Accepted.
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Multi-tenant parent references
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    endpoint_id UUID NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,

    -- Domain event identifier (e.g., "payment.completed", "invoice.created")
    event_type VARCHAR(100) NOT NULL,

    -- Arbitrary JSON payload emitted by upstream application.
    -- Stored as binary JSON (JSONB) for high-performance parsing and indexed filtering.
    payload JSONB NOT NULL,

    -- Client-supplied idempotency key (e.g. from upstream header `Idempotency-Key`).
    -- Unique constraint guarantees no duplicate events can ever be created within a tenant.
    idempotency_key VARCHAR(255) UNIQUE,

    -- Delivery lifecycle state:
    -- 'PENDING': Queued in Redis/BullMQ waiting for worker execution.
    -- 'DELIVERED': Successfully delivered with an HTTP 2xx response.
    -- 'FAILED': Retry attempts in progress.
    -- 'DLQ': Dead-Letter Queue; all retries exhausted or invalid endpoint.
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED', 'DLQ')),

    -- Count of attempts executed so far for this event.
    retry_count INT NOT NULL DEFAULT 0 CHECK (retry_count >= 0),

    -- Timestamp when the next exponential backoff retry attempt is scheduled.
    next_retry_at TIMESTAMPTZ,

    -- Audit timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE events IS 'Durable record of all ingested webhook payloads and their delivery statuses.';
COMMENT ON COLUMN events.idempotency_key IS 'Unique key provided by the upstream producer to prevent duplicate ingestion.';

-- -----------------------------------------------------------------------------
-- 4. Delivery Attempts Table
-- Immutable audit log recording every single outbound HTTP dispatch attempt.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS delivery_attempts (
    -- Unique identifier for this individual attempt record
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Associated event. If the event is deleted, its execution logs cascade delete.
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,

    -- Attempt sequence number (1 for initial dispatch, 2 for first retry, etc.)
    attempt_number INT NOT NULL CHECK (attempt_number >= 1),

    -- HTTP status code returned by client server (e.g., 200, 404, 503).
    -- Nullable because socket timeouts or DNS failures do not yield an HTTP status code.
    response_status_code INT,

    -- Response headers returned by client server (useful for debugging rate limits, etc.)
    response_headers JSONB,

    -- Snippet of response body returned by the client server (truncated to prevent DB bloat)
    response_body TEXT,

    -- Latency of the outbound HTTP roundtrip measured in milliseconds
    execution_time_ms INT NOT NULL CHECK (execution_time_ms >= 0),

    -- System error message if a network timeout, SSL handshake failure, or DNS error occurred
    error_message TEXT,

    -- Timestamp of this execution attempt
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE delivery_attempts IS 'Immutable audit ledger of every outbound HTTP request attempt and response.';

-- -----------------------------------------------------------------------------
-- 5. Performance Indexes
-- Essential B-tree indexes to maintain sub-millisecond query performance
-- under high throughput (millions of logged events).
-- -----------------------------------------------------------------------------

-- Speeds up queries filtering endpoints by tenant (e.g., dashboard listing)
CREATE INDEX IF NOT EXISTS idx_endpoints_tenant ON endpoints(tenant_id);

-- Speeds up queries fetching events for a specific tenant and endpoint
CREATE INDEX IF NOT EXISTS idx_events_tenant_endpoint ON events(tenant_id, endpoint_id);

-- Speeds up dashboard queries filtering events by status and ordering by latest created
CREATE INDEX IF NOT EXISTS idx_events_status_created_at ON events(status, created_at DESC);

-- Speeds up delivery attempt lookups for an event (e.g., viewing attempt history in UI)
CREATE INDEX IF NOT EXISTS idx_attempts_event_id ON delivery_attempts(event_id);

-- Partial index for fast lookups on idempotency keys while ignoring null values
CREATE INDEX IF NOT EXISTS idx_events_idempotency_key ON events(idempotency_key) WHERE idempotency_key IS NOT NULL;
