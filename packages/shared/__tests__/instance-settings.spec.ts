import { LOG_RETENTION_DAY_OPTIONS, isLogRetentionDays } from '../src/instance-settings';

describe('instance-settings', () => {
  it('lists the retention windows the admin can pick', () => {
    expect(LOG_RETENTION_DAY_OPTIONS).toEqual([1, 7, 15, 30, 60, 90]);
  });

  it('accepts only the listed windows', () => {
    expect(isLogRetentionDays(7)).toBe(true);
    expect(isLogRetentionDays(90)).toBe(true);
    expect(isLogRetentionDays(14)).toBe(false);
    expect(isLogRetentionDays('7')).toBe(false);
    expect(isLogRetentionDays(null)).toBe(false);
  });
});
