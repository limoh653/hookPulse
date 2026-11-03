/**
 * ==============================================================================
 * FILE: backend/src/domain/entities/webhook-event.entity.ts
 * PURPOSE:
 *   Core Domain Entity representing a Webhook Event in the HookPulse gateway.
 *   Enforces state transitions, retry invariants, and lifecycle rules.
 *
 * RESPONSIBILITIES:
 *   - Encapsulate event state (id, tenant, endpoint, payload, retry counts).
 *   - Guard valid state transitions (e.g. preventing delivered events from failing).
 *   - Enforce Dead-Letter Queue (DLQ) threshold rules when retries are exhausted.
 *   - Provide pure domain business logic independent of databases or web frameworks.
 *
 * WHY IT EXISTS:
 *   In Clean Architecture, domain entities represent enterprise business rules.
 *   If controllers or queue workers mutate database rows directly (Anemic Domain Model),
 *   business rules (like "an event can only retry N times before moving to DLQ") become
 *   duplicated, scattered, and vulnerable to bugs. A Rich Domain Model centralizes this logic.
 *
 * INTERACTIONS:
 *   - Created by the Ingestion Use Case upon receiving an HTTP webhook event.
 *   - Mutated by the Dispatch Worker upon receiving HTTP 2xx or failure responses.
 *   - Reconstituted (hydrated) from the database by Drizzle repositories.
 *
 * IMPLEMENTATION NOTES:
 *   - Pure TypeScript: Contains ZERO imports from NestJS, Express, or Drizzle ORM.
 *   - Throws descriptive DomainErrors on illegal operations.
 * ==============================================================================
 */

export type EventStatus = 'PENDING' | 'DELIVERED' | 'FAILED' | 'DLQ';

export interface WebhookEventProps {
  id: string;
  tenantId: string;
  endpointId: string;
  eventType: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string | null;
  status: EventStatus;
  retryCount: number;
  nextRetryAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateEventProps {
  id?: string;
  tenantId: string;
  endpointId: string;
  eventType: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string | null;
}

export class WebhookEvent {
  private readonly _id: string;
  private readonly _tenantId: string;
  private readonly _endpointId: string;
  private readonly _eventType: string;
  private readonly _payload: Record<string, unknown>;
  private readonly _idempotencyKey: string | null;
  private _status: EventStatus;
  private _retryCount: number;
  private _nextRetryAt: Date | null;
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  private constructor(props: WebhookEventProps) {
    this._id = props.id;
    this._tenantId = props.tenantId;
    this._endpointId = props.endpointId;
    this._eventType = props.eventType;
    this._payload = props.payload;
    this._idempotencyKey = props.idempotencyKey || null;
    this._status = props.status;
    this._retryCount = props.retryCount;
    this._nextRetryAt = props.nextRetryAt || null;
    this._createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
  }

  // ---------------------------------------------------------------------------
  // Factory Methods
  // ---------------------------------------------------------------------------

  /**
   * Factory method for creating a brand new WebhookEvent received via ingestion.
   */
  public static create(props: CreateEventProps): WebhookEvent {
    if (!props.eventType || props.eventType.trim() === '') {
      throw new Error('WebhookEvent validation error: eventType cannot be empty');
    }

    if (!props.payload || typeof props.payload !== 'object') {
      throw new Error('WebhookEvent validation error: payload must be a non-null object');
    }

    const now = new Date();
    return new WebhookEvent({
      id: props.id || crypto.randomUUID(),
      tenantId: props.tenantId,
      endpointId: props.endpointId,
      eventType: props.eventType,
      payload: props.payload,
      idempotencyKey: props.idempotencyKey,
      status: 'PENDING',
      retryCount: 0,
      nextRetryAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * Factory method to reconstitute an existing event from database storage.
   */
  public static hydrate(props: WebhookEventProps): WebhookEvent {
    return new WebhookEvent(props);
  }

  // ---------------------------------------------------------------------------
  // Domain Business Methods (State Transitions)
  // ---------------------------------------------------------------------------

  /**
   * Marks the event as successfully delivered upon receiving an HTTP 2xx response.
   */
  public markDelivered(): void {
    if (this._status === 'DELIVERED') {
      return; // Already delivered; idempotent operation
    }

    this._status = 'DELIVERED';
    this._nextRetryAt = null;
    this._updatedAt = new Date();
  }

  /**
   * Records a failed delivery attempt.
   * If retryCount exceeds maxRetries, transitions the event to the Dead-Letter Queue (DLQ).
   * Otherwise, increments retryCount and calculates the scheduled nextRetryAt.
   *
   * @param maxRetries Maximum retry threshold (e.g. 5)
   * @param delayMs Calculated delay in milliseconds (Exponential Backoff + Jitter)
   */
  public recordFailure(maxRetries: number, delayMs: number): void {
    if (this._status === 'DELIVERED') {
      throw new Error('Cannot record failure on an already delivered webhook event');
    }

    this._retryCount += 1;
    this._updatedAt = new Date();

    if (this._retryCount >= maxRetries) {
      // Retries exhausted: isolate event to the Dead-Letter Queue
      this._status = 'DLQ';
      this._nextRetryAt = null;
    } else {
      // Retries remaining: schedule for future re-dispatch
      this._status = 'FAILED';
      this._nextRetryAt = new Date(Date.now() + delayMs);
    }
  }

  /**
   * Allows an operator to manually replay a quarantined DLQ event from the dashboard.
   * Resets status back to PENDING and clears retry counts.
   */
  public replayFromDLQ(): void {
    if (this._status === 'DELIVERED') {
      throw new Error('Cannot replay an event that has already been delivered successfully');
    }

    this._status = 'PENDING';
    this._retryCount = 0;
    this._nextRetryAt = null;
    this._updatedAt = new Date();
  }

  // ---------------------------------------------------------------------------
  // Getters (Encapsulation: external callers can read, but cannot mutate directly)
  // ---------------------------------------------------------------------------
  public get id(): string { return this._id; }
  public get tenantId(): string { return this._tenantId; }
  public get endpointId(): string { return this._endpointId; }
  public get eventType(): string { return this._eventType; }
  public get payload(): Record<string, unknown> { return this._payload; }
  public get idempotencyKey(): string | null { return this._idempotencyKey; }
  public get status(): EventStatus { return this._status; }
  public get retryCount(): number { return this._retryCount; }
  public get nextRetryAt(): Date | null { return this._nextRetryAt; }
  public get createdAt(): Date { return this._createdAt; }
  public get updatedAt(): Date { return this._updatedAt; }
}
