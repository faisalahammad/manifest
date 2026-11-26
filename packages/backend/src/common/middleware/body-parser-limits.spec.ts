import express, { Request, Response } from 'express';
import { EventEmitter } from 'events';
import { once } from 'events';
import { connect, Socket } from 'net';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { Readable } from 'stream';
import request from 'supertest';
import { gzipSync } from 'zlib';
import {
  API_BODY_LIMIT,
  API_BODY_LIMIT_BYTES,
  PROXY_BODY_LIMIT,
  PROXY_BODY_LIMIT_BYTES,
  ProxyBodyOptions,
  bodyParserErrorHandler,
  createAuthBodyMiddleware,
  createProxyBodyMiddleware,
  discardBody,
} from './body-parser-limits';

const MB = 1024 * 1024;

const allow = async () => true;

function createApp(options: Partial<ProxyBodyOptions> = {}, authIdleTimeoutMs?: number) {
  const handled = jest.fn();
  const failed = jest.fn();
  const app = express();
  app.all('/api/auth/*splat', createAuthBodyMiddleware(authIdleTimeoutMs), (req, res) => {
    handled();
    res.json({ type: typeof req.body, body: req.body ?? null });
  });
  app.use('/v1', createProxyBodyMiddleware({ authenticate: allow, ...options }));
  app.use(express.json({ limit: API_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: API_BODY_LIMIT }));
  app.use(bodyParserErrorHandler);
  const reply = (req: Request, res: Response) => {
    handled();
    res.json({ contentLength: String(req.body?.messages?.[0]?.content ?? '').length });
  };
  app.post('/v1/chat/completions', reply);
  app.get('/v1/models', reply);
  app.post('/api/v1/test', reply);
  // Anything that reaches Express's own error handler is a bug in these tests.
  app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    failed(err);
    res.status(500).end();
  });
  return { app, handled, failed };
}

const chatBody = (bytes: number) => ({ messages: [{ role: 'user', content: 'x'.repeat(bytes) }] });

const servers: Server[] = [];
const sockets: Socket[] = [];

async function listen(app: express.Express): Promise<number> {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

/** A request sent by hand, so a test controls exactly which bytes arrive and when. */
function open(port: number, path: string, headers: string[], method = 'POST') {
  const socket = connect(port, '127.0.0.1');
  sockets.push(socket);
  let reply = '';
  const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
  const replied = new Promise<string>((resolve) => {
    socket.on('data', (chunk) => {
      reply += chunk.toString();
      resolve(reply.split('\r\n')[0]);
    });
    socket.on('close', () => resolve(reply.split('\r\n')[0]));
  });
  socket.on('error', () => undefined);
  socket.write(
    [`${method} ${path} HTTP/1.1`, 'Host: localhost', 'Connection: close', ...headers, '', ''].join(
      '\r\n',
    ),
  );
  return { socket, closed, replied, text: () => reply };
}

const openJson = (port: number, length: number) =>
  open(port, '/v1/chat/completions', [
    'Content-Type: application/json',
    `Content-Length: ${length}`,
  ]);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createMockResponse() {
  const res = new EventEmitter() as express.Response & EventEmitter;
  res.status = jest.fn(() => res) as unknown as express.Response['status'];
  res.json = jest.fn(() => res) as unknown as express.Response['json'];
  return res;
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

describe('proxy body middleware', () => {
  it('lets an authenticated caller send bodies above the regular API limit', async () => {
    const authenticate = jest.fn(allow);
    const { app } = createApp({ authenticate });
    const payload = chatBody(API_BODY_LIMIT_BYTES + 1);

    const proxy = await request(app).post('/v1/chat/completions').send(payload).expect(200);
    const api = await request(app).post('/api/v1/test').send(payload).expect(413);

    expect(proxy.body).toEqual({ contentLength: API_BODY_LIMIT_BYTES + 1 });
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(api.body).toEqual({
      message: 'Request body is too large',
      error: 'Payload Too Large',
      statusCode: 413,
    });
  });

  it('leaves small bodies to the route guard', async () => {
    const authenticate = jest.fn(allow);
    const { app } = createApp({ authenticate });

    await request(app).post('/v1/chat/completions').send(chatBody(10)).expect(200);

    expect(authenticate).not.toHaveBeenCalled();
  });

  it('reads nothing large from a caller that fails authentication', async () => {
    const authenticate = jest.fn(async (_req: Request, res: Response) => {
      res.status(401).json({ error: 'nope' });
      return false;
    });
    const { app, handled } = createApp({ authenticate });
    const port = await listen(app);

    // Only the headers are sent: no parser waits for the rest.
    const upload = openJson(port, 2 * MB);

    expect(await upload.replied).toContain('401');
    expect(handled).not.toHaveBeenCalled();
  });

  it('stops quietly when the caller leaves during authentication', async () => {
    let release: (value: boolean) => void = () => undefined;
    let gone: Promise<unknown> = Promise.resolve();
    const authenticate = jest.fn((_req: Request, res: Response) => {
      gone = once(res, 'close');
      return new Promise<boolean>((resolve) => (release = resolve));
    });
    const { app, handled, failed } = createApp({ authenticate });
    const port = await listen(app);

    const upload = openJson(port, 2 * MB);
    await wait(50);
    upload.socket.destroy();
    await gone;
    release(true);
    await wait(20);

    expect(handled).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });

  it('refuses compressed bodies instead of inflating them', async () => {
    const { app, handled } = createApp();
    const compressed = gzipSync(Buffer.from(JSON.stringify(chatBody(8 * MB))));

    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .serialize((body) => body as string)
      .send(compressed as unknown as string)
      .expect(415);

    expect(res.body).toEqual({
      message: 'Unsupported request body encoding',
      error: 'Unsupported Media Type',
      statusCode: 415,
    });
    expect(handled).not.toHaveBeenCalled();
  });

  it('refuses bodies above the proxy limit before authenticating or reading', async () => {
    const authenticate = jest.fn(allow);
    const { app } = createApp({ authenticate });
    const port = await listen(app);

    const upload = openJson(port, PROXY_BODY_LIMIT_BYTES + 1);

    expect(await upload.replied).toContain('413');
    await upload.closed.catch(() => undefined);
    expect(upload.text()).toContain(`Request body exceeds ${PROXY_BODY_LIMIT}`);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('accepts a body of exactly the proxy limit', async () => {
    const authenticate = jest.fn(allow);
    const { app } = createApp({ authenticate });
    const port = await listen(app);

    openJson(port, PROXY_BODY_LIMIT_BYTES);
    await wait(50);

    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it('reserves nothing for a caller that fails authentication', async () => {
    const authenticate = jest.fn(async (req: Request, res: Response) => {
      if (req.headers.authorization) return true;
      res.status(401).end();
      return false;
    });
    const { app } = createApp({ authenticate, inFlightLimitBytes: 4 * MB });
    const port = await listen(app);

    const stranger = openJson(port, 4 * MB);
    expect(await stranger.replied).toContain('401');

    await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer key')
      .send(chatBody(2 * MB))
      .expect(200);
  });

  it('holds a large body size in the budget until its response ends', async () => {
    const { app, handled } = createApp({ inFlightLimitBytes: 4 * MB });
    const port = await listen(app);
    const body = JSON.stringify(chatBody(10)).padEnd(3 * MB);

    const holder = openJson(port, body.length);
    await wait(50);

    // Refused on its declared size, before a byte of it is read.
    const refused = openJson(port, 2 * MB);
    expect(await refused.replied).toContain('429');
    expect(refused.text()).toContain('Too Many Requests');

    holder.socket.write(body);
    expect(await holder.replied).toContain('200');
    await holder.closed;

    const next = openJson(port, body.length);
    next.socket.write(body);
    expect(await next.replied).toContain('200');
    expect(handled).toHaveBeenCalledTimes(2);
  });

  it('drops a body that stops arriving and frees its budget', async () => {
    const { app, handled, failed } = createApp({
      inFlightLimitBytes: 4 * MB,
      idleTimeoutMs: 200,
    });
    const port = await listen(app);

    const stalled = openJson(port, 3 * MB);
    stalled.socket.write('x'.repeat(2 * MB));

    expect(await stalled.replied).toContain('408');
    await stalled.closed;
    await request(app)
      .post('/v1/chat/completions')
      .send(chatBody(3 * MB))
      .expect(200);
    expect(handled).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
  });

  it('times out small bodies too', async () => {
    const { app } = createApp({ idleTimeoutMs: 100 });
    const port = await listen(app);

    const stalled = openJson(port, 100);

    expect(await stalled.replied).toContain('408');
  });

  it('keeps a slow body that is still arriving', async () => {
    const { app } = createApp({ idleTimeoutMs: 300 });
    const port = await listen(app);
    const body = JSON.stringify(chatBody(10));

    const slow = openJson(port, body.length);
    for (const part of body.match(/.{1,9}/g) as string[]) {
      slow.socket.write(part);
      await wait(80);
    }

    expect(await slow.replied).toContain('200');
  });

  it('rejects chunked bodies, which declare no length', async () => {
    const { app } = createApp();
    const port = await listen(app);

    const upload = open(port, '/v1/chat/completions', ['Transfer-Encoding: chunked']);

    expect(await upload.replied).toContain('411');
  });

  it('spots chunked encoding however the caller spells it', async () => {
    const { app, handled } = createApp();
    const port = await listen(app);

    const upload = open(port, '/v1/chat/completions', [
      'Content-Type: application/json',
      'Transfer-Encoding: Chunked',
    ]);

    expect(await upload.replied).toContain('411');
    expect(handled).not.toHaveBeenCalled();
  });

  // A second fence: the unauthenticated parser cannot read more than the API
  // limit, whatever the headers claim.
  it('never reads more than the API limit without authenticating', async () => {
    const authenticate = jest.fn(allow);
    const middleware = createProxyBodyMiddleware({ authenticate });
    const body = Buffer.from(JSON.stringify(chatBody(2 * MB)));
    const req = Object.assign(Readable.from([body]), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'identity' },
    }) as unknown as express.Request;

    const error = await new Promise((resolve) => {
      void middleware(req, createMockResponse(), resolve);
    });

    expect(error).toMatchObject({ type: 'entity.too.large' });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('passes requests without a body', async () => {
    const authenticate = jest.fn(allow);
    const { app } = createApp({ authenticate });

    await request(app).get('/v1/models').expect(200);

    expect(authenticate).not.toHaveBeenCalled();
  });

  it('applies the same rules to a GET that carries a large body', async () => {
    const authenticate = jest.fn(async (_req: Request, res: Response) => {
      res.status(401).end();
      return false;
    });
    const { app, handled } = createApp({ authenticate });
    const port = await listen(app);

    const download = open(port, '/v1/models', [`Content-Length: ${2 * MB}`], 'GET');

    expect(await download.replied).toContain('401');
    expect(handled).not.toHaveBeenCalled();
  });

  it('limits urlencoded proxy bodies to the regular API limit', async () => {
    const { app } = createApp();

    await request(app)
      .post('/v1/chat/completions')
      .type('form')
      .send(`a=${'x'.repeat(2 * MB)}`)
      .expect(413);
  });

  it('returns JSON 400s for malformed proxy JSON', async () => {
    const { app } = createApp();

    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Content-Type', 'application/json')
      .send('{"messages":')
      .expect(400);

    expect(res.body).toEqual({
      message: 'Invalid JSON request body',
      error: 'Bad Request',
      statusCode: 400,
    });
  });

  it('rejects invalid Content-Length headers', async () => {
    const middleware = createProxyBodyMiddleware({ authenticate: allow });
    for (const value of ['-1', 'abc']) {
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(
        { method: 'POST', headers: { 'content-length': value } } as express.Request,
        res,
        next,
      );

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        message: 'Invalid Content-Length header',
        error: 'Bad Request',
        statusCode: 400,
      });
    }
  });
});

describe('discardBody', () => {
  const refuse = (idleTimeoutMs?: number) => {
    const app = express();
    app.post('/v1/chat/completions', async (req, res) => {
      await discardBody(req, res, idleTimeoutMs);
      if (!res.headersSent) res.status(401).end();
    });
    return app;
  };

  it('reads the whole body so a closing client still gets the answer', async () => {
    const port = await listen(refuse());
    const body = 'x'.repeat(8 * MB);

    const upload = openJson(port, body.length);
    upload.socket.write(body);

    expect(await upload.replied).toContain('401');
  });

  it('gives up on a refused body that stops arriving', async () => {
    const port = await listen(refuse(100));

    const upload = openJson(port, 2 * MB);

    expect(await upload.replied).toContain('408');
  });
});

describe('auth body middleware', () => {
  const signIn = '/api/auth/sign-in/email';

  it('hands the body to the auth handler as the exact text sent', async () => {
    const { app } = createApp();
    const raw = '{ "name": "Zoë — 試験",\n  "n": 1.50 }';

    const res = await request(app)
      .post(signIn)
      .set('Content-Type', 'application/json')
      .send(raw)
      .expect(200);

    expect(res.body).toEqual({ type: 'string', body: raw });
  });

  it('reports an empty body as no body', async () => {
    const { app } = createApp();

    const res = await request(app)
      .post(signIn)
      .set('Content-Type', 'application/json')
      .set('Content-Length', '0')
      .expect(200);

    expect(res.body).toEqual({ type: 'undefined', body: null });
  });

  it('passes requests without a body', async () => {
    const { app } = createApp();

    const res = await request(app).get('/api/auth/get-session').expect(200);

    expect(res.body.body).toBeNull();
  });

  it('refuses a declared length above the limit', async () => {
    const { app, handled } = createApp();

    await request(app)
      .post(signIn)
      .send({ password: 'x'.repeat(API_BODY_LIMIT_BYTES) })
      .expect(413);

    expect(handled).not.toHaveBeenCalled();
  });

  it('refuses a chunked body that grows past the limit', async () => {
    const { app, handled } = createApp();
    const port = await listen(app);

    const upload = open(port, signIn, [
      'Content-Type: application/json',
      'Transfer-Encoding: chunked',
    ]);
    const chunk = 'x'.repeat(512 * 1024);
    for (let i = 0; i < 4; i++) {
      upload.socket.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
    }
    upload.socket.write('0\r\n\r\n');

    expect(await upload.replied).toContain('413');
    expect(handled).not.toHaveBeenCalled();
  });

  it('refuses compressed bodies', async () => {
    const { app } = createApp();

    await request(app)
      .post(signIn)
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .serialize((body) => body as string)
      .send(gzipSync('{}') as unknown as string)
      .expect(415);
  });

  it('drops a body that stops arriving', async () => {
    const { app, handled, failed } = createApp({}, 100);
    const port = await listen(app);

    const stalled = open(port, signIn, ['Transfer-Encoding: chunked']);
    stalled.socket.write('2\r\nhi\r\n');

    expect(await stalled.replied).toContain('408');
    await stalled.closed;
    await wait(20);
    expect(handled).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });
});

describe('bodyParserErrorHandler', () => {
  it('passes through non-body-parser errors', () => {
    const res = createMockResponse();
    const next = jest.fn();
    const err = new Error('boom');

    bodyParserErrorHandler(err, {} as express.Request, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('passes through unsupported body-parser errors', () => {
    const res = createMockResponse();
    const next = jest.fn();
    const err = Object.assign(new Error('unsupported parser error'), {
      type: 'entity.verify.failed',
    });

    bodyParserErrorHandler(err, {} as express.Request, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('says nothing more once a request has been answered', () => {
    const res = createMockResponse();
    Object.defineProperty(res, 'headersSent', { value: true });
    const next = jest.fn();
    const err = Object.assign(new Error('request aborted'), { type: 'request.aborted' });

    bodyParserErrorHandler(err, {} as express.Request, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
