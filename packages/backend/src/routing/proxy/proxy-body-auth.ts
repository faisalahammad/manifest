import { HttpException, UnauthorizedException } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import type { AgentKeyAuthGuard } from '../../otlp/guards/agent-key-auth.guard';
import type { ProxyBodyOptions } from '../../common/middleware/body-parser-limits';
import type { ProxyExceptionFilter } from './proxy-exception.filter';

/**
 * Runs the proxy's own key check before a large body is read. A refusal is
 * answered by the proxy exception filter, so callers get the same envelope as
 * from a route.
 */
export function createProxyBodyAuthenticator(
  guard: Pick<AgentKeyAuthGuard, 'canActivate'>,
  filter: Pick<ProxyExceptionFilter, 'catch'>,
): ProxyBodyOptions['authenticate'] {
  return async (req, res) => {
    const context = new ExecutionContextHost([req, res]);
    try {
      if (await guard.canActivate(context)) return null;
      throw new UnauthorizedException('Invalid API key');
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      return () => filter.catch(error, context);
    }
  };
}
