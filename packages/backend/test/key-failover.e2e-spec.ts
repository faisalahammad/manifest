/**
 * Key failover through the real proxy: a custom provider with two keys, served
 * by a local mock upstream that answers per key. Covers rotation on a
 * key-scoped failure, the cursor, a request-scoped failure that must not
 * rotate, a pinned route, the status endpoint and a manual reset.
 */
import { INestApplication } from '@nestjs/common';
import * as http from 'http';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp, TEST_API_KEY } from './helpers';

let mockServer: http.Server;
let mockPort: number;
/** Keys the upstream saw, in call order. */
const calls: string[] = [];
/** Status each key answers with; a key not listed answers 200. */
const keyStatus = new Map<string, number>();

function startMockServer(): Promise<void> {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        const key = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
        calls.push(key);
        const status = keyStatus.get(key) ?? 200;
        const model = (JSON.parse(raw) as { model: string }).model;
        const body =
          status === 200
            ? {
                id: 'chatcmpl-mock',
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: 'OK' },
                    finish_reason: 'stop',
                  },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
              }
            : { error: { message: `mock failure ${status}`, type: 'mock' } };
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    mockServer.listen(0, '127.0.0.1', () => {
      mockPort = (mockServer.address() as { port: number }).port;
      resolve();
    });
  });
}

let app: INestApplication;
let ds: DataSource;
let agentName: string;
let agentId: string;
let agentKey: string;
let provider: string;
let model: string;

const api = () => request(app.getHttpServer());
const auth = (r: request.Test) => r.set('x-api-key', TEST_API_KEY);

function chat() {
  return api()
    .post('/v1/chat/completions')
    .set('Authorization', `Bearer ${agentKey}`)
    .send({ messages: [{ role: 'user', content: 'hello' }], stream: false });
}

interface AttemptRow {
  status: string;
  key_failover_index: number | null;
  error_http_status: number | null;
  fallback_from_model: string | null;
}

/** Attempts of the agent's newest request, in the order they were made. */
async function lastRequestAttempts(expected: number): Promise<AttemptRow[]> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const rows: AttemptRow[] = await ds.query(
      `SELECT status, key_failover_index, error_http_status, fallback_from_model
         FROM agent_messages
        WHERE request_id = (
          SELECT request_id FROM agent_messages WHERE agent_id = $1
           ORDER BY timestamp DESC LIMIT 1)
        ORDER BY COALESCE(key_failover_index, 0)`,
      [agentId],
    );
    const settled = rows.every((r) => r.status !== 'pending');
    if ((rows.length >= expected && settled) || Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function pinDefault(keyLabel?: string) {
  await auth(api().put(`/api/v1/routing/${agentName}/tiers/default`))
    .send(keyLabel ? { model, providerKeyLabel: keyLabel } : { model })
    .expect(200);
}

beforeAll(async () => {
  await startMockServer();
  app = await createTestApp();
  ds = app.get(DataSource);

  const created = await auth(api().post('/api/v1/agents'))
    .send({ name: 'Failover Agent' })
    .expect(201);
  agentName = created.body.agent.name;
  agentKey = created.body.apiKey;
  agentId = (await ds.query(`SELECT id FROM agents WHERE name = $1`, [agentName]))[0].id;

  const custom = await auth(api().post(`/api/v1/routing/${agentName}/custom-providers`))
    .send({
      name: 'Failover Mock',
      base_url: `http://127.0.0.1:${mockPort}`,
      apiKey: 'key-one',
      models: [
        {
          model_name: 'mock-model',
          input_price_per_million_tokens: 0.1,
          output_price_per_million_tokens: 0.1,
        },
      ],
    })
    .expect(201);
  provider = `custom:${custom.body.id}`;
  model = `${provider}/mock-model`;

  await auth(api().post(`/api/v1/routing/${agentName}/providers`))
    .send({ provider, apiKey: 'key-two', label: 'Backup' })
    .expect(201);

  await pinDefault();
}, 30_000);

afterAll(async () => {
  await app.close();
  mockServer.close();
});

beforeEach(() => {
  calls.length = 0;
  keyStatus.clear();
});

describe('Key failover through the proxy', () => {
  it('moves to the next key when the first one fails with a 5xx', async () => {
    keyStatus.set('key-one', 500);

    const res = await chat().expect(200);

    expect(res.body.choices[0].message.content).toBe('OK');
    expect(calls).toEqual(['key-one', 'key-two']);
    const rows = await lastRequestAttempts(2);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ error_http_status: 500, key_failover_index: null });
    expect(rows[0].status).not.toBe('success');
    expect(rows[1]).toMatchObject({
      status: 'success',
      key_failover_index: 1,
      fallback_from_model: null,
    });
  });

  it('starts the next request from the key that worked', async () => {
    keyStatus.set('key-one', 500);

    await chat().expect(200);

    expect(calls).toEqual(['key-two']);
  });

  it('reports the last served key and the last failure without key material', async () => {
    const res = await auth(
      api().get(`/api/v1/routing/${agentName}/providers/${provider}/keys/status?authType=api_key`),
    ).expect(200);

    type KeyStatus = {
      label: string;
      last_served: boolean;
      last_failure: { http_status: number } | null;
    };
    const byLabel = Object.fromEntries((res.body.keys as KeyStatus[]).map((k) => [k.label, k]));
    expect(byLabel.Backup.last_served).toBe(true);
    expect(byLabel.Default.last_failure?.http_status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/key-one|key-two/);
  });

  it('a manual reset starts the next request from the first key again', async () => {
    await auth(api().post(`/api/v1/routing/${agentName}/providers/${provider}/keys/reset-rotation`))
      .send({ authType: 'api_key' })
      .expect(201);

    await chat().expect(200);

    expect(calls).toEqual(['key-one']);
  });

  it('does not rotate on a request-scoped 400', async () => {
    keyStatus.set('key-one', 400);

    await chat().expect(400);

    expect(calls).toEqual(['key-one']);
  });

  it('a pinned route uses its key only', async () => {
    await pinDefault('Default');
    keyStatus.set('key-one', 500);

    const res = await chat();

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(calls).toEqual(['key-one']);
    await pinDefault();
  });

  it('fails over on a request that names the model explicitly', async () => {
    await auth(api().post(`/api/v1/routing/${agentName}/providers/${provider}/keys/reset-rotation`))
      .send({ authType: 'api_key' })
      .expect(201);
    keyStatus.set('key-one', 502);

    await api()
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${agentKey}`)
      .send({ model, messages: [{ role: 'user', content: 'hello' }], stream: false })
      .expect(200);

    expect(calls).toEqual(['key-one', 'key-two']);
  });

  it('returns the last failure when every key fails', async () => {
    keyStatus.set('key-one', 503);
    keyStatus.set('key-two', 503);

    const res = await chat();

    expect(res.status).toBe(503);
    // Each key once; the order follows the cursor the previous test left.
    expect([...calls].sort()).toEqual(['key-one', 'key-two']);
  });
});
