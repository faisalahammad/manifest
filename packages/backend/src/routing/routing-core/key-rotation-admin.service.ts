import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { AuthType } from 'manifest-shared';
import { AgentMessage } from '../../entities/agent-message.entity';
import { computeCutoff } from '../../common/utils/postgres-sql';
import { sqlIsFailedStatus, sqlIsSuccessStatus } from '../../analytics/services/query-helpers';
import { ProviderKeyService, SYNTHETIC_OLLAMA_PROVIDER_ID } from './provider-key.service';
import { KeyRotationService } from './key-rotation.service';

/** How far back the key list looks for a key's last success and failure. */
export const KEY_STATUS_WINDOW = '7 days';

export interface KeyRotationAgent {
  id: string;
  tenant_id: string;
}

export interface KeyFailureSummary {
  at: string;
  http_status: number | null;
  error_class: string | null;
  error_code: string | null;
}

export interface KeyStatus {
  id: string;
  label: string;
  priority: number;
  /** True for the key whose call succeeded most recently: the one Auto routes stick to. */
  last_served: boolean;
  last_success_at: string | null;
  last_failure: KeyFailureSummary | null;
}

export interface KeyRotationStatus {
  provider: string;
  auth_type: AuthType;
  keys: KeyStatus[];
}

/**
 * Management side of key failover, shared by the REST API, the CLI and the
 * MCP tools.
 *
 * The key list reads from Provider Attempts (`agent_messages`), not from the
 * in-memory rotation cursor: every instance keeps its own cursor, while the
 * attempts are durable and the same for every instance and every reader.
 * Only labels, priorities, timestamps and error classifications are returned,
 * never key material.
 */
@Injectable()
export class KeyRotationAdminService {
  constructor(
    private readonly providerKeyService: ProviderKeyService,
    private readonly keyRotation: KeyRotationService,
    @InjectRepository(AgentMessage)
    private readonly messageRepo: Repository<AgentMessage>,
  ) {}

  /**
   * Start the provider's next Auto request from its first key again, and drop
   * the 429 and 401 cooldowns of its keys. Reaches the other instances through
   * the routing cache invalidation feed.
   */
  reset(agent: KeyRotationAgent, provider: string, authType: AuthType): void {
    this.keyRotation.reset({
      tenantId: agent.tenant_id,
      agentId: agent.id,
      provider,
      authType,
    });
  }

  async getStatus(
    agent: KeyRotationAgent,
    provider: string,
    authType: AuthType,
  ): Promise<KeyRotationStatus> {
    const keys = await this.providerKeyService.getProviderKeys(
      agent.tenant_id,
      provider,
      authType,
      agent.id,
    );
    const ids = keys.map((k) => k.id).filter((id) => id !== SYNTHETIC_OLLAMA_PROVIDER_ID);
    const [successes, failures] = ids.length
      ? await Promise.all([
          this.latestPerKey(agent, ids, sqlIsSuccessStatus('status')),
          this.latestPerKey(agent, ids, sqlIsFailedStatus('status')),
        ])
      : [[], []];
    const successAt = new Map(successes.map((r) => [r.id, String(r.at)]));
    const failureOf = new Map(failures.map((r) => [r.id, r]));
    let lastServedId: string | null = null;
    for (const [id, at] of successAt) {
      if (!lastServedId || at > successAt.get(lastServedId)!) lastServedId = id;
    }
    return {
      provider,
      auth_type: authType,
      keys: keys.map((k) => {
        const failure = failureOf.get(k.id);
        return {
          id: k.id,
          label: k.label,
          priority: k.priority,
          last_served: k.id === lastServedId,
          last_success_at: successAt.get(k.id) ?? null,
          last_failure: failure
            ? {
                at: String(failure.at),
                http_status: failure.error_http_status ?? null,
                error_class: failure.error_class ?? null,
                error_code: failure.error_code ?? null,
              }
            : null,
        };
      }),
    };
  }

  /** The newest attempt per connection matching `statusPredicate`, within the window. */
  private latestPerKey(
    agent: KeyRotationAgent,
    ids: string[],
    statusPredicate: string,
  ): Promise<
    Array<{
      id: string;
      at: string;
      error_http_status: number | null;
      error_class: string | null;
      error_code: string | null;
    }>
  > {
    return this.messageRepo.query(
      `SELECT DISTINCT ON (tenant_provider_id)
         tenant_provider_id::text AS id,
         timestamp AS at,
         error_http_status,
         error_class,
         error_code
       FROM agent_messages
       WHERE tenant_id = $1
         AND agent_id = $2
         AND timestamp >= $3
         AND tenant_provider_id::text = ANY($4)
         AND ${statusPredicate}
       ORDER BY tenant_provider_id, timestamp DESC`,
      [agent.tenant_id, agent.id, computeCutoff(KEY_STATUS_WINDOW), ids],
    );
  }
}
