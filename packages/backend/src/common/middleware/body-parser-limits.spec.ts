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
  API_BODY_LIMIT_BYTES,
  BodyWatcherLimits,
  PROXY_BODY_LIMIT,
  PROXY_BODY_LIMIT_BYTES,
  ProxyBodyOptions,
  bodyParserErrorHandler,
  createApiBodyMiddleware,
  createAuthBodyMiddleware,
  createBodyWatcher,
  createProxyBodyMiddleware,
  watchLeftoverBodies,
} from './body-parser-limits';

const MB = 1024 * 1024;

const allow = async () => null;
const refuseWith401 = jest.fn(async (_req: Request, res: Response) => () => {
  res.status(401).json({ error: 'nope' });
});

type AppOptions = BodyWatcherLimits &
  Partial<Pick<ProxyBodyOptions, 'authenticate' | 'inFlightLimitBytes'>>;

/** The middleware in the order `main.ts` mounts it. */
function createApp({ authenticate = allow, inFlightLimitBytes, ...limits }: AppOptions = {}) {
  const handled = jest.fn();
  const failed = jest.fn();
  const watch = createBodyWatcher(limits);
  const app = express();
  app.use(watchLeftoverBodies(watch));
  app.post('/api/v1/limited', (_req, res) => {
    res.status(429).end();
  });
  app.all('/api/auth/*splat', createAuthBodyMiddleware(watch), (req, res) => {
    handled();
    res.json({ type: typeof req.body, body: req.body ?? null });
  });
  app.use('/v1', createProxyBodyMiddleware({ watch, authenticate, inFlightLimitBytes }));
  app.use(createApiBodyMiddleware(watch));
  app.use(bodyParserErrorHandler);
  const reply = (req: Request, res: Response) => {
    handled();
    res.json({ contentLength: String(req.body?.messages?.[0]?.content ?? '').length });
  };
  app.post('/v1/chat/completions', reply);
  app.get('/v1/models', reply);
  app.post('/api/v1/test', reply);
  app.post('/api/v1/echo', (req, res) => {
    res.json(req.body);
  });
  app.post('/api/v1/slow', (_req, res) => {
    setTimeout(() => res.status(200).end(), 300);
  });
  // Anything that reaches Express's own error handler is a bug in these tests.
  app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    failed(err);
    res.status(500).end();
  });
  return { app, handled, failed };
}

const chatBody = (bytes: number) => ({ messages: [{ role: 'user', content: 'x'.repeat(bytes) }] });
/** A valid chat body padded with spaces to exactly `bytes`. */
const padded = (bytes: number) => JSON.stringify(chatBody(10)).padEnd(bytes);

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
  let isClosed = false;
  const closed = new Promise<void>((resolve) =>
    socket.on('close', () => {
      isClosed = true;
      resolve();
    }),
  );
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
  return { socket, closed, replied, text: () => reply, isClosed: () => isClosed };
}

const openJson = (port: number, length: number, path = '/v1/chat/completions') =>
  open(port, path, ['Content-Type: application/json', `Content-Length: ${length}`]);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Opens a body, sends all of it but the last byte, and lets the server read it. */
async function openUnfinished(port: number, body: string, path?: string) {
  const upload = openJson(port, body.length, path);
  upload.socket.write(body.slice(0, -1));
  await wait(60);
  return { ...upload, finish: () => upload.socket.write(body.slice(-1)) };
}

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

    await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer key')
      .send(chatBody(10))
      .expect(200);

    expect(authenticate).not.toHaveBeenCalled();
  });

  it.each([
    ['refused', refuseWith401],
    ['unchecked after a failure', async () => Promise.reject(new Error('database down'))],
  ])('leaves a mid-sized body with a key that is %s to the route guard', async (_l, check) => {
    const { app, failed } = createApp({ authenticate: check });

    await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer key')
      .send(chatBody(100 * 1024))
      .expect(200);

    expect(failed).not.toHaveBeenCalled();
  });

  // Answering mid-upload resets a closing client before it hears why.
  it('refuses a caller only after taking its body, and never routes it', async () => {
    const { app, handled } = createApp({ authenticate: refuseWith401 });
    const port = await listen(app);
    const body = padded(8 * MB);

    const upload = openJson(port, body.length);
    upload.socket.write(body);

    expect(await upload.replied).toContain('401');
    expect(handled).not.toHaveBeenCalled();
  });

  it('gives up on a refused body that stops arriving', async () => {
    const { app } = createApp({ authenticate: refuseWith401, idleTimeoutMs: 100 });
    const port = await listen(app);

    const upload = openJson(port, 2 * MB);

    expect(await upload.replied).toContain('408');
  });

  it('stops quietly when the caller leaves during authentication', async () => {
    let release: (value: null) => void = () => undefined;
    let gone: Promise<unknown> = Promise.resolve();
    const authenticate = jest.fn((_req: Request, res: Response) => {
      gone = once(res, 'close');
      return new Promise<null>((resolve) => (release = resolve));
    });
    const { app, handled, failed } = createApp({ authenticate });
    const port = await listen(app);

    const upload = openJson(port, 2 * MB);
    await wait(50);
    upload.socket.destroy();
    await gone;
    release(null);
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
    const authenticate: ProxyBodyOptions['authenticate'] = async (req, res) =>
      req.headers.authorization ? null : refuseWith401(req, res);
    const { app } = createApp({ authenticate, inFlightLimitBytes: 4 * MB });
    const port = await listen(app);

    openJson(port, 4 * MB);
    await wait(50);

    await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer key')
      .send(chatBody(2 * MB))
      .expect(200);
  });

  it('holds a large body size in the budget until its response ends', async () => {
    const { app, handled } = createApp({ inFlightLimitBytes: 4 * MB });
    const port = await listen(app);
    const body = padded(3 * MB);

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
    const middleware = createProxyBodyMiddleware({ watch: jest.fn(), authenticate });
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
    const { app, handled } = createApp({ authenticate: refuseWith401 });
    const port = await listen(app);

    const download = open(port, '/v1/models', [`Content-Length: ${2 * MB}`], 'GET');
    download.socket.write('x'.repeat(2 * MB));

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
    const middleware = createProxyBodyMiddleware({ watch: jest.fn(), authenticate: allow });
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

describe('body watcher', () => {
  const body = padded(900 * 1024);
  const authPath = '/api/auth/update-user';

  it('drops the quietest body when together they hold too much, on any route', async () => {
    const { app, handled, failed } = createApp({ maxBytes: 1.5 * MB });
    const port = await listen(app);

    const oldest = await openUnfinished(port, body, authPath);
    const newcomer = await openUnfinished(port, body, '/api/v1/test');

    expect(await oldest.replied).toContain('408');
    await oldest.closed;
    expect(oldest.text()).toContain('Too many unfinished request bodies');
    newcomer.finish();
    expect(await newcomer.replied).toContain('200');
    expect(handled).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
  });

  it('spares a body that is still arriving over one that went quiet', async () => {
    const { app } = createApp({ maxBytes: 1.5 * MB });
    const port = await listen(app);
    const small = padded(300 * 1024);

    const active = openJson(port, body.length);
    active.socket.write(body.slice(0, 100 * 1024));
    await wait(60);
    const quiet = await openUnfinished(port, body);
    // The older body speaks again, so the other one is now the quietest.
    active.socket.write(body.slice(100 * 1024, 700 * 1024));
    await wait(60);
    const newcomer = await openUnfinished(port, small);

    expect(await quiet.replied).toContain('408');
    active.socket.write(body.slice(700 * 1024));
    expect(await active.replied).toContain('200');
    newcomer.finish();
    expect(await newcomer.replied).toContain('200');
  });

  const keyOnly: ProxyBodyOptions['authenticate'] = async (req, res) =>
    req.headers.authorization === 'Bearer good' ? null : refuseWith401(req, res);
  const openWithKey = (port: number, content: string, key: string) => {
    const upload = open(port, '/v1/chat/completions', [
      'Content-Type: application/json',
      `Content-Length: ${content.length}`,
      `Authorization: Bearer ${key}`,
    ]);
    upload.socket.write(content.slice(0, -1));
    return { ...upload, finish: () => upload.socket.write(content.slice(-1)) };
  };

  it('drops the body of a valid key only after all the others', async () => {
    const { app } = createApp({ authenticate: keyOnly, maxBytes: 1.5 * MB });
    const port = await listen(app);
    const part = padded(600 * 1024);

    // The oldest and quietest of all, but vouched for.
    const keyed = openWithKey(port, part, 'good');
    await wait(60);
    const forged = openWithKey(port, part, 'forged');
    await wait(60);
    const anonymous = await openUnfinished(port, part);

    expect(await forged.replied).toContain('408');
    keyed.finish();
    anonymous.finish();
    expect(await keyed.replied).toContain('200');
    expect(await anonymous.replied).toContain('200');
  });

  it('still bounds bodies when every one of them has a key', async () => {
    const { app } = createApp({ authenticate: keyOnly, maxBytes: 1.5 * MB });
    const port = await listen(app);

    const first = openWithKey(port, body, 'good');
    await wait(60);
    openWithKey(port, body, 'good');

    expect(await first.replied).toContain('408');
  });

  it('caps how many bodies may be unfinished, even ones that sent nothing', async () => {
    const { app } = createApp({ maxBodies: 2 });
    const port = await listen(app);

    const first = openJson(port, 100);
    await wait(30);
    const second = openJson(port, 100);
    await wait(30);
    const third = openJson(port, 100, '/api/v1/test');

    expect(await first.replied).toContain('408');
    await wait(30);
    expect(second.isClosed()).toBe(false);
    expect(third.isClosed()).toBe(false);
  });

  it('leaves bodies holding nothing alone when only memory is short', async () => {
    const { app } = createApp({ maxBytes: 1.5 * MB });
    const port = await listen(app);

    const empty = openJson(port, 100);
    await wait(30);
    const oldest = await openUnfinished(port, body);
    await openUnfinished(port, body);

    expect(await oldest.replied).toContain('408');
    expect(empty.isClosed()).toBe(false);
  });

  it('never drops the only body for its own size', async () => {
    const { app } = createApp({ maxBytes: 1024 });

    await request(app)
      .post('/v1/chat/completions')
      .send(chatBody(500 * 1024))
      .expect(200);
  });

  // The parser keeps a string piece per chunk, so many tiny chunks cost memory.
  it('charges every chunk more than its length', async () => {
    const { app } = createApp({ maxBytes: 1200 });
    const port = await listen(app);

    const dribble = openJson(port, 100);
    for (let i = 0; i < 20; i++) {
      dribble.socket.write(' ');
      await wait(10);
    }
    const newcomer = openJson(port, 100);
    newcomer.socket.write(' ');

    expect(await dribble.replied).toContain('408');
  });

  it('keeps large keyed bodies out of the pressure, as their budget counts them', async () => {
    const { app } = createApp({ maxBodies: 1, maxBytes: 1024 });
    const port = await listen(app);
    const large = padded(2 * MB);

    const keyed = await openUnfinished(port, large);
    const first = openJson(port, 100);
    await wait(30);
    openJson(port, 100);

    expect(await first.replied).toContain('408');
    keyed.finish();
    expect(await keyed.replied).toContain('200');
  });

  it('does not count bytes it throws away', async () => {
    const { app } = createApp({ authenticate: refuseWith401, maxBytes: 1.5 * MB });
    const port = await listen(app);

    const kept = await openUnfinished(port, body);
    const refused = await openUnfinished(port, padded(4 * MB));

    kept.finish();
    expect(await kept.replied).toContain('200');
    refused.finish();
    expect(await refused.replied).toContain('401');
  });

  it('times out small bodies on every route', async () => {
    const { app, handled } = createApp({ idleTimeoutMs: 100 });
    const port = await listen(app);

    for (const path of ['/v1/chat/completions', '/api/v1/test', authPath]) {
      const stalled = openJson(port, 100, path);
      expect(await stalled.replied).toContain('408');
      expect(stalled.text()).toContain('Timed out waiting for the request body');
    }
    expect(handled).not.toHaveBeenCalled();
  });

  it('keeps a slow body that is still arriving', async () => {
    const { app } = createApp({ idleTimeoutMs: 300 });
    const port = await listen(app);
    const slowBody = JSON.stringify(chatBody(10));

    const slow = openJson(port, slowBody.length);
    for (const part of slowBody.match(/.{1,9}/g) as string[]) {
      slow.socket.write(part);
      await wait(80);
    }

    expect(await slow.replied).toContain('200');
  });

  it('hangs up on a body that stalls after its response', async () => {
    const { app } = createApp({ idleTimeoutMs: 100 });
    const port = await listen(app);

    const limited = openJson(port, 5000, '/api/v1/limited');

    expect(await limited.replied).toContain('429');
    await limited.closed;
  });

  it('counts a body still arriving after its response', async () => {
    const { app } = createApp({ maxBodies: 1 });
    const port = await listen(app);
    // Keep the answered connection open, as a keep-alive client would.
    const answered = connect(port, '127.0.0.1');
    sockets.push(answered);
    answered.on('error', () => undefined);
    const closed = once(answered, 'close');
    answered.write('POST /api/v1/limited HTTP/1.1\r\nHost: x\r\nContent-Length: 5000\r\n\r\n');
    await once(answered, 'data');

    openJson(port, 100);

    await closed;
  });

  // An answered request is never told its connection closed, only its socket is.
  it('forgets a body when its connection closes', async () => {
    const watch = createBodyWatcher({ idleTimeoutMs: 20 });
    const socket = new EventEmitter();
    const req = Object.assign(new Readable({ read: () => undefined }), {
      headers: { 'content-length': '5' },
      socket,
    }) as unknown as express.Request;
    const res = createMockResponse();

    watch(req, res);
    socket.emit('close');
    await wait(60);

    expect(res.status).not.toHaveBeenCalled();
    expect(req.destroyed).toBe(false);
    expect(socket.listenerCount('close')).toBe(0);
  });

  it('leaves a body that has fully arrived to its handler', async () => {
    const { app } = createApp({ idleTimeoutMs: 100, maxBodies: 1 });
    const port = await listen(app);

    // Nothing reads a text body, so only its arrival tells it apart from a stall.
    const waiting = open(port, '/api/v1/slow', ['Content-Type: text/plain', 'Content-Length: 2']);
    waiting.socket.write('hi');
    await wait(30);
    openJson(port, 100);

    expect(await waiting.replied).toContain('200');
  });
});

describe('API body middleware', () => {
  it('parses JSON and form bodies', async () => {
    const { app } = createApp();

    await request(app).post('/api/v1/echo').send({ a: 1 }).expect(200, { a: 1 });
    await request(app)
      .post('/api/v1/echo')
      .type('form')
      .send('a[b]=2')
      .expect(200, { a: { b: '2' } });
  });

  it('answers malformed JSON with a 400', async () => {
    const { app } = createApp();

    await request(app)
      .post('/api/v1/echo')
      .set('Content-Type', 'application/json')
      .send('{')
      .expect(400);
  });

  it.each(['application/json', 'application/x-www-form-urlencoded'])(
    'refuses compressed %s bodies, whose size on the wire hides their size in memory',
    async (type) => {
      const { app } = createApp();

      await request(app)
        .post('/api/v1/echo')
        .set('Content-Type', type)
        .set('Content-Encoding', 'gzip')
        .serialize((body) => body as string)
        .send(gzipSync('{}') as unknown as string)
        .expect(415);
    },
  );

  it('refuses a chunked body that grows past the limit', async () => {
    const { app, handled } = createApp();
    const port = await listen(app);

    const upload = open(port, '/api/v1/test', [
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

  it('drops a chunked body that stops arriving', async () => {
    const { app, handled, failed } = createApp({ idleTimeoutMs: 100 });
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
