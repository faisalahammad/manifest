import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { LOG_RETENTION_DAY_OPTIONS } from 'manifest-shared';

export class UpdateInstanceSettingsDto {
  @IsOptional()
  @IsBoolean()
  signupEnabled?: boolean;

  /** One of LOG_RETENTION_DAY_OPTIONS, or null to keep logs forever. */
  @IsOptional()
  @IsIn([...LOG_RETENTION_DAY_OPTIONS])
  logRetentionDays?: number | null;
}
