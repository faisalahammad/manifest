import { Injectable } from '@nestjs/common';

/** One rotation ring: the keys of one provider and auth type, as one agent sees them. */
export interface KeyRotationRef {
  tenantId: string;
  agentId: string;
  provider: string;
  authType: string;
}

/** The part of a provider key that rotation needs. */
interface RotationKey {
  id: string;
}

export type KeyRotationResetListener = (ref: KeyRotationRef) => void;

export const MAX_KEY_ROTATION_CURSORS = 2_000;

/**
 * Remembers which key of a provider served the last call, so an Auto route
 * starts from the key that works instead of always paying for a dead first key.
 *
 * The cursor stores the key id, never a position, so reordering keys keeps it
 * valid and a deleted or disabled key simply drops out (the ring then starts
 * from the first key again). State is in-memory per instance, like the 429 and
 * 401 cooldowns: another instance learns the same thing after at most one
 * failed call. A manual reset reaches every instance through the routing cache
 * invalidation feed (see RoutingCacheSyncService).
 *
 * Every read and write below is synchronous, so a check and the set that
 * follows it can never interleave with another request on this instance.
 */
@Injectable()
export class KeyRotationService {
  private readonly cursors = new Map<string, string>();
  private readonly resetListeners: KeyRotationResetListener[] = [];

  /** Keys in priority order, rotated to start at the cursor. */
  order<T extends RotationKey>(ref: KeyRotationRef, keys: T[]): T[] {
    const cursor = this.cursors.get(rotationKey(ref));
    const start = cursor ? keys.findIndex((k) => k.id === cursor) : -1;
    if (start <= 0) return [...keys];
    return [...keys.slice(start), ...keys.slice(0, start)];
  }

  /** The key the next call starts from: the cursor, or the first key. */
  currentKeyId(ref: KeyRotationRef, keys: RotationKey[]): string | undefined {
    return this.order(ref, keys)[0]?.id;
  }

  /** A key served a call: the next call starts from it. */
  recordSuccess(ref: KeyRotationRef, keyId: string): void {
    this.set(rotationKey(ref), keyId);
  }

  /**
   * A key failed for a key-scoped reason. Advance past it only while the
   * cursor still names it, so concurrent requests that failed on the same key
   * advance the ring once, and a success another request recorded meanwhile
   * is kept.
   */
  recordFailure(ref: KeyRotationRef, keyId: string, keys: RotationKey[]): void {
    if (keys.length === 0) return;
    if (this.currentKeyId(ref, keys) !== keyId) return;
    const index = keys.findIndex((k) => k.id === keyId);
    this.set(rotationKey(ref), keys[(index + 1) % keys.length].id);
  }

  /**
   * A request tried every eligible key and all failed: start the next request
   * from the first key again, unless another request moved the cursor since
   * (`expectedKeyId` is where this request's own advances left it).
   */
  wrap(ref: KeyRotationRef, expectedKeyId: string, keys: RotationKey[]): void {
    if (keys.length === 0) return;
    if (this.currentKeyId(ref, keys) !== expectedKeyId) return;
    this.cursors.delete(rotationKey(ref));
  }

  /** Manual reset: back to the first key, and every listener drops its state. */
  reset(ref: KeyRotationRef): void {
    this.cursors.delete(rotationKey(ref));
    for (const listener of this.resetListeners) listener(ref);
  }

  addResetListener(listener: KeyRotationResetListener): void {
    this.resetListeners.push(listener);
  }

  private set(key: string, keyId: string): void {
    // Re-insert so insertion order stays recency order for eviction.
    this.cursors.delete(key);
    if (this.cursors.size >= MAX_KEY_ROTATION_CURSORS) {
      const oldest = this.cursors.keys().next().value as string;
      this.cursors.delete(oldest);
    }
    this.cursors.set(key, keyId);
  }
}

function rotationKey(ref: KeyRotationRef): string {
  return [ref.agentId, ref.provider.toLowerCase(), ref.authType].join('\u0000');
}

/**
 * Feed encoding of a ref. `|` separates the fields because Postgres text
 * cannot hold NUL. The provider goes last: custom provider ids may contain
 * any character, and splitting on the first three separators keeps it whole.
 */
export function encodeKeyRotationRef(ref: KeyRotationRef): string {
  return [ref.tenantId, ref.agentId, ref.authType, ref.provider.toLowerCase()].join('|');
}

export function decodeKeyRotationRef(value: string): KeyRotationRef | null {
  const parts = value.split('|');
  if (parts.length < 4) return null;
  const [tenantId, agentId, authType, ...rest] = parts;
  const provider = rest.join('|');
  if (!tenantId || !agentId || !authType || !provider) return null;
  return { tenantId, agentId, authType, provider };
}
