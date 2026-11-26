import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { isSelfHosted } from '../common/utils/detect-self-hosted';
import { InstanceSettingsService } from './instance-settings.service';

type AdminRequest = Request & { authMethod?: string; user?: { id?: string } };

/**
 * Lets through only the super admin, signed in through the dashboard. API keys
 * and CLI tokens are tenant credentials, so they never reach instance settings.
 */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  constructor(private readonly settings: InstanceSettingsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    if (!isSelfHosted()) {
      throw new ForbiddenException('Instance settings are only available on self-hosted installs');
    }
    if (request.authMethod !== 'session') {
      throw new ForbiddenException('Instance settings need a dashboard session');
    }
    if (!(await this.settings.isSuperAdmin(request.user?.id))) {
      throw new ForbiddenException('Only the super admin can manage instance settings');
    }
    return true;
  }
}
