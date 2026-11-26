import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InstallMetadata } from '../entities/install-metadata.entity';
import { isSelfHosted } from '../common/utils/detect-self-hosted';
import { InstallIdService, SINGLETON_ID } from '../telemetry/install-id.service';

export interface InstanceSettings {
  signupEnabled: boolean;
  /** Days to keep Requests and Provider Attempts; null keeps them forever. */
  logRetentionDays: number | null;
}

export interface InstanceSettingsPatch {
  signupEnabled?: boolean;
  logRetentionDays?: number | null;
}

/**
 * Instance-wide settings of a self-hosted install, kept on the
 * `install_metadata` singleton.
 *
 * The super admin is an install-level role, not tenant data: it is the first
 * user who signed up (the one the setup wizard creates). It is resolved lazily
 * and stored, so installs that existed before this feature get their oldest
 * user. If that user is deleted, the next oldest user takes over, so the
 * install never ends up with nobody able to manage it.
 */
@Injectable()
export class InstanceSettingsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly installId: InstallIdService,
  ) {}

  async getSuperAdminUserId(): Promise<string | null> {
    const row = await this.installId.getOrCreate();
    if (row.super_admin_user_id) {
      const existing = (await this.dataSource.query(`SELECT 1 FROM "user" WHERE "id" = $1`, [
        row.super_admin_user_id,
      ])) as unknown[];
      if (existing.length > 0) return row.super_admin_user_id;
    }
    const oldest = (await this.dataSource.query(
      `SELECT "id" FROM "user" ORDER BY "createdAt" ASC, "id" ASC LIMIT 1`,
    )) as Array<{ id: string }>;
    const userId = oldest[0]?.id ?? null;
    if (userId) {
      await this.repo().update(SINGLETON_ID, { super_admin_user_id: userId });
    }
    return userId;
  }

  async isSuperAdmin(userId: string | null | undefined): Promise<boolean> {
    if (!isSelfHosted() || !userId) return false;
    return (await this.getSuperAdminUserId()) === userId;
  }

  async getSettings(): Promise<InstanceSettings> {
    const row = await this.installId.getOrCreate();
    return {
      signupEnabled: row.signup_enabled !== false,
      logRetentionDays: row.log_retention_days ?? null,
    };
  }

  async updateSettings(patch: InstanceSettingsPatch): Promise<InstanceSettings> {
    await this.installId.getOrCreate();
    const changes: Partial<InstallMetadata> = {};
    if (patch.signupEnabled !== undefined) changes.signup_enabled = patch.signupEnabled;
    if (patch.logRetentionDays !== undefined) changes.log_retention_days = patch.logRetentionDays;
    if (Object.keys(changes).length > 0) await this.repo().update(SINGLETON_ID, changes);
    return this.getSettings();
  }

  private repo() {
    return this.dataSource.getRepository(InstallMetadata);
  }
}
