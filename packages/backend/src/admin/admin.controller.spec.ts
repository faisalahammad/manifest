import { AdminController } from './admin.controller';

describe('AdminController', () => {
  let settings: { isSuperAdmin: jest.Mock; getSettings: jest.Mock; updateSettings: jest.Mock };
  let controller: AdminController;

  beforeEach(() => {
    settings = {
      isSuperAdmin: jest.fn().mockResolvedValue(true),
      getSettings: jest.fn().mockResolvedValue({ signupEnabled: true, logRetentionDays: null }),
      updateSettings: jest.fn().mockResolvedValue({ signupEnabled: false, logRetentionDays: 7 }),
    };
    controller = new AdminController(settings as never);
  });

  it('reports the super admin on a session', async () => {
    await expect(
      controller.getStatus({ authMethod: 'session', user: { id: 'user-1' } } as never),
    ).resolves.toEqual({ isSuperAdmin: true });
    expect(settings.isSuperAdmin).toHaveBeenCalledWith('user-1');
  });

  it('never reports an API key caller as super admin', async () => {
    await expect(controller.getStatus({ authMethod: 'api_key' } as never)).resolves.toEqual({
      isSuperAdmin: false,
    });
    expect(settings.isSuperAdmin).not.toHaveBeenCalled();
  });

  it('reads and updates the settings', async () => {
    await expect(controller.getSettings()).resolves.toEqual({
      signupEnabled: true,
      logRetentionDays: null,
    });
    const dto = { signupEnabled: false, logRetentionDays: 7 };
    await expect(controller.updateSettings(dto)).resolves.toEqual(dto);
    expect(settings.updateSettings).toHaveBeenCalledWith(dto);
  });
});
