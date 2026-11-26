import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getAdminStatus,
  getInstanceSettings,
  updateInstanceSettings,
} from '../../src/services/api/admin.js';
import * as api from '../../src/services/api.js';

vi.mock('../../src/services/toast-store.js', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

const mockFetch = vi.fn();
const ok = (body: unknown) => ({
  ok: true,
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(JSON.stringify(body)),
});

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  vi.stubGlobal('location', { origin: 'http://localhost:3000', pathname: '/' });
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('admin api', () => {
  it('reads the super admin status', async () => {
    mockFetch.mockResolvedValueOnce(ok({ isSuperAdmin: true }));
    await expect(getAdminStatus()).resolves.toEqual({ isSuperAdmin: true });
    expect(String(mockFetch.mock.calls[0][0])).toBe('http://localhost:3000/api/v1/admin/status');
  });

  it('reads the instance settings', async () => {
    mockFetch.mockResolvedValueOnce(ok({ signupEnabled: true, logRetentionDays: null }));
    await expect(getInstanceSettings()).resolves.toEqual({
      signupEnabled: true,
      logRetentionDays: null,
    });
    expect(String(mockFetch.mock.calls[0][0])).toBe('http://localhost:3000/api/v1/admin/settings');
  });

  it('patches the instance settings', async () => {
    mockFetch.mockResolvedValueOnce(ok({ signupEnabled: false, logRetentionDays: 7 }));
    await expect(updateInstanceSettings({ logRetentionDays: 7 })).resolves.toEqual({
      signupEnabled: false,
      logRetentionDays: 7,
    });
    expect(mockFetch).toHaveBeenCalledWith('/api/v1/admin/settings', {
      credentials: 'include',
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logRetentionDays: 7 }),
    });
  });

  it('is re-exported from the api barrel', () => {
    expect(api.getInstanceSettings).toBe(getInstanceSettings);
  });
});
