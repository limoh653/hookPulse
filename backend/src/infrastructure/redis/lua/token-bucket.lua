-- ==============================================================================
-- FILE: backend/src/infrastructure/redis/lua/token-bucket.lua
-- PURPOSE:
--   Executes an atomic Token Bucket rate limit algorithm directly inside Redis.
--   Enforces per-endpoint throughput limits (e.g. 50 requests/sec) across all workers.
--
-- RESPONSIBILITIES:
--   - Maintain token bucket state (last_updated, tokens) in a Redis Hash.
--   - Calculate continuous token replenishment based on elapsed time (Delta T).
--   - Deduct requested tokens if available and return 1 (Permitted).
--   - Reject request if insufficient tokens and return 0 (Throttled).
--   - Automatically set key TTL to evict idle rate limiter buckets from RAM.
--
-- WHY IT EXISTS:
--   In a distributed multi-worker setup, if two workers check a rate limit using separate
--   GET and SET commands, both workers see "tokens available" and dispatch simultaneously.
--   This "Check-Then-Act" race condition causes downstream endpoints to be overwhelmed.
--   Because Redis executes Lua scripts in a single-threaded atomic operation, no other
--   command can interleave, eliminating race conditions completely.
--
-- PARAMETERS:
--   KEYS[1]: The rate limit bucket key (e.g., "ratelimit:endpoint:<uuid>")
--   ARGV[1]: Max bucket capacity (burst limit, e.g., 50)
--   ARGV[2]: Refill rate per millisecond (refill_per_sec / 1000, e.g., 0.05)
--   ARGV[3]: Current UNIX timestamp in milliseconds (Date.now())
--   ARGV[4]: Cost in tokens requested (usually 1)
--
-- RETURNS:
--   1: Allowed (token successfully deducted; proceed with HTTP dispatch)
--   0: Throttled (rate limit exceeded; reschedule job with delay)
-- ==============================================================================

local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])

-- -----------------------------------------------------------------------------
-- Step 1: Retrieve current bucket state from Redis Hash
-- -----------------------------------------------------------------------------
local data = redis.call("HMGET", key, "tokens", "last_updated")
local current_tokens = tonumber(data[1])
local last_updated = tonumber(data[2])

-- -----------------------------------------------------------------------------
-- Step 2: Initialize or replenish the bucket
-- -----------------------------------------------------------------------------
if current_tokens == nil or last_updated == nil then
    -- First time this endpoint is accessed: initialize bucket full of tokens
    current_tokens = capacity
    last_updated = now
else
    -- Endpoint already has a bucket: calculate tokens replenished since last check
    local elapsed_ms = math.max(0, now - last_updated)
    local replenished_tokens = elapsed_ms * refill_rate

    -- Tokens cannot exceed the maximum bucket capacity
    current_tokens = math.min(capacity, current_tokens + replenished_tokens)
    last_updated = now
end

-- -----------------------------------------------------------------------------
-- Step 3: Check if enough tokens are available
-- -----------------------------------------------------------------------------
if current_tokens >= requested then
    -- SUCCESS: Deduct tokens and persist state
    local remaining_tokens = current_tokens - requested
    redis.call("HMSET", key, "tokens", remaining_tokens, "last_updated", last_updated)

    -- Set an expiration TTL (e.g. 60 seconds of inactivity) to prevent memory leaks
    redis.call("EXPIRE", key, 60)

    return 1
else
    -- THROTTLED: Update replenished state so future requests get credit for elapsed time
    redis.call("HMSET", key, "tokens", current_tokens, "last_updated", last_updated)
    redis.call("EXPIRE", key, 60)

    return 0
end
