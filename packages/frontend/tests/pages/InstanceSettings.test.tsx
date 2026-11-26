import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getInstanceSettings = vi.fn();
const updateInstanceSettings = vi.fn();
const toastSuccess = vi.fn();
vi.mock('../../src/services/api/admin.js', () => ({
  getInstanceSettings: (...args: unknown[]) => getInstanceSettings(...args),
  updateInstanceSettings: (...args: unknown[]) => updateInstanceSettings(...args),
}));
vi.mock('../../src/services/toast-store.js', () => ({
  toast: { success: (...args: unknown[]) => toastSuccess(...args) },
}));
vi.mock('@solidjs/meta', () => ({ Title: () => null }));

import InstanceSettings from '../../src/pages/InstanceSettings';

describe('InstanceSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getInstanceSettings.mockResolvedValue({ signupEnabled: true, logRetentionDays: null });
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const ready = async () => {
    const view = render(() => <InstanceSettings />);
    const toggle = view.getByRole('switch');
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    const select = view.container.querySelector('select') as HTMLSelectElement;
    return { ...view, toggle, select };
  };

  it('shows the current settings', async () => {
    const { toggle, select, container } = await ready();
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(select.value).toBe('forever');
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'Keep forever',
      '1 day',
      '7 days',
      '15 days',
      '30 days',
      '60 days',
      '90 days',
    ]);
    expect(container.textContent).toContain('Only the super admin can see this page');
  });

  it('shows a stored retention window', async () => {
    getInstanceSettings.mockResolvedValue({ signupEnabled: false, logRetentionDays: 30 });
    const { toggle, select } = await ready();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(select.value).toBe('30');
  });

  it('turns sign-up off and on', async () => {
    updateInstanceSettings.mockResolvedValueOnce({ signupEnabled: false, logRetentionDays: null });
    const { toggle } = await ready();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    expect(updateInstanceSettings).toHaveBeenCalledWith({ signupEnabled: false });
    expect(toastSuccess).toHaveBeenCalledWith('Sign-up turned off');

    updateInstanceSettings.mockResolvedValueOnce({ signupEnabled: true, logRetentionDays: null });
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    fireEvent.click(toggle);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Sign-up turned on'));
  });

  it('ignores clicks while a save is running', async () => {
    let finish: (value: unknown) => void = () => undefined;
    updateInstanceSettings.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { toggle } = await ready();
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(updateInstanceSettings).toHaveBeenCalledTimes(1);
    finish({ signupEnabled: false, logRetentionDays: null });
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
  });

  it('asks before shortening retention, then saves it', async () => {
    updateInstanceSettings.mockResolvedValue({ signupEnabled: true, logRetentionDays: 1 });
    const { select } = await ready();
    select.value = '1';
    fireEvent.change(select);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('older than 1 day'));
    await waitFor(() =>
      expect(updateInstanceSettings).toHaveBeenCalledWith({ logRetentionDays: 1 }),
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Log retention set to 1 day'));
  });

  it('puts the old value back when the admin cancels', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    getInstanceSettings.mockResolvedValue({ signupEnabled: true, logRetentionDays: 30 });
    const { select } = await ready();
    select.value = '7';
    fireEvent.change(select);
    expect(select.value).toBe('30');
    expect(updateInstanceSettings).not.toHaveBeenCalled();
  });

  it('cancelling from forever puts forever back', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    const { select } = await ready();
    select.value = '90';
    fireEvent.change(select);
    expect(select.value).toBe('forever');
  });

  it('does not ask when the window gets longer or goes back to forever', async () => {
    getInstanceSettings.mockResolvedValue({ signupEnabled: true, logRetentionDays: 7 });
    updateInstanceSettings.mockResolvedValue({ signupEnabled: true, logRetentionDays: 90 });
    const { select } = await ready();
    select.value = '90';
    fireEvent.change(select);
    await waitFor(() =>
      expect(updateInstanceSettings).toHaveBeenCalledWith({ logRetentionDays: 90 }),
    );

    updateInstanceSettings.mockResolvedValue({ signupEnabled: true, logRetentionDays: null });
    await waitFor(() => expect(select.hasAttribute('disabled')).toBe(false));
    select.value = 'forever';
    fireEvent.change(select);
    await waitFor(() =>
      expect(updateInstanceSettings).toHaveBeenCalledWith({ logRetentionDays: null }),
    );
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('Log retention set to keep forever'),
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  it('keeps the old value when the save fails', async () => {
    updateInstanceSettings.mockRejectedValue(new Error('nope'));
    const { toggle } = await ready();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('explains the page is for the super admin when the backend refuses', async () => {
    getInstanceSettings.mockRejectedValue(new Error('Forbidden'));
    const { findByText, queryByRole } = render(() => <InstanceSettings />);
    expect(await findByText('Not available')).toBeDefined();
    expect(queryByRole('switch')).toBeNull();
  });
});
