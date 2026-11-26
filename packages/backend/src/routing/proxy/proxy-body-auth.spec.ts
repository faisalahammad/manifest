import { ArgumentsHost, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { Request, Response } from 'express';
import { createProxyBodyAuthenticator } from './proxy-body-auth';

describe('createProxyBodyAuthenticator', () => {
  let req: Request & PassThrough;
  let res: Response & EventEmitter;

  beforeEach(() => {
    req = Object.assign(new PassThrough(), { headers: {} }) as unknown as Request & PassThrough;
    res = Object.assign(new EventEmitter(), { headersSent: false }) as unknown as Response &
      EventEmitter;
  });

  it('accepts a caller the proxy guard accepts', async () => {
    const guard = {
      canActivate: jest.fn(async (context: ExecutionContext) => {
        expect(context.switchToHttp().getRequest()).toBe(req);
        return true;
      }),
    };
    const filter = { catch: jest.fn() };

    await expect(createProxyBodyAuthenticator(guard, filter)(req, res)).resolves.toBe(true);

    expect(guard.canActivate).toHaveBeenCalledTimes(1);
    expect(filter.catch).not.toHaveBeenCalled();
  });

  it('answers a refused caller through the proxy exception filter', async () => {
    const refusal = new UnauthorizedException('Invalid API key');
    const guard = { canActivate: jest.fn().mockRejectedValue(refusal) };
    const filter = {
      catch: jest.fn((_error: unknown, host: ArgumentsHost) => {
        expect(host.switchToHttp().getResponse()).toBe(res);
      }),
    };

    const outcome = createProxyBodyAuthenticator(guard, filter)(req, res);
    req.end('the rest of the upload');

    await expect(outcome).resolves.toBe(false);
    expect(filter.catch).toHaveBeenCalledWith(refusal, expect.anything());
  });

  it('takes the whole body before it answers a refusal', async () => {
    const guard = { canActivate: jest.fn().mockRejectedValue(new UnauthorizedException()) };
    const filter = { catch: jest.fn() };

    const outcome = createProxyBodyAuthenticator(guard, filter)(req, res);
    req.write('part of the upload');
    await new Promise((resolve) => setImmediate(resolve));
    expect(filter.catch).not.toHaveBeenCalled();
    req.end();
    await outcome;

    expect(filter.catch).toHaveBeenCalledTimes(1);
  });

  it('answers nothing more when the refused body was already answered', async () => {
    const guard = { canActivate: jest.fn().mockRejectedValue(new UnauthorizedException()) };
    const filter = { catch: jest.fn() };

    const outcome = createProxyBodyAuthenticator(guard, filter)(req, res);
    Object.assign(res, { headersSent: true });
    req.destroy();

    await expect(outcome).resolves.toBe(false);
    expect(filter.catch).not.toHaveBeenCalled();
  });

  it('lets unexpected failures reach the error handler', async () => {
    const failure = new Error('database down');
    const guard = { canActivate: jest.fn().mockRejectedValue(failure) };
    const filter = { catch: jest.fn() };

    await expect(createProxyBodyAuthenticator(guard, filter)(req, res)).rejects.toBe(failure);

    expect(filter.catch).not.toHaveBeenCalled();
  });
});
