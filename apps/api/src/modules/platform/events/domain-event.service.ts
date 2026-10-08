import { Injectable } from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import type { PoolClient } from "pg";

@Injectable()
export class DomainEventService {
  async enqueue(
    client: PoolClient,
    context: TenantContext,
    input: {
      eventName: string;
      entityType?: string;
      entityId?: string;
      payload?: Record<string, unknown>;
      depth?: number;
    }
  ): Promise<string> {
    const depth = Math.max(0, Math.min(5, input.depth ?? 0));

    const result = await client.query<{ id: string }>(
      "INSERT INTO domain_event_outbox(" +
      "tenant_id, event_name, entity_type, entity_id, actor_user_id, " +
      "actor_membership_id, payload, depth" +
      ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
      [
        context.tenantId,
        input.eventName,
        input.entityType ?? null,
        input.entityId ?? null,
        context.userId,
        context.membershipId,
        JSON.stringify(input.payload ?? {}),
        depth
      ]
    );

    return result.rows[0]!.id;
  }
}
