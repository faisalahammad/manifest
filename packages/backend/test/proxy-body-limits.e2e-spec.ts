import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, mountProductionBodyParsers, TEST_OTLP_KEY } from './helpers';

const LARGE = 'x'.repeat(2 * 1024 * 1024);
const body = { model: 'auto', messages: [{ role: 'user', content: LARGE }] };

// Real guard, real exception filter, real database: only the size differs from
// an ordinary proxy call.
describe('Proxy body limits (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp({ configureApp: mountProductionBodyParsers });
  }, 30000);

  afterAll(async () => {
    await app?.close();
  });

  const post = () => request(app.getHttpServer()).post('/v1/chat/completions');

  it('reads a large body for a valid harness key', async () => {
    const res = await post().set('authorization', `Bearer ${TEST_OTLP_KEY}`).send(body);

    // The harness has no model, so TierGate says so after routing the parsed body.
    expect(res.status).toBe(200);
    expect(res.text).toContain('M101');
  });

  it.each([
    ['no key', undefined, 'M001'],
    ['an unknown key', 'Bearer mnfst_unknownunknownunknown', 'M005'],
  ])('refuses a large body with %s before parsing it', async (_label, authorization, code) => {
    const req = post();
    if (authorization) void req.set('authorization', authorization);

    const res = await req.send(body).expect(401);

    expect(res.body.error.code).toBe('manifest_auth');
    expect(res.body.error.message).toContain(code);
  });

  it('refuses a compressed body', async () => {
    await post()
      .set('authorization', `Bearer ${TEST_OTLP_KEY}`)
      .set('content-type', 'application/json')
      .set('content-encoding', 'gzip')
      .send('{}')
      .expect(415);
  });
});
