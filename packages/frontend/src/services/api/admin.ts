import { fetchJson, fetchMutate } from './core.js';

/** Mirrors `InstanceSettings` in `packages/backend/src/admin/instance-settings.service.ts`. */
export interface InstanceSettings {
  signupEnabled: boolean;
  /** Days to keep Requests and their logs; null keeps them forever. */
  logRetentionDays: number | null;
}

export function getAdminStatus(): Promise<{ isSuperAdmin: boolean }> {
  return fetchJson<{ isSuperAdmin: boolean }>('/admin/status', undefined, {
    cache: false,
    loginRedirect: false,
  });
}

export function getInstanceSettings(): Promise<InstanceSettings> {
  return fetchJson<InstanceSettings>('/admin/settings', undefined, { cache: false });
}

export function updateInstanceSettings(
  patch: Partial<InstanceSettings>,
): Promise<InstanceSettings> {
  return fetchMutate<InstanceSettings>('/admin/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}
