import { ArgumentsHost, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createProxyBodyAuthenticator } from './proxy-body-auth';

describe('createProxyBodyAuthenticator', () => {
  const req = { headers: {} } as Request;
  const res = {} as Response;

  it('accepts a caller the proxy guard accepts', async () => {
    const guard = {
      canActivate: jest.fn(async (context: ExecutionContext) => {
        expect(context.switchToHttp().getRequest()).toBe(req);
        return true;
      }),
    };
    const filter = { catch: jest.fn() };

    await expect(createProxyBodyAuthenticator(guard, filter)(req, res)).resolves.toBeNull();

    expect(guard.canActivate).toHaveBeenCalledTimes(1);
    expect(filter.catch).not.toHaveBeenCalled();
  });

  it('refuses through the proxy exception filter, but only when told to answer', async () => {
    const refusal = new UnauthorizedException('Invalid API key');
    const guard = { canActivate: jest.fn().mockRejectedValue(refusal) };
    const filter = {
      catch: jest.fn((_error: unknown, host: ArgumentsHost) => {
        expect(host.switchToHttp().getResponse()).toBe(res);
      }),
    };

    const refuse = await createProxyBodyAuthenticator(guard, filter)(req, res);
    expect(filter.catch).not.toHaveBeenCalled();
    refuse?.();

    expect(filter.catch).toHaveBeenCalledWith(refusal, expect.anything());
  });

  it('refuses a caller the guard turns down without throwing', async () => {
    const guard = { canActivate: jest.fn().mockResolvedValue(false) };
    const filter = { catch: jest.fn() };

    const refuse = await createProxyBodyAuthenticator(guard, filter)(req, res);
    refuse?.();

    expect(filter.catch).toHaveBeenCalledWith(expect.any(UnauthorizedException), expect.anything());
  });

  it('lets unexpected failures reach the error handler', async () => {
    const failure = new Error('database down');
    const guard = { canActivate: jest.fn().mockRejectedValue(failure) };
    const filter = { catch: jest.fn() };

    await expect(createProxyBodyAuthenticator(guard, filter)(req, res)).rejects.toBe(failure);

    expect(filter.catch).not.toHaveBeenCalled();
  });
});
