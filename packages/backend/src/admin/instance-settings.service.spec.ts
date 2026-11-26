import { InstanceSettingsService } from './instance-settings.service';

describe('InstanceSettingsService', () => {
  const originalMode = process.env['MANIFEST_MODE'];
  let query: jest.Mock;
  let update: jest.Mock;
  let getOrCreate: jest.Mock;
  let service: InstanceSettingsService;

  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'singleton',
    super_admin_user_id: null,
    signup_enabled: true,
    log_retention_days: null,
    ...overrides,
  });

  beforeEach(() => {
    process.env['MANIFEST_MODE'] = 'selfhosted';
    query = jest.fn();
    update = jest.fn().mockResolvedValue(undefined);
    getOrCreate = jest.fn().mockResolvedValue(row());
    const dataSource = { query, getRepository: jest.fn(() => ({ update })) };
    service = new InstanceSettingsService(dataSource as never, { getOrCreate } as never);
  });

  afterEach(() => {
    if (originalMode === undefined) delete process.env['MANIFEST_MODE'];
    else process.env['MANIFEST_MODE'] = originalMode;
  });

  describe('getSuperAdminUserId', () => {
    it('keeps the stored super admin while that user exists', async () => {
      getOrCreate.mockResolvedValue(row({ super_admin_user_id: 'user-1' }));
      query.mockResolvedValueOnce([{ '?column?': 1 }]);
      await expect(service.getSuperAdminUserId()).resolves.toBe('user-1');
      expect(query).toHaveBeenCalledTimes(1);
      expect(update).not.toHaveBeenCalled();
    });

    it('claims the oldest user when none is stored yet', async () => {
      query.mockResolvedValueOnce([{ id: 'first-user' }]);
      await expect(service.getSuperAdminUserId()).resolves.toBe('first-user');
      expect(query.mock.calls[0][0]).toContain('ORDER BY "createdAt" ASC');
      expect(update).toHaveBeenCalledWith('singleton', { super_admin_user_id: 'first-user' });
    });

    it('hands the role to the next oldest user when the stored one was deleted', async () => {
      getOrCreate.mockResolvedValue(row({ super_admin_user_id: 'gone' }));
      query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'next-user' }]);
      await expect(service.getSuperAdminUserId()).resolves.toBe('next-user');
      expect(update).toHaveBeenCalledWith('singleton', { super_admin_user_id: 'next-user' });
    });

    it('returns null when the install has no users', async () => {
      query.mockResolvedValueOnce([]);
      await expect(service.getSuperAdminUserId()).resolves.toBeNull();
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('isSuperAdmin', () => {
    it('is true only for the super admin on a self-hosted install', async () => {
      getOrCreate.mockResolvedValue(row({ super_admin_user_id: 'user-1' }));
      query.mockResolvedValue([{ '?column?': 1 }]);
      await expect(service.isSuperAdmin('user-1')).resolves.toBe(true);
      await expect(service.isSuperAdmin('user-2')).resolves.toBe(false);
    });

    it('is false without a user id', async () => {
      await expect(service.isSuperAdmin(undefined)).resolves.toBe(false);
      expect(getOrCreate).not.toHaveBeenCalled();
    });

    it('is always false on Cloud', async () => {
      process.env['MANIFEST_MODE'] = 'cloud';
      await expect(service.isSuperAdmin('user-1')).resolves.toBe(false);
      expect(getOrCreate).not.toHaveBeenCalled();
    });
  });

  describe('settings', () => {
    it('reads the defaults: sign-up open, logs kept forever', async () => {
      await expect(service.getSettings()).resolves.toEqual({
        signupEnabled: true,
        logRetentionDays: null,
      });
    });

    it('reads stored values', async () => {
      getOrCreate.mockResolvedValue(row({ signup_enabled: false, log_retention_days: 30 }));
      await expect(service.getSettings()).resolves.toEqual({
        signupEnabled: false,
        logRetentionDays: 30,
      });
    });

    it('treats a missing retention value as forever', async () => {
      getOrCreate.mockResolvedValue(row({ log_retention_days: undefined }));
      await expect(service.getSettings()).resolves.toMatchObject({ logRetentionDays: null });
    });

    it('writes only the fields the patch carries', async () => {
      await service.updateSettings({ signupEnabled: false });
      expect(update).toHaveBeenCalledWith('singleton', { signup_enabled: false });

      update.mockClear();
      await service.updateSettings({ logRetentionDays: 7 });
      expect(update).toHaveBeenCalledWith('singleton', { log_retention_days: 7 });
    });

    it('clears the retention window with null', async () => {
      await service.updateSettings({ logRetentionDays: null });
      expect(update).toHaveBeenCalledWith('singleton', { log_retention_days: null });
    });

    it('skips the write for an empty patch but still returns the settings', async () => {
      await expect(service.updateSettings({})).resolves.toEqual({
        signupEnabled: true,
        logRetentionDays: null,
      });
      expect(update).not.toHaveBeenCalled();
      expect(getOrCreate).toHaveBeenCalledTimes(2);
    });
  });
});
