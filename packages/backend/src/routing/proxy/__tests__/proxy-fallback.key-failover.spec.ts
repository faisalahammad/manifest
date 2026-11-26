import { Repository } from 'typeorm';
import type { AuthType } from 'manifest-shared';
import {
  ProxyFallbackService,
  type HopForwardOptions,
  type KeyFailoverContext,
} from '../proxy-fallback.service';
import { ReasoningContentCache } from '../reasoning-content-cache';
import { ProviderKeyService } from '../../routing-core/provider-key.service';
import { KeyRotationService } from '../../routing-core/key-rotation.service';
import { CustomProvider } from '../../../entities/custom-provider.entity';
import { OpenaiOauthService } from '../../oauth/openai/openai-oauth.service';
import { MinimaxOauthService } from '../../oauth/minimax/minimax-oauth.service';
import { AnthropicOauthService } from '../../oauth/anthropic/anthropic-oauth.service';
import { GeminiOauthService } from '../../oauth/gemini/gemini-oauth.service';
import { KiroOauthService } from '../../oauth/kiro/kiro-oauth.service';
import { XaiOauthService } from '../../oauth/xai/xai-oauth.service';
import { ProviderClient } from '../provider-client';
import { CopilotTokenService } from '../copilot-token.service';
import { ModelPricingCacheService } from '../../../model-prices/model-pricing-cache.service';
import { AgentModelParamsService } from '../../routing-core/agent-model-params.service';
import { ProviderParamSpecService } from '../../routing-core/provider-param-spec.service';
import { AutofixService } from '../../autofix/autofix.service';
import type {
  ProviderAttemptRef,
  ProviderAttemptStart,
  StartProviderAttempt,
} from '../proxy-types';

jest.mock('../oauth-credentials', () => {
  const actual = jest.requireActual('../oauth-credentials');
  return {
    ...actual,
    // A secret named "unusable" stands for a subscription blob that cannot be
    // unwrapped (M102); every other secret passes through unchanged.
    resolveApiKey: jest.fn(async (_provider: string, apiKey: string) => ({
      apiKey: apiKey.startsWith('unusable') ? null : apiKey,
    })),
    refreshRejectedOAuthCredential: jest.fn().mockResolvedValue(null),
  };
});

import { refreshRejectedOAuthCredential } from '../oauth-credentials';
const mockedRefresh = refreshRejectedOAuthCredential as jest.MockedFunction<
  typeof refreshRejectedOAuthCredential
>;

interface Key {
  id: string;
  label: string;
  priority: number;
  apiKey: string;
  region: null;
}

const key = (label: string, priority: number, apiKey = `key-${label}`): Key => ({
  id: `id-${label}`,
  label,
  priority,
  apiKey,
  region: null,
});

type Responder = Response | (() => Response);

const emptyStream = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    { status: 200 },
  );

const dataStream = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {}\n\n'));
        controller.close();
      },
    }),
    { status: 200 },
  );

describe('ProxyFallbackService.forwardHop: key failover', () => {
  let service: ProxyFallbackService;
  let keyRotation: KeyRotationService;
  let providerClient: jest.Mocked<ProviderClient>;
  let keys: Key[];
  let responses: Record<string, Responder[]>;
  let starts: ProviderAttemptStart[];
  let attempts: (ProviderAttemptRef & { completeFailure: jest.Mock })[];
  let startProviderAttempt: StartProviderAttempt;

  const respond = (apiKey: string, ...list: Responder[]) => {
    responses[apiKey] = list;
  };
  const status = (code: number, headers?: Record<string, string>) => () =>
    new Response(JSON.stringify({ error: { message: `status ${code}` } }), {
      status: code,
      headers,
    });
  const calledKeys = () => providerClient.forward.mock.calls.map(([opts]) => opts.apiKey);
  const failover = (overrides: Partial<KeyFailoverContext> = {}): KeyFailoverContext => ({
    deadlineAt: Date.now() + 60_000,
    deadKeyIds: new Set(),
    ...overrides,
  });

  const forward = (overrides: Partial<HopForwardOptions> = {}): HopForwardOptions => ({
    agentId: 'agent-1',
    tenantId: 'tenant-1',
    model: 'gpt-4o',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    stream: false,
    sessionKey: 'sess',
    startProviderAttempt,
    ...overrides,
  });

  const hop = (
    opts: {
      keyLabel?: string;
      authType?: AuthType;
      stream?: boolean;
      model?: string;
      keyFailover?: KeyFailoverContext;
    } = {},
  ) =>
    service.forwardHop({
      route: { provider: 'openai', authType: opts.authType ?? 'api_key', keyLabel: opts.keyLabel },
      forward: forward({
        stream: opts.stream ?? false,
        model: opts.model ?? 'gpt-4o',
      }),
      keyFailover: opts.keyFailover ?? failover(),
      credentialDashboardUrl: 'https://dash/routing',
    });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedRefresh.mockResolvedValue(null);
    keys = [key('A', 0), key('B', 1), key('C', 2)];
    responses = {};
    starts = [];
    attempts = [];
    startProviderAttempt = (start) => {
      starts.push(start);
      const attempt = {
        id: `att-${starts.length}`,
        attemptNumber: starts.length,
        startedAtMs: Date.now(),
        startedAt: new Date().toISOString(),
        pendingWrite: Promise.resolve(true),
        completeFailure: jest.fn().mockResolvedValue(undefined),
        finishRecording: jest.fn().mockResolvedValue(undefined),
      };
      attempts.push(attempt);
      return attempt;
    };

    const providerKeyService = {
      getProviderKeys: jest.fn(async () => keys),
      selectProviderKey: jest.fn(
        async (_t: string, _p: string, _a: string, label?: string) =>
          keys.find((k) => k.label.toLowerCase() === label?.toLowerCase()) ?? keys[0] ?? null,
      ),
      getProviderApiKey: jest.fn(),
    } as unknown as ProviderKeyService;

    providerClient = {
      forward: jest.fn(async (opts: { apiKey: string }) => {
        const queue = responses[opts.apiKey] ?? [];
        const next = queue.length > 1 ? queue.shift()! : (queue[0] ?? dataStream);
        return {
          response: typeof next === 'function' ? next() : next,
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        };
      }),
    } as unknown as jest.Mocked<ProviderClient>;

    const oauthStub = { unwrapToken: jest.fn().mockResolvedValue(null) };
    keyRotation = new KeyRotationService();
    service = new ProxyFallbackService(
      providerKeyService,
      { findOne: jest.fn().mockResolvedValue(null) } as unknown as Repository<CustomProvider>,
      oauthStub as unknown as OpenaiOauthService,
      oauthStub as unknown as MinimaxOauthService,
      oauthStub as unknown as AnthropicOauthService,
      oauthStub as unknown as GeminiOauthService,
      oauthStub as unknown as KiroOauthService,
      oauthStub as unknown as XaiOauthService,
      providerClient,
      { getCopilotToken: jest.fn() } as unknown as CopilotTokenService,
      { getByModel: jest.fn().mockReturnValue(null) } as unknown as ModelPricingCacheService,
      { get: jest.fn().mockResolvedValue(null) } as unknown as AgentModelParamsService,
      { getSpecs: jest.fn().mockResolvedValue([]) } as unknown as ProviderParamSpecService,
      new ReasoningContentCache(),
      { isRepairable: jest.fn().mockReturnValue(false) } as unknown as AutofixService,
      keyRotation,
    );
  });

  it('A fails, B serves, and the next request starts at B', async () => {
    respond('key-A', status(503));
    respond('key-B', status(200));

    const first = await hop();
    expect(first.ok && first.forward.response.status).toBe(200);
    expect(first.ok && first.credentials.keyLabel).toBe('B');
    expect(calledKeys()).toEqual(['key-A', 'key-B']);
    // A is a superseded attempt; B is the second key of the hop.
    expect(attempts[0].completeFailure).toHaveBeenCalledWith(
      expect.objectContaining({ status: 503, superseded: true }),
    );
    expect(starts.map((s) => [s.keyLabel, s.keyFailoverIndex])).toEqual([
      ['A', undefined],
      ['B', 1],
    ]);

    providerClient.forward.mockClear();
    await hop();
    expect(calledKeys()).toEqual(['key-B']);
  });

  it('wraps from the last key back to the first', async () => {
    keyRotation.recordSuccess(
      { tenantId: 'tenant-1', agentId: 'agent-1', provider: 'openai', authType: 'api_key' },
      'id-C',
    );
    respond('key-C', status(500));
    respond('key-A', status(200));

    const result = await hop();
    expect(calledKeys()).toEqual(['key-C', 'key-A']);
    expect(result.ok && result.credentials.keyLabel).toBe('A');
  });

  it('returns the last failure when every key fails, then resets the cursor', async () => {
    keyRotation.recordSuccess(
      { tenantId: 'tenant-1', agentId: 'agent-1', provider: 'openai', authType: 'api_key' },
      'id-B',
    );
    for (const k of keys) respond(k.apiKey, status(529));

    const result = await hop();
    expect(calledKeys()).toEqual(['key-B', 'key-C', 'key-A']);
    expect(result.ok && result.forward.response.status).toBe(529);
    // The returned failure is fresh and readable: the hop read the original.
    expect(result.ok && (await result.forward.response.text())).toContain('status 529');
    // The last key is not superseded: the caller records it like any failed hop.
    expect(attempts.map((a) => a.completeFailure.mock.calls.length)).toEqual([1, 1, 0]);

    providerClient.forward.mockClear();
    await hop();
    expect(calledKeys()[0]).toBe('key-A');
  });

  it('moves to the next fallback only after every key of the hop failed', async () => {
    for (const k of keys) respond(k.apiKey, status(503));
    respond('key-other', status(200));
    const providerKeys = service['providerKeyService'] as unknown as {
      getProviderKeys: jest.Mock;
      selectProviderKey: jest.Mock;
    };
    providerKeys.getProviderKeys.mockImplementation(async (_t: string, provider: string) =>
      provider === 'openai' ? keys : [],
    );
    providerKeys.selectProviderKey.mockImplementation(
      async (_t: string, provider: string, _a: string, label?: string) =>
        provider === 'openai'
          ? (keys.find((k) => k.label === label) ?? keys[0])
          : key('Other', 0, 'key-other'),
    );

    const result = await service.tryFallbacks(
      'agent-1',
      'tenant-1',
      ['gpt-4o', 'claude-sonnet'],
      { messages: [] },
      false,
      'sess',
      'gpt-primary',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'chat_completions',
      undefined,
      [
        { provider: 'openai', authType: 'api_key', model: 'gpt-4o' },
        { provider: 'anthropic', authType: 'api_key', model: 'claude-sonnet' },
      ],
      undefined,
      startProviderAttempt,
      undefined,
      undefined,
      undefined,
      undefined,
      failover(),
    );

    expect(calledKeys()).toEqual(['key-A', 'key-B', 'key-C', 'key-other']);
    expect(result.success?.fallbackIndex).toBe(1);
    // One failed hop for the caller to record; the first two keys were superseded in place.
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].keyLabel).toBe('C');
  });

  it('keeps a pinned route strict', async () => {
    respond('key-A', status(503));
    const result = await hop({ keyLabel: 'A' });
    expect(calledKeys()).toEqual(['key-A']);
    expect(result.ok && result.forward.response.status).toBe(503);
  });

  it('does not rotate on a request-scoped failure', async () => {
    respond('key-A', status(400));
    const result = await hop();
    expect(calledKeys()).toEqual(['key-A']);
    expect(result.ok && result.forward.response.status).toBe(400);
  });

  it('advances the cursor once when concurrent requests fail on the same key', async () => {
    respond('key-A', status(503));
    respond('key-B', status(400));
    await Promise.all([hop(), hop()]);
    providerClient.forward.mockClear();
    await hop();
    expect(calledKeys()[0]).toBe('key-B');
  });

  it('rotates when a stream dies before its first byte', async () => {
    respond('key-A', emptyStream);
    respond('key-B', dataStream);
    const result = await hop({ stream: true });
    expect(calledKeys()).toEqual(['key-A', 'key-B']);
    expect(result.ok && result.forward.response.status).toBe(200);
    expect(attempts[0].completeFailure).toHaveBeenCalledWith(
      expect.objectContaining({ status: 502, superseded: true }),
    );
  });

  it('skips a key still cooling down after a 429, without a call or an attempt', async () => {
    keys = [key('A', 0), key('B', 1)];
    respond('key-A', status(429, { 'retry-after': '60' }));
    respond('key-B', status(200), status(503));
    await hop(); // A 429 (cooled), B serves

    providerClient.forward.mockClear();
    starts.length = 0;
    const result = await hop(); // starts at B, which now fails; A is cooled
    expect(calledKeys()).toEqual(['key-B']);
    expect(starts.map((s) => s.keyLabel)).toEqual(['B']);
    expect(result.ok && result.forward.response.status).toBe(503);
  });

  it('keeps the local-skip answer when every key is cooling down', async () => {
    keys = [key('A', 0), key('B', 1)];
    respond('key-A', status(429, { 'retry-after': '60' }));
    respond('key-B', status(429, { 'retry-after': '60' }));
    await hop();

    providerClient.forward.mockClear();
    starts.length = 0;
    const result = await hop();
    expect(providerClient.forward).not.toHaveBeenCalled();
    expect(result.ok && result.forward.providerCallStarted).toBe(false);
    expect(result.ok && result.forward.response.status).toBe(429);
    expect(starts).toEqual([expect.objectContaining({ providerCallStarted: false })]);
  });

  it('skips a key a provider rejected with a 401 on the next request', async () => {
    keys = [key('A', 0), key('B', 1)];
    respond('key-A', status(401));
    respond('key-B', status(200));
    await hop();
    // Back to the first key, with a fresh failover context: A is still skipped
    // by the 401 cooldown, and a reset for another agent does not clear it.
    keyRotation.reset({
      tenantId: 'other',
      agentId: 'other',
      provider: 'openai',
      authType: 'api_key',
    });
    keyRotation['cursors'].clear();
    providerClient.forward.mockClear();
    await hop();
    expect(calledKeys()).toEqual(['key-B']);
  });

  it('refreshes a rejected OAuth token before rotating', async () => {
    respond('key-A', status(401));
    respond('key-A-refreshed', status(200));
    mockedRefresh.mockResolvedValueOnce({ apiKey: 'key-A-refreshed' });

    const result = await hop({ authType: 'subscription' });
    expect(calledKeys()).toEqual(['key-A', 'key-A-refreshed']);
    expect(mockedRefresh).toHaveBeenCalledWith(
      'openai',
      'key-A',
      'agent-1',
      'tenant-1',
      'A',
      expect.anything(),
    );
    expect(result.ok && result.credentials.keyLabel).toBe('A');
  });

  it('rotates when the OAuth refresh cannot save the key', async () => {
    respond('key-A', status(401));
    respond('key-B', status(200));
    const result = await hop({ authType: 'subscription' });
    expect(mockedRefresh).toHaveBeenCalledTimes(1);
    expect(calledKeys()).toEqual(['key-A', 'key-B']);
    expect(result.ok && result.credentials.keyLabel).toBe('B');
  });

  it('records an unusable subscription key as a superseded attempt when another key serves', async () => {
    keys = [key('A', 0, 'unusable-A'), key('B', 1)];
    respond('key-B', status(200));
    const result = await hop({ authType: 'subscription' });
    expect(result.ok && result.credentials.keyLabel).toBe('B');
    expect(calledKeys()).toEqual(['key-B']);
    expect(starts.map((s) => [s.keyLabel, s.keyFailoverIndex])).toEqual([
      ['A', undefined],
      ['B', 1],
    ]);
    expect(attempts[0].completeFailure).toHaveBeenCalledWith(
      expect.objectContaining({ status: 401, superseded: true }),
    );
  });

  it('reports a credential failure with no attempt when every key is unusable', async () => {
    keys = [key('A', 0, 'unusable-A'), key('B', 1, 'unusable-B')];
    const result = await hop({ authType: 'subscription' });
    expect(result).toEqual({
      ok: false,
      reason: 'subscription_credentials_unusable',
      tenantProviderId: 'id-B',
      keyLabel: 'B',
    });
    expect(starts).toEqual([]);
    expect(providerClient.forward).not.toHaveBeenCalled();
  });

  it('turns an unusable key after a provider failure into a failed attempt', async () => {
    keys = [key('A', 0), key('B', 1, 'unusable-B'), key('C', 2)];
    respond('key-A', status(503));
    respond('key-C', status(200));
    const result = await hop({ authType: 'subscription' });
    expect(result.ok && result.credentials.keyLabel).toBe('C');
    expect(starts.map((s) => s.keyLabel)).toEqual(['A', 'B', 'C']);
    expect(attempts[0].completeFailure).toHaveBeenCalledWith(
      expect.objectContaining({ status: 503, superseded: true }),
    );
    expect(attempts[1].completeFailure).toHaveBeenCalledWith(
      expect.objectContaining({ status: 401, superseded: true }),
    );
  });

  it('returns an unusable last key as a failed M102 attempt after a provider failure', async () => {
    keys = [key('A', 0), key('B', 1, 'unusable-B')];
    respond('key-A', status(503));
    // No dashboard URL: the M102 text still names where to fix the key.
    const result = await service.forwardHop({
      route: { provider: 'openai', authType: 'subscription' },
      forward: forward(),
      keyFailover: failover(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.forward.response.status).toBe(401);
    expect(await result.forward.response.text()).toContain('M102');
    expect(result.credentials.keyLabel).toBe('B');
    expect(attempts[1].completeFailure).not.toHaveBeenCalled();
  });

  it('stops trying keys at the attempt cap without resetting the cursor', async () => {
    service['keyFailoverMaxAttempts' as keyof ProxyFallbackService] = 2 as never;
    for (const k of keys) respond(k.apiKey, status(503));
    await hop();
    expect(calledKeys()).toEqual(['key-A', 'key-B']);
    providerClient.forward.mockClear();
    await hop();
    expect(calledKeys()[0]).toBe('key-C');
  });

  it('starts no new key once the routing deadline is spent', async () => {
    for (const k of keys) respond(k.apiKey, status(503));
    const result = await hop({ keyFailover: failover({ deadlineAt: Date.now() - 1 }) });
    expect(calledKeys()).toEqual(['key-A']);
    expect(result.ok && result.forward.response.status).toBe(503);
  });

  it('starts no new fallback hop once the routing deadline is spent', async () => {
    const result = await service.tryFallbacks(
      'agent-1',
      'tenant-1',
      ['gpt-4o'],
      { messages: [] },
      false,
      'sess',
      'gpt-primary',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'chat_completions',
      undefined,
      [{ provider: 'openai', authType: 'api_key', model: 'gpt-4o' }],
      undefined,
      startProviderAttempt,
      undefined,
      undefined,
      undefined,
      undefined,
      failover({ deadlineAt: Date.now() - 1 }),
    );
    expect(providerClient.forward).not.toHaveBeenCalled();
    expect(result).toEqual({ success: null, failures: [] });
  });

  it('skips keys this request already found dead in a later hop', async () => {
    respond('key-A', status(402));
    respond('key-B', status(200));
    const shared = failover();
    await hop({ keyFailover: shared, model: 'gpt-4o' });
    keyRotation['cursors'].clear();
    providerClient.forward.mockClear();
    await hop({ keyFailover: shared, model: 'gpt-4o-mini' });
    expect(calledKeys()).toEqual(['key-B']);
  });

  it('a reset for another agent or auth type keeps this agent cooldown', async () => {
    keys = [key('A', 0), key('B', 1)];
    respond('key-A', status(429, { 'retry-after': '60' }));
    respond('key-B', status(200));
    await hop();
    for (const other of [
      { agentId: 'agent-2', authType: 'api_key' },
      { agentId: 'agent-1', authType: 'subscription' },
    ]) {
      keyRotation.reset({ tenantId: 'tenant-1', provider: 'openai', ...other });
    }
    keyRotation['cursors'].clear();
    providerClient.forward.mockClear();
    await hop();
    expect(calledKeys()).toEqual(['key-B']);
  });

  it('a manual reset forgets the cursor and the cooldowns of the provider', async () => {
    keys = [key('A', 0), key('B', 1)];
    respond('key-A', status(429, { 'retry-after': '60' }), status(200));
    respond('key-B', status(200));
    await hop(); // A cooled, cursor on B

    keyRotation.reset({
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      provider: 'OpenAI',
      authType: 'api_key',
    });
    providerClient.forward.mockClear();
    await hop();
    expect(calledKeys()).toEqual(['key-A']);
  });

  it('takes the single-key path when the provider has one key', async () => {
    keys = [key('A', 0)];
    respond('key-A', status(503));
    const result = await hop();
    expect(calledKeys()).toEqual(['key-A']);
    expect(result.ok && result.forward.response.status).toBe(503);
  });

  it('reports a missing key on the single-key path', async () => {
    keys = [];
    const result = await hop();
    expect(result).toEqual({
      ok: false,
      reason: 'no_provider_key',
      tenantProviderId: null,
      keyLabel: undefined,
    });
  });
});
