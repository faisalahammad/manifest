import { Module } from '@nestjs/common';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { AdminController } from './admin.controller';
import { InstanceSettingsService } from './instance-settings.service';
import { LogRetentionService } from './log-retention.service';
import { SuperAdminGuard } from './super-admin.guard';

@Module({
  imports: [TelemetryModule],
  controllers: [AdminController],
  providers: [InstanceSettingsService, SuperAdminGuard, LogRetentionService],
})
export class AdminModule {}
