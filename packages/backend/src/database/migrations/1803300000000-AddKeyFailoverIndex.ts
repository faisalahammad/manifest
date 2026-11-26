import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `agent_messages.key_failover_index`: the position of a Provider Attempt
 * inside its hop when key failover moved past an earlier key of the same
 * provider (1 = the second key tried). Null for the first key, and for every
 * attempt written before key failover existed.
 *
 * A nullable column with no default is a catalog-only change in PostgreSQL,
 * so this is safe on the large `agent_messages` table. No index: the column
 * is read per Request, next to columns already reached through `request_id`.
 */
export class AddKeyFailoverIndex1803300000000 implements MigrationInterface {
  name = 'AddKeyFailoverIndex1803300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "key_failover_index" integer`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_messages" DROP COLUMN IF EXISTS "key_failover_index"`,
    );
  }
}
