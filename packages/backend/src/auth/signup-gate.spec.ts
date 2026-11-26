import { isSignUpAllowed, SIGNUP_GATE_SQL } from './signup-gate';

describe('isSignUpAllowed', () => {
  const originalMode = process.env['MANIFEST_MODE'];
  afterEach(() => {
    if (originalMode === undefined) delete process.env['MANIFEST_MODE'];
    else process.env['MANIFEST_MODE'] = originalMode;
  });

  it('always allows sign-up on cloud without touching the database', async () => {
    process.env['MANIFEST_MODE'] = 'cloud';
    const query = jest.fn();
    await expect(isSignUpAllowed(query)).resolves.toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  describe('self-hosted', () => {
    beforeEach(() => {
      process.env['MANIFEST_MODE'] = 'selfhosted';
    });

    it('allows the first user even when sign-up is off', async () => {
      const query = jest.fn().mockResolvedValue([{ has_users: false, signup_enabled: false }]);
      await expect(isSignUpAllowed(query)).resolves.toBe(true);
      expect(query).toHaveBeenCalledWith(SIGNUP_GATE_SQL);
    });

    it('allows the first user when the query returns no row', async () => {
      await expect(isSignUpAllowed(jest.fn().mockResolvedValue([]))).resolves.toBe(true);
    });

    it('blocks new users once the admin turned sign-up off', async () => {
      const query = jest.fn().mockResolvedValue([{ has_users: true, signup_enabled: false }]);
      await expect(isSignUpAllowed(query)).resolves.toBe(false);
    });

    it('allows new users while sign-up is on', async () => {
      const query = jest.fn().mockResolvedValue([{ has_users: true, signup_enabled: true }]);
      await expect(isSignUpAllowed(query)).resolves.toBe(true);
    });

    it('allows new users when no settings row exists yet', async () => {
      const query = jest.fn().mockResolvedValue([{ has_users: true, signup_enabled: null }]);
      await expect(isSignUpAllowed(query)).resolves.toBe(true);
    });

    it('lets a database error reach the caller so sign-up fails closed', async () => {
      const query = jest.fn().mockRejectedValue(new Error('db down'));
      await expect(isSignUpAllowed(query)).rejects.toThrow('db down');
    });
  });
});
