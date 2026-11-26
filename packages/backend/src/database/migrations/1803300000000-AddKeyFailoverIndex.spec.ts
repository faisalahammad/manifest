import { AddKeyFailoverIndex1803300000000 } from './1803300000000-AddKeyFailoverIndex';

describe('AddKeyFailoverIndex1803300000000', () => {
  const migration = new AddKeyFailoverIndex1803300000000();
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
    expect(migration.name).toBe('AddKeyFailoverIndex1803300000000');
  });

  it('adds a nullable integer column with no default', async () => {
    expect(await run('up')).toEqual([
      'ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "key_failover_index" integer',
    ]);
  });

  it('drops the column on revert', async () => {
    expect(await run('down')).toEqual([
      'ALTER TABLE "agent_messages" DROP COLUMN IF EXISTS "key_failover_index"',
    ]);
  });
});
