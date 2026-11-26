import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { UpdateInstanceSettingsDto } from './dto/update-instance-settings.dto';
import { InstanceSettings, InstanceSettingsService } from './instance-settings.service';
import { SuperAdminGuard } from './super-admin.guard';

type AdminRequest = Request & { authMethod?: string; user?: { id?: string } };

@Controller('api/v1/admin')
export class AdminController {
  constructor(private readonly settings: InstanceSettingsService) {}

  /** Tells the dashboard whether to show the Instance settings page. */
  @Get('status')
  async getStatus(@Req() request: AdminRequest): Promise<{ isSuperAdmin: boolean }> {
    const isSuperAdmin =
      request.authMethod === 'session' && (await this.settings.isSuperAdmin(request.user?.id));
    return { isSuperAdmin };
  }

  @Get('settings')
  @UseGuards(SuperAdminGuard)
  getSettings(): Promise<InstanceSettings> {
    return this.settings.getSettings();
  }

  @Patch('settings')
  @UseGuards(SuperAdminGuard)
  updateSettings(@Body() dto: UpdateInstanceSettingsDto): Promise<InstanceSettings> {
    return this.settings.updateSettings(dto);
  }
}
