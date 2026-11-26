import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Instance-wide settings a self-hosted super admin manages from the dashboard:
 * who the super admin is, whether new people can sign up, and how many days
 * Requests and Provider Attempts are kept (NULL keeps them forever).
 *
 * They live on the existing `install_metadata` singleton, like the Autofix
 * consent, so there is no new table. Defaults keep today's behaviour: sign-up
 * stays open and nothing is deleted.
 */
export class AddInstanceAdminSettings1803400000000 implements MigrationInterface {
  name = 'AddInstanceAdminSettings1803400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(
      `ALTER TABLE "install_metadata" ADD COLUMN IF NOT EXISTS "super_admin_user_id" varchar DEFAULT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "install_metadata" ADD COLUMN IF NOT EXISTS "signup_enabled" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "install_metadata" ADD COLUMN IF NOT EXISTS "log_retention_days" integer DEFAULT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "install_metadata" DROP CONSTRAINT IF EXISTS "CHK_install_metadata_log_retention_days"`,
    );
    await queryRunner.query(
      `ALTER TABLE "install_metadata" ADD CONSTRAINT "CHK_install_metadata_log_retention_days" CHECK ("log_retention_days" IS NULL OR "log_retention_days" IN (1, 7, 15, 30, 60, 90))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(
      `ALTER TABLE "install_metadata" DROP CONSTRAINT IF EXISTS "CHK_install_metadata_log_retention_days"`,
    );
    await queryRunner.query(
      `ALTER TABLE "install_metadata" DROP COLUMN IF EXISTS "log_retention_days"`,
    );
    await queryRunner.query(
      `ALTER TABLE "install_metadata" DROP COLUMN IF EXISTS "signup_enabled"`,
    );
    await queryRunner.query(
      `ALTER TABLE "install_metadata" DROP COLUMN IF EXISTS "super_admin_user_id"`,
    );
  }
}
