import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource, QueryRunner } from 'typeorm';
import { RequestRecordingStorageService } from '../common/services/request-recording-storage.service';
import { isSelfHosted } from '../common/utils/detect-self-hosted';

const LOG_RETENTION_LOCK_KEY = 4011987;
export const LOG_RETENTION_BATCH_SIZE = 1000;
/** Caps one nightly run at 500k rows so a first run on a huge table stays bounded. */
export const LOG_RETENTION_MAX_BATCHES = 500;

const TRY_LOCK_SQL = `SELECT pg_try_advisory_lock(${LOG_RETENTION_LOCK_KEY}::bigint) AS acquired`;
const UNLOCK_SQL = `SELECT pg_advisory_unlock(${LOG_RETENTION_LOCK_KEY}::bigint)`;

const SELECT_RETENTION_DAYS_SQL = `
  SELECT "log_retention_days" FROM "install_metadata" WHERE "id" = 'singleton'
`;

// Skips Requests still waiting for the agent_usage_daily rollup (same filter
// the rollup selects on), so deleting old rows never drops them from usage
// totals. No ORDER BY: old rows sit at the start of the heap, so the scan can
// stop at the LIMIT instead of sorting the whole table.
const SELECT_EXPIRED_REQUESTS_SQL = `
  SELECT "id" FROM "requests"
  WHERE "timestamp" < CURRENT_TIMESTAMP - ($1 * INTERVAL '1 day')
    AND NOT (
      "agent_usage_rolled_up_at" IS NULL
      AND ("status" IS NULL OR "status" NOT IN ('pending', 'cancelled'))
      AND "tenant_id" IS NOT NULL
      AND "agent_id" IS NOT NULL
    )
  LIMIT $2
`;

// Provider Attempts recorded before the requests table existed have no Request.
const SELECT_EXPIRED_UNLINKED_ATTEMPTS_SQL = `
  SELECT "id" FROM "agent_messages"
  WHERE "request_id" IS NULL
    AND "timestamp" < CURRENT_TIMESTAMP - ($1 * INTERVAL '1 day')
  LIMIT $2
`;

interface PurgePlan {
  label: string;
  selectIds: string;
  /** Returns `{ owner_id, storage_key }` for every recording the batch owns. */
  selectRecordings: string;
  deletes: string[];
}

const REQUEST_PLAN: PurgePlan = {
  label: 'Request',
  selectIds: SELECT_EXPIRED_REQUESTS_SQL,
  selectRecordings: `
    SELECT "request_id" AS owner_id, "recording_key" AS storage_key FROM "agent_messages"
    WHERE "request_id" = ANY($1) AND "recording_key" IS NOT NULL
  `,
  deletes: [
    `DELETE FROM "agent_messages" WHERE "request_id" = ANY($1)`,
    `DELETE FROM "requests" WHERE "id" = ANY($1)`,
  ],
};

const UNLINKED_ATTEMPT_PLAN: PurgePlan = {
  label: 'unlinked Provider Attempt',
  selectIds: SELECT_EXPIRED_UNLINKED_ATTEMPTS_SQL,
  selectRecordings: `
    SELECT "id" AS owner_id, "recording_key" AS storage_key FROM "agent_messages"
    WHERE "id" = ANY($1) AND "recording_key" IS NOT NULL
  `,
  deletes: [`DELETE FROM "agent_messages" WHERE "id" = ANY($1) AND "request_id" IS NULL`],
};

/**
 * Deletes TierGate Requests and their Provider Attempts older than the window
 * the super admin picked on the Instance settings page. Self-hosted only: the
 * setting does not exist on Cloud, and nothing is deleted while it is unset.
 *
 * Recordings are deleted from storage first. A Request whose recording cannot
 * be deleted is kept for the next run, so its body is never left behind with
 * no row pointing at it.
 */
@Injectable()
export class LogRetentionService {
  private readonly logger = new Logger(LogRetentionService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: RequestRecordingStorageService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'log-retention', waitForCompletion: true })
  async deleteExpiredLogs(): Promise<number> {
    if (!isSelfHosted()) return 0;

    const queryRunner = this.dataSource.createQueryRunner();
    let acquired = false;
    try {
      await queryRunner.connect();
      const settings = (await queryRunner.query(SELECT_RETENTION_DAYS_SQL)) as Array<{
        log_retention_days: number | null;
      }>;
      const days = settings[0]?.log_retention_days ?? null;
      if (days === null) return 0;

      const lockRows = (await queryRunner.query(TRY_LOCK_SQL)) as Array<{ acquired?: boolean }>;
      acquired = lockRows[0]?.acquired === true;
      if (!acquired) return 0;

      let deleted = 0;
      for (const plan of [REQUEST_PLAN, UNLINKED_ATTEMPT_PLAN]) {
        const count = await this.purge(queryRunner, plan, days);
        if (count > 0) {
          this.logger.log(`Deleted ${count} ${plan.label}(s) older than ${days} day(s)`);
        }
        deleted += count;
      }
      return deleted;
    } catch (error) {
      this.logger.error(
        `Log retention failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    } finally {
      if (acquired) await queryRunner.query(UNLOCK_SQL).catch(() => undefined);
      await queryRunner.release().catch(() => undefined);
    }
  }

  private async purge(queryRunner: QueryRunner, plan: PurgePlan, days: number): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < LOG_RETENTION_MAX_BATCHES; batch++) {
      const rows = (await queryRunner.query(plan.selectIds, [
        days,
        LOG_RETENTION_BATCH_SIZE,
      ])) as Array<{ id: string }>;
      if (rows.length === 0) break;

      const ids = rows.map((row) => row.id);
      const kept = await this.deleteRecordings(queryRunner, plan.selectRecordings, ids);
      const doomed = ids.filter((id) => !kept.has(id));
      if (doomed.length > 0) {
        await queryRunner.startTransaction();
        try {
          for (const sql of plan.deletes) await queryRunner.query(sql, [doomed]);
          await queryRunner.commitTransaction();
        } catch (error) {
          await queryRunner.rollbackTransaction();
          throw error;
        }
        total += doomed.length;
      }
      // A short batch means nothing older is left; an all-kept batch would
      // only select the same rows again.
      if (rows.length < LOG_RETENTION_BATCH_SIZE || doomed.length === 0) break;
    }
    return total;
  }

  /** Deletes the batch's recordings and returns the ids whose deletion failed. */
  private async deleteRecordings(
    queryRunner: QueryRunner,
    selectSql: string,
    ids: string[],
  ): Promise<Set<string>> {
    const recordings = (await queryRunner.query(selectSql, [ids])) as Array<{
      owner_id: string;
      storage_key: string;
    }>;
    const kept = new Set<string>();
    for (const recording of recordings) {
      if (kept.has(recording.owner_id)) continue;
      try {
        await this.storage.delete(recording.storage_key);
      } catch (error) {
        kept.add(recording.owner_id);
        this.logger.warn(
          `Kept ${recording.owner_id}: could not delete its recording: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return kept;
  }
}
