import type { AutofixStats } from './api/analytics.js';

/** Recovered requests in one window: by Autofix, fallback, or key failover. */
export function recoveredSaves(s: AutofixStats, window: 'value' | 'previous'): number {
  return (
    s.autofix_saves[window] +
    (s.fallback_saves?.[window] ?? 0) +
    (s.key_failover_saves?.[window] ?? 0)
  );
}
