/**
 * How many days a self-hosted install keeps TierGate Requests and Provider
 * Attempts. `null` (the default) keeps them forever.
 */
export const LOG_RETENTION_DAY_OPTIONS = [1, 7, 15, 30, 60, 90] as const;

export type LogRetentionDays = (typeof LOG_RETENTION_DAY_OPTIONS)[number];

export function isLogRetentionDays(value: unknown): value is LogRetentionDays {
  return (LOG_RETENTION_DAY_OPTIONS as readonly unknown[]).includes(value);
}
