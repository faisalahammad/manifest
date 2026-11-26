import {
  decodeKeyRotationRef,
  encodeKeyRotationRef,
  KeyRotationService,
  MAX_KEY_ROTATION_CURSORS,
  type KeyRotationRef,
} from './key-rotation.service';

const ref: KeyRotationRef = {
  tenantId: 't1',
  agentId: 'a1',
  provider: 'OpenAI',
  authType: 'api_key',
};
const keys = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
const ids = (list: { id: string }[]) => list.map((k) => k.id);

describe('KeyRotationService', () => {
  let svc: KeyRotationService;
  beforeEach(() => {
    svc = new KeyRotationService();
  });

  it('starts at the first key with no cursor', () => {
    expect(ids(svc.order(ref, keys))).toEqual(['A', 'B', 'C']);
    expect(svc.currentKeyId(ref, keys)).toBe('A');
    expect(svc.currentKeyId(ref, [])).toBeUndefined();
  });

  it('A fails, B serves, the next request starts at B', () => {
    expect(svc.recordFailure(ref, 'A', 'A', keys)).toBe('B');
    svc.recordSuccess(ref, 'B');
    expect(ids(svc.order(ref, keys))).toEqual(['B', 'C', 'A']);
  });

  it('wraps from the last key to the first', () => {
    svc.recordSuccess(ref, 'C');
    expect(svc.recordFailure(ref, 'C', 'C', keys)).toBe('A');
    expect(svc.currentKeyId(ref, keys)).toBe('A');
  });

  it('advances once when concurrent requests fail on the same key', () => {
    expect(svc.recordFailure(ref, 'A', 'A', keys)).toBe('B');
    // The second request still expects A: its advance is dropped.
    expect(svc.recordFailure(ref, 'A', 'A', keys)).toBe('A');
    expect(svc.currentKeyId(ref, keys)).toBe('B');
  });

  it('advances past a key the request skipped', () => {
    // A is cooled and skipped, B fails: the cursor still holds A, which this
    // request expects, so it moves past B.
    expect(svc.recordFailure(ref, 'A', 'B', keys)).toBe('C');
    expect(svc.currentKeyId(ref, keys)).toBe('C');
  });

  it('keeps a success another request recorded meanwhile', () => {
    svc.recordSuccess(ref, 'C');
    expect(svc.recordFailure(ref, 'A', 'A', keys)).toBe('A');
    expect(svc.currentKeyId(ref, keys)).toBe('C');
  });

  it('ignores a failure when there are no keys', () => {
    expect(svc.recordFailure(ref, 'A', 'A', [])).toBe('A');
    svc.wrap(ref, 'A', []);
    expect(svc.currentKeyId(ref, keys)).toBe('A');
  });

  it('a full failed lap ends where it started, so wrap resets to the first key', () => {
    svc.recordSuccess(ref, 'B');
    let expected = 'B';
    for (const id of ['B', 'C', 'A']) expected = svc.recordFailure(ref, expected, id, keys);
    expect(expected).toBe('B');
    svc.wrap(ref, expected, keys);
    expect(svc.currentKeyId(ref, keys)).toBe('A');
  });

  it('wrap resets to the first key only while the cursor is where the request left it', () => {
    svc.recordSuccess(ref, 'B');
    svc.wrap(ref, 'C', keys);
    expect(svc.currentKeyId(ref, keys)).toBe('B');
    svc.wrap(ref, 'B', keys);
    expect(svc.currentKeyId(ref, keys)).toBe('A');
  });

  it('starts from the first key when the cursor key is gone', () => {
    svc.recordSuccess(ref, 'GONE');
    expect(ids(svc.order(ref, keys))).toEqual(['A', 'B', 'C']);
  });

  it('keys the ring by agent, provider (case-insensitive) and auth type', () => {
    svc.recordSuccess(ref, 'B');
    expect(svc.currentKeyId({ ...ref, provider: 'openai' }, keys)).toBe('B');
    expect(svc.currentKeyId({ ...ref, authType: 'subscription' }, keys)).toBe('A');
    expect(svc.currentKeyId({ ...ref, agentId: 'a2' }, keys)).toBe('A');
  });

  it('reset clears the cursor and notifies listeners', () => {
    const listener = jest.fn();
    svc.addResetListener(listener);
    svc.recordSuccess(ref, 'C');
    svc.reset(ref);
    expect(svc.currentKeyId(ref, keys)).toBe('A');
    expect(listener).toHaveBeenCalledWith(ref);
  });

  it('evicts the least recently set cursor when full', () => {
    svc.recordSuccess({ ...ref, agentId: 'oldest' }, 'B');
    for (let i = 0; i < MAX_KEY_ROTATION_CURSORS - 1; i++) {
      svc.recordSuccess({ ...ref, agentId: `agent-${i}` }, 'B');
    }
    svc.recordSuccess({ ...ref, agentId: 'oldest' }, 'C'); // refresh, not a new entry
    svc.recordSuccess({ ...ref, agentId: 'newest' }, 'B'); // evicts agent-0
    expect(svc.currentKeyId({ ...ref, agentId: 'oldest' }, keys)).toBe('C');
    expect(svc.currentKeyId({ ...ref, agentId: 'agent-0' }, keys)).toBe('A');
    expect(svc.currentKeyId({ ...ref, agentId: 'newest' }, keys)).toBe('B');
  });
});

describe('key rotation feed encoding', () => {
  it('round-trips a ref, keeping a provider that contains the separator', () => {
    const custom = { ...ref, provider: 'custom:x|y' };
    expect(decodeKeyRotationRef(encodeKeyRotationRef(custom))).toEqual(custom);
    expect(encodeKeyRotationRef(ref)).toBe('t1|a1|api_key|openai');
  });

  it('rejects malformed values', () => {
    for (const value of [
      '',
      't|a|api_key',
      '|a|api_key|openai',
      't||api_key|openai',
      't|a||openai',
      't|a|api_key|',
    ]) {
      expect(decodeKeyRotationRef(value)).toBeNull();
    }
  });
});
