import { AddInstanceAdminSettings1803400000000 } from './1803400000000-AddInstanceAdminSettings';

describe('AddInstanceAdminSettings1803400000000', () => {
  const migration = new AddInstanceAdminSettings1803400000000();
  const run = async (direction: 'up' | 'down') => {
    const queries: string[] = [];
    await migration[direction]({
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
      }),
    } as never);
    return queries;
  };

  it('exposes the expected migration name', () => {
    expect(migration.name).toBe('AddInstanceAdminSettings1803400000000');
  });

  it('adds the three settings with defaults that keep current behaviour', async () => {
    const sql = (await run('up')).join('\n');
    expect(sql).toContain('"super_admin_user_id" varchar DEFAULT NULL');
    expect(sql).toContain('"signup_enabled" boolean NOT NULL DEFAULT true');
    expect(sql).toContain('"log_retention_days" integer DEFAULT NULL');
    expect(sql).toContain('IN (1, 7, 15, 30, 60, 90)');
  });

  it('drops everything on revert', async () => {
    const sql = (await run('down')).join('\n');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "CHK_install_metadata_log_retention_days"');
    expect(sql).toContain('DROP COLUMN IF EXISTS "log_retention_days"');
    expect(sql).toContain('DROP COLUMN IF EXISTS "signup_enabled"');
    expect(sql).toContain('DROP COLUMN IF EXISTS "super_admin_user_id"');
  });
});
