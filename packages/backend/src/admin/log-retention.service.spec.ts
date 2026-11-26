import {
  LOG_RETENTION_BATCH_SIZE,
  LOG_RETENTION_MAX_BATCHES,
  LogRetentionService,
} from './log-retention.service';

type Handler = (sql: string, params?: unknown[]) => unknown;

describe('LogRetentionService', () => {
  const originalMode = process.env['MANIFEST_MODE'];
  let handler: Handler;
  let runner: {
    connect: jest.Mock;
    release: jest.Mock;
    query: jest.Mock;
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
  };
  let storageDelete: jest.Mock;
  let service: LogRetentionService;

  const ids = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}` }));

  /** Default database: retention set to `days`, lock free, nothing expired. */
  function database(days: number | null, overrides: Partial<Record<string, Handler>> = {}) {
    handler = (sql, params) => {
      for (const [needle, fn] of Object.entries(overrides)) {
        if (sql.includes(needle)) return fn!(sql, params);
      }
      if (sql.includes('"log_retention_days" FROM')) return [{ log_retention_days: days }];
      if (sql.includes('pg_try_advisory_lock')) return [{ acquired: true }];
      return [];
    };
  }

  beforeEach(() => {
    process.env['MANIFEST_MODE'] = 'selfhosted';
    runner = {
      connect: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(async (sql: string, params?: unknown[]) => handler(sql, params)),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    };
    storageDelete = jest.fn().mockResolvedValue(undefined);
    service = new LogRetentionService(
      { createQueryRunner: () => runner } as never,
      { delete: storageDelete } as never,
    );
    database(null);
  });

  afterEach(() => {
    if (originalMode === undefined) delete process.env['MANIFEST_MODE'];
    else process.env['MANIFEST_MODE'] = originalMode;
  });

  const deletes = () =>
    runner.query.mock.calls.filter(([sql]) => (sql as string).startsWith('DELETE'));

  it('does nothing on Cloud', async () => {
    process.env['MANIFEST_MODE'] = 'cloud';
    await expect(service.deleteExpiredLogs()).resolves.toBe(0);
    expect(runner.connect).not.toHaveBeenCalled();
  });

  it('does nothing while logs are kept forever', async () => {
    await expect(service.deleteExpiredLogs()).resolves.toBe(0);
    expect(runner.query).toHaveBeenCalledTimes(1);
    expect(runner.release).toHaveBeenCalled();
  });

  it('does nothing when no settings row exists', async () => {
    handler = () => [];
    await expect(service.deleteExpiredLogs()).resolves.toBe(0);
  });

  it('skips the run when another replica holds the lock', async () => {
    database(7, { pg_try_advisory_lock: () => [{ acquired: false }] });
    await expect(service.deleteExpiredLogs()).resolves.toBe(0);
    expect(runner.query.mock.calls.some(([sql]) => sql.includes('pg_advisory_unlock'))).toBe(false);
  });

  it('deletes expired Requests, their attempts, and their recordings', async () => {
    let served = false;
    database(30, {
      'SELECT "id" FROM "requests"': (_sql, params) => {
        expect(params).toEqual([30, LOG_RETENTION_BATCH_SIZE]);
        if (served) return [];
        served = true;
        return ids('req', 2);
      },
      '"request_id" AS owner_id': () => [{ owner_id: 'req0', storage_key: 'key-0' }],
    });

    await expect(service.deleteExpiredLogs()).resolves.toBe(2);
    expect(storageDelete).toHaveBeenCalledWith('key-0');
    expect(deletes().map(([sql, params]) => [sql, params])).toEqual([
      ['DELETE FROM "agent_messages" WHERE "request_id" = ANY($1)', [['req0', 'req1']]],
      ['DELETE FROM "requests" WHERE "id" = ANY($1)', [['req0', 'req1']]],
    ]);
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(runner.query.mock.calls.some(([sql]) => sql.includes('pg_advisory_unlock'))).toBe(true);
  });

  it('also deletes old attempts that never had a Request', async () => {
    database(1, {
      '"request_id" IS NULL\n    AND "timestamp"': () => ids('att', 1),
      '"id" AS owner_id': () => [],
    });
    await expect(service.deleteExpiredLogs()).resolves.toBe(1);
    expect(deletes()).toEqual([
      ['DELETE FROM "agent_messages" WHERE "id" = ANY($1) AND "request_id" IS NULL', [['att0']]],
    ]);
  });

  it('keeps a Request whose recording could not be deleted', async () => {
    let served = false;
    database(7, {
      'SELECT "id" FROM "requests"': () => {
        if (served) return [];
        served = true;
        return ids('req', 2);
      },
      '"request_id" AS owner_id': () => [
        { owner_id: 'req0', storage_key: 'bad-1' },
        { owner_id: 'req0', storage_key: 'bad-2' },
        { owner_id: 'req1', storage_key: 'good' },
      ],
    });
    storageDelete.mockImplementation(async (key: string) => {
      if (key.startsWith('bad')) throw new Error('S3 down');
    });

    await expect(service.deleteExpiredLogs()).resolves.toBe(1);
    // The second recording of req0 is not tried once the first one failed.
    expect(storageDelete.mock.calls.map(([key]) => key)).toEqual(['bad-1', 'good']);
    expect(deletes()[0][1]).toEqual([['req1']]);
  });

  it('logs non-Error storage failures too', async () => {
    database(7, {
      'SELECT "id" FROM "requests"': () => ids('req', 1),
      '"request_id" AS owner_id': () => [{ owner_id: 'req0', storage_key: 'k' }],
    });
    storageDelete.mockRejectedValue('nope');
    await expect(service.deleteExpiredLogs()).resolves.toBe(0);
    expect(deletes()).toEqual([]);
  });

  it('works through full batches until a short one', async () => {
    let calls = 0;
    database(7, {
      'SELECT "id" FROM "requests"': () => {
        calls += 1;
        return calls === 1 ? ids('a', LOG_RETENTION_BATCH_SIZE) : ids('b', 3);
      },
    });
    await expect(service.deleteExpiredLogs()).resolves.toBe(LOG_RETENTION_BATCH_SIZE + 3);
    expect(calls).toBe(2);
  });

  it('stops after the batch cap', async () => {
    let calls = 0;
    database(7, {
      'SELECT "id" FROM "requests"': () => {
        calls += 1;
        return ids(`b${calls}-`, LOG_RETENTION_BATCH_SIZE);
      },
    });
    await service.deleteExpiredLogs();
    expect(calls).toBe(LOG_RETENTION_MAX_BATCHES);
  });

  it('rolls back a failed delete and reports nothing deleted', async () => {
    database(7, {
      'SELECT "id" FROM "requests"': () => ids('req', 1),
      'DELETE FROM "requests"': () => {
        throw new Error('deadlock');
      },
    });
    await expect(service.deleteExpiredLogs()).resolves.toBe(0);
    expect(runner.rollbackTransaction).toHaveBeenCalled();
    expect(runner.commitTransaction).not.toHaveBeenCalled();
    expect(runner.query.mock.calls.some(([sql]) => sql.includes('pg_advisory_unlock'))).toBe(true);
  });

  it('survives a non-Error failure and a failing release', async () => {
    runner.connect.mockRejectedValue('no connection');
    runner.release.mockRejectedValue(new Error('already released'));
    await expect(service.deleteExpiredLogs()).resolves.toBe(0);
  });

  it('survives a failing unlock', async () => {
    database(7, {
      pg_advisory_unlock: () => {
        throw new Error('gone');
      },
    });
    await expect(service.deleteExpiredLogs()).resolves.toBe(0);
  });
});
