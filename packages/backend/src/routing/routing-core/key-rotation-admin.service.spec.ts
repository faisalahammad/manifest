import type { Repository } from 'typeorm';
import type { AgentMessage } from '../../entities/agent-message.entity';
import { KeyRotationAdminService } from './key-rotation-admin.service';
import { KeyRotationService } from './key-rotation.service';
import { SYNTHETIC_OLLAMA_PROVIDER_ID, type ProviderKeyService } from './provider-key.service';

const agent = { id: 'agent-1', tenant_id: 'tenant-1' };
const row = (id: string, label: string, priority: number) => ({
  id,
  label,
  priority,
  apiKey: `secret-${label}`,
  region: null,
});

describe('KeyRotationAdminService', () => {
  let keys: ReturnType<typeof row>[];
  let query: jest.Mock;
  let rotation: KeyRotationService;
  let svc: KeyRotationAdminService;

  beforeEach(() => {
    keys = [row('id-A', 'A', 0), row('id-B', 'B', 1), row('id-C', 'C', 2)];
    query = jest.fn().mockResolvedValue([]);
    rotation = new KeyRotationService();
    svc = new KeyRotationAdminService(
      { getProviderKeys: jest.fn(async () => keys) } as unknown as ProviderKeyService,
      rotation,
      { query } as unknown as Repository<AgentMessage>,
    );
  });

  it('reset sends the agent ring of the provider back to its first key', () => {
    const listener = jest.fn();
    rotation.addResetListener(listener);
    rotation.recordSuccess(
      { tenantId: 'tenant-1', agentId: 'agent-1', provider: 'openai', authType: 'api_key' },
      'id-C',
    );
    svc.reset(agent, 'openai', 'api_key');
    expect(listener).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      provider: 'openai',
      authType: 'api_key',
    });
    expect(
      rotation.currentKeyId(
        { tenantId: 'tenant-1', agentId: 'agent-1', provider: 'openai', authType: 'api_key' },
        keys,
      ),
    ).toBe('id-A');
  });

  it('reports the last served key and each key last failure from attempts', async () => {
    query
      .mockResolvedValueOnce([
        { id: 'id-A', at: '2026-11-26 09:00:00' },
        { id: 'id-B', at: '2026-11-26 10:00:00' },
      ])
      .mockResolvedValueOnce([
        {
          id: 'id-A',
          at: '2026-11-26 09:30:00',
          error_http_status: 429,
          error_class: 'rate_limit',
          error_code: null,
        },
        {
          id: 'id-C',
          at: '2026-11-26 08:00:00',
          error_http_status: null,
          error_class: null,
          error_code: null,
        },
      ]);

    const status = await svc.getStatus(agent, 'openai', 'api_key');

    expect(status).toEqual({
      provider: 'openai',
      auth_type: 'api_key',
      keys: [
        {
          id: 'id-A',
          label: 'A',
          priority: 0,
          last_served: false,
          last_success_at: '2026-11-26 09:00:00',
          last_failure: {
            at: '2026-11-26 09:30:00',
            http_status: 429,
            error_class: 'rate_limit',
            error_code: null,
          },
        },
        {
          id: 'id-B',
          label: 'B',
          priority: 1,
          last_served: true,
          last_success_at: '2026-11-26 10:00:00',
          last_failure: null,
        },
        {
          id: 'id-C',
          label: 'C',
          priority: 2,
          last_served: false,
          last_success_at: null,
          last_failure: {
            at: '2026-11-26 08:00:00',
            http_status: null,
            error_class: null,
            error_code: null,
          },
        },
      ],
    });
    // Tenant and agent scoped, bounded window, only this provider's key ids.
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('WHERE tenant_id = $1');
    expect(sql).toContain('AND agent_id = $2');
    expect(params).toEqual(['tenant-1', 'agent-1', expect.any(String), ['id-A', 'id-B', 'id-C']]);
    // No key material leaves the service.
    expect(JSON.stringify(status)).not.toContain('secret-');
  });

  it('skips the attempt queries when there is no persisted key', async () => {
    keys = [
      { id: SYNTHETIC_OLLAMA_PROVIDER_ID, label: 'Default', priority: 0, apiKey: '', region: null },
    ];
    const status = await svc.getStatus(agent, 'ollama', 'local');
    expect(query).not.toHaveBeenCalled();
    expect(status.keys).toEqual([
      expect.objectContaining({ label: 'Default', last_served: false, last_failure: null }),
    ]);
  });
});
