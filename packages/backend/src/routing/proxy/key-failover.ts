/**
 * Key failover inside one provider: when an Auto route's key fails for a
 * reason that belongs to the key (auth, billing, quota, provider health), the
 * same model is tried on the provider's next key before the request moves to
 * the next fallback route. Request-scoped failures (a malformed body, an
 * unknown model, a payload too large) would fail the same way on every key,
 * so they never rotate.
 */

export type KeyFailoverDecision = 'rotate' | 'stop';

/**
 * Status → decision. Local failures reach this table as the synthetic status
 * the proxy already gives them:
 * - network error or timeout before a response: 502 / 503 / 504
 * - stream warm-up failure (dead stream before the first byte): 502
 * - unusable subscription credentials (M102): 401
 * Any other 4xx is request-scoped and stops.
 */
export const KEY_FAILOVER_STATUSES: Readonly<Record<number, KeyFailoverDecision>> = {
  401: 'rotate',
  402: 'rotate',
  403: 'rotate',
  429: 'rotate',
  529: 'rotate',
};

export function classifyKeyFailover(status: number): KeyFailoverDecision {
  if (status < 400) return 'stop';
  if (status >= 500) return 'rotate';
  return KEY_FAILOVER_STATUSES[status] ?? 'stop';
}

export const DEFAULT_KEY_FAILOVER_MAX_ATTEMPTS = 10;
export const DEFAULT_ROUTING_DEADLINE_MS = 300_000;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return value > 0 ? value : fallback;
}

/** Most keys one hop tries for one request (cooled keys skipped without a call do not count). */
export function parseKeyFailoverMaxAttempts(raw = process.env.KEY_FAILOVER_MAX_ATTEMPTS): number {
  return parsePositiveInt(raw, DEFAULT_KEY_FAILOVER_MAX_ATTEMPTS);
}

/**
 * Time budget for the whole routing chain of one request. No new key or
 * fallback hop starts once it is spent; a call already in flight is never cut.
 */
export function parseRoutingDeadlineMs(raw = process.env.ROUTING_DEADLINE_MS): number {
  return parsePositiveInt(raw, DEFAULT_ROUTING_DEADLINE_MS);
}
