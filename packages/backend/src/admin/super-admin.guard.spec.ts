import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { SuperAdminGuard } from './super-admin.guard';

describe('SuperAdminGuard', () => {
  const originalMode = process.env['MANIFEST_MODE'];
  let isSuperAdmin: jest.Mock;
  let guard: SuperAdminGuard;

  const context = (request: Record<string, unknown>) =>
    ({ switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ExecutionContext;

  beforeEach(() => {
    process.env['MANIFEST_MODE'] = 'selfhosted';
    isSuperAdmin = jest.fn().mockResolvedValue(true);
    guard = new SuperAdminGuard({ isSuperAdmin } as never);
  });

  afterEach(() => {
    if (originalMode === undefined) delete process.env['MANIFEST_MODE'];
    else process.env['MANIFEST_MODE'] = originalMode;
  });

  it('lets the super admin through on a dashboard session', async () => {
    await expect(
      guard.canActivate(context({ authMethod: 'session', user: { id: 'user-1' } })),
    ).resolves.toBe(true);
    expect(isSuperAdmin).toHaveBeenCalledWith('user-1');
  });

  it('refuses on Cloud', async () => {
    process.env['MANIFEST_MODE'] = 'cloud';
    await expect(
      guard.canActivate(context({ authMethod: 'session', user: { id: 'user-1' } })),
    ).rejects.toThrow('only available on self-hosted');
  });

  it('refuses API keys and CLI tokens', async () => {
    await expect(guard.canActivate(context({ authMethod: 'api_key' }))).rejects.toThrow(
      'need a dashboard session',
    );
    expect(isSuperAdmin).not.toHaveBeenCalled();
  });

  it('refuses any other user', async () => {
    isSuperAdmin.mockResolvedValue(false);
    await expect(guard.canActivate(context({ authMethod: 'session' }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(isSuperAdmin).toHaveBeenCalledWith(undefined);
  });
});
