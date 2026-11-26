import {
  classifyKeyFailover,
  DEFAULT_KEY_FAILOVER_MAX_ATTEMPTS,
  DEFAULT_ROUTING_DEADLINE_MS,
  parseKeyFailoverMaxAttempts,
  parseRoutingDeadlineMs,
} from './key-failover';

describe('classifyKeyFailover', () => {
  it.each([
    // Key-scoped: try the next key.
    [401, 'rotate'], // auth rejected (after OAuth refresh) or M102 unusable subscription
    [402, 'rotate'], // billing / out of credit
    [403, 'rotate'], // key not allowed
    [429, 'rotate'], // rate limited or quota
    [500, 'rotate'],
    [502, 'rotate'], // transport error or stream warm-up failure
    [503, 'rotate'], // transport error
    [504, 'rotate'], // timeout
    [529, 'rotate'], // provider overloaded
    // Request-scoped: every key would fail the same way.
    [400, 'stop'],
    [404, 'stop'],
    [408, 'stop'],
    [409, 'stop'],
    [413, 'stop'],
    [422, 'stop'],
    // Not a failure.
    [200, 'stop'],
    [302, 'stop'],
  ] as const)('status %i → %s', (status, decision) => {
    expect(classifyKeyFailover(status)).toBe(decision);
  });
});

describe('key failover config', () => {
  it('uses the defaults when unset or invalid', () => {
    for (const raw of [undefined, '', 'abc', '-3', '0', '1.5']) {
      expect(parseKeyFailoverMaxAttempts(raw)).toBe(DEFAULT_KEY_FAILOVER_MAX_ATTEMPTS);
      expect(parseRoutingDeadlineMs(raw)).toBe(DEFAULT_ROUTING_DEADLINE_MS);
    }
  });

  it('accepts positive integers', () => {
    expect(parseKeyFailoverMaxAttempts('3')).toBe(3);
    expect(parseRoutingDeadlineMs('60000')).toBe(60_000);
  });
});
