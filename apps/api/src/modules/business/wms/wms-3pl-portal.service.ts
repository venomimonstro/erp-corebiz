import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseService } from "../../../infrastructure/database/database.service";

@Injectable()
export class Wms3plPortalService {
  constructor(private readonly database: DatabaseService) {}

  async accesses(
    context: TenantContext,
    ownerId?: string
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT
           a.id,a.owner_id,o.code AS owner_code,o.name AS owner_name,
           a.label,a.status,a.expires_at,a.last_used_at,a.access_count,
           a.revoked_at,a.created_at
         FROM wms_3pl_portal_access a
         JOIN inventory_owner o
           ON o.tenant_id=a.tenant_id AND o.id=a.owner_id
         WHERE a.tenant_id=$1
           AND ($2::uuid IS NULL OR a.owner_id=$2)
         ORDER BY a.created_at DESC
         LIMIT 500`,
        [context.tenantId, ownerId ?? null]
      );
      return result.rows;
    });
  }

  async createAccess(
    context: TenantContext,
    ownerId: string,
    input: {
      label?: string;
      expiresAt?: string;
    }
  ): Promise<{
    id: string;
    token: string;
    expiresAt: string | null;
  }> {
    const label = (input.label?.trim() || "3PL Client Portal").slice(0, 160);
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;

    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      throw new BadRequestException("Некорректный expiresAt");
    }
    if (expiresAt && expiresAt <= new Date()) {
      throw new BadRequestException("Срок действия должен быть в будущем");
    }

    const token = "3pl_" + randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");

    return this.database.withTenantTransaction(context, async (client) => {
      const owner = await client.query(
        `SELECT 1
         FROM inventory_owner
         WHERE tenant_id=$1
           AND id=$2
           AND owner_type='CLIENT'
           AND status='ACTIVE'`,
        [context.tenantId, ownerId]
      );
      if (!owner.rowCount) {
        throw new NotFoundException("Активный 3PL-владелец не найден");
      }

      const result = await client.query<{ id: string }>(
        `INSERT INTO wms_3pl_portal_access(
           tenant_id,owner_id,label,token_hash,expires_at,
           created_by_membership_id
         ) VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id`,
        [
          context.tenantId,
          ownerId,
          label,
          tokenHash,
          expiresAt,
          context.membershipId
        ]
      );

      await this.audit(
        client,
        context,
        "wms.3pl_portal_access_created",
        "inventory_owner",
        ownerId,
        {
          accessId: result.rows[0]!.id,
          label,
          expiresAt: expiresAt?.toISOString() ?? null
        }
      );

      return {
        id: result.rows[0]!.id,
        token,
        expiresAt: expiresAt?.toISOString() ?? null
      };
    });
  }

  async revoke(
    context: TenantContext,
    accessId: string
  ): Promise<void> {
    await this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{ owner_id: string }>(
        `UPDATE wms_3pl_portal_access
         SET status='REVOKED',
             revoked_at=now(),
             revoked_by_membership_id=$3
         WHERE tenant_id=$1
           AND id=$2
           AND status='ACTIVE'
         RETURNING owner_id`,
        [context.tenantId, accessId, context.membershipId]
      );

      const row = result.rows[0];
      if (!row) {
        throw new NotFoundException("Активный portal access не найден");
      }

      await this.audit(
        client,
        context,
        "wms.3pl_portal_access_revoked",
        "inventory_owner",
        row.owner_id,
        { accessId }
      );
    });
  }

  async portalOverview(token: string): Promise<Record<string, unknown>> {
    const resolved = await this.resolve(token);

    return this.database.withTenantTransaction(
      {
        tenantId: resolved.tenantId,
        userId: "00000000-0000-0000-0000-000000000000",
        membershipId: "00000000-0000-0000-0000-000000000000"
      },
      async (client) => {
        const owner = await client.query(
          `SELECT id,code,name,status
           FROM inventory_owner
           WHERE tenant_id=$1 AND id=$2
             AND owner_type='CLIENT' AND status='ACTIVE'`,
          [resolved.tenantId, resolved.ownerId]
        );
        if (!owner.rows[0]) {
          throw new ForbiddenException("Доступ владельца недоступен");
        }

        const balances = await client.query(
          `SELECT
             b.warehouse_id,w.name AS warehouse_name,
             b.sku_id,s.code AS sku_code,p.name AS product_name,
             b.physical_milli::text,b.reserved_milli::text,
             (b.physical_milli-b.reserved_milli)::text AS available_milli
           FROM inventory_owner_balance b
           JOIN warehouse w
             ON w.tenant_id=b.tenant_id AND w.id=b.warehouse_id
           JOIN sku s
             ON s.tenant_id=b.tenant_id AND s.id=b.sku_id
           JOIN product_variant v
             ON v.tenant_id=s.tenant_id AND v.id=s.variant_id
           JOIN product p
             ON p.tenant_id=v.tenant_id AND p.id=v.product_id
           WHERE b.tenant_id=$1
             AND b.owner_id=$2
             AND (b.physical_milli<>0 OR b.reserved_milli<>0)
           ORDER BY w.name,p.name,s.code
           LIMIT 2000`,
          [resolved.tenantId, resolved.ownerId]
        );

        const locations = await client.query(
          `SELECT
             b.warehouse_id,w.name AS warehouse_name,
             b.location_id,l.full_code,
             b.sku_id,s.code AS sku_code,p.name AS product_name,
             b.physical_milli::text
           FROM warehouse_location_owner_balance b
           JOIN warehouse w
             ON w.tenant_id=b.tenant_id AND w.id=b.warehouse_id
           JOIN warehouse_location l
             ON l.tenant_id=b.tenant_id AND l.id=b.location_id
           JOIN sku s
             ON s.tenant_id=b.tenant_id AND s.id=b.sku_id
           JOIN product_variant v
             ON v.tenant_id=s.tenant_id AND v.id=s.variant_id
           JOIN product p
             ON p.tenant_id=v.tenant_id AND p.id=v.product_id
           WHERE b.tenant_id=$1
             AND b.owner_id=$2
             AND b.physical_milli<>0
           ORDER BY w.name,l.pick_sequence,p.name
           LIMIT 3000`,
          [resolved.tenantId, resolved.ownerId]
        );

        const movements = await client.query(
          `SELECT
             m.id,m.warehouse_id,w.name AS warehouse_name,
             m.sku_id,s.code AS sku_code,p.name AS product_name,
             m.movement_type,m.physical_delta_milli::text,
             m.reserved_delta_milli::text,m.source_type,m.source_id,
             m.created_at
           FROM inventory_owner_movement m
           JOIN warehouse w
             ON w.tenant_id=m.tenant_id AND w.id=m.warehouse_id
           JOIN sku s
             ON s.tenant_id=m.tenant_id AND s.id=m.sku_id
           JOIN product_variant v
             ON v.tenant_id=s.tenant_id AND v.id=s.variant_id
           JOIN product p
             ON p.tenant_id=v.tenant_id AND p.id=v.product_id
           WHERE m.tenant_id=$1 AND m.owner_id=$2
           ORDER BY m.created_at DESC
           LIMIT 500`,
          [resolved.tenantId, resolved.ownerId]
        );

        const orders = await client.query(
          `SELECT
             so.id,so.business_number,so.order_status,
             so.payment_status,so.fulfillment_status,
             so.total_minor::text,so.currency,so.created_at,so.updated_at
           FROM sales_order so
           WHERE so.tenant_id=$1
             AND so.inventory_owner_id=$2
           ORDER BY so.created_at DESC
           LIMIT 300`,
          [resolved.tenantId, resolved.ownerId]
        );

        const statements = await client.query(
          `SELECT
             s.id,s.warehouse_id,w.name AS warehouse_name,
             s.period_from,s.period_to,s.currency,s.total_minor::text,
             s.finalized_at
           FROM wms_3pl_statement s
           JOIN warehouse w
             ON w.tenant_id=s.tenant_id AND w.id=s.warehouse_id
           WHERE s.tenant_id=$1
             AND s.owner_id=$2
             AND s.status='FINALIZED'
           ORDER BY s.period_from DESC
           LIMIT 100`,
          [resolved.tenantId, resolved.ownerId]
        );

        return {
          owner: owner.rows[0],
          balances: balances.rows,
          locations: locations.rows,
          movements: movements.rows,
          orders: orders.rows,
          statements: statements.rows
        };
      }
    );
  }

  async portalStatement(
    token: string,
    statementId: string
  ): Promise<Record<string, unknown>> {
    const resolved = await this.resolve(token);

    return this.database.withTenantTransaction(
      {
        tenantId: resolved.tenantId,
        userId: "00000000-0000-0000-0000-000000000000",
        membershipId: "00000000-0000-0000-0000-000000000000"
      },
      async (client) => {
        const statement = await client.query(
          `SELECT
             s.id,s.period_from,s.period_to,s.currency,s.total_minor::text,
             s.finalized_at,w.name AS warehouse_name
           FROM wms_3pl_statement s
           JOIN warehouse w
             ON w.tenant_id=s.tenant_id AND w.id=s.warehouse_id
           WHERE s.tenant_id=$1
             AND s.owner_id=$2
             AND s.id=$3
             AND s.status='FINALIZED'`,
          [resolved.tenantId, resolved.ownerId, statementId]
        );
        if (!statement.rows[0]) {
          throw new NotFoundException("Statement не найден");
        }

        const lines = await client.query(
          `SELECT
             service_code,quantity_milli::text,unit,
             rate_minor::text,amount_minor::text,calculation
           FROM wms_3pl_statement_line
           WHERE tenant_id=$1 AND statement_id=$2
           ORDER BY service_code,created_at`,
          [resolved.tenantId, statementId]
        );

        return {
          statement: statement.rows[0],
          lines: lines.rows
        };
      }
    );
  }

  private async resolve(
    token: string
  ): Promise<{ accessId: string; tenantId: string; ownerId: string }> {
    if (!/^3pl_[A-Za-z0-9_-]{30,100}$/.test(token)) {
      throw new ForbiddenException("Недействительный portal token");
    }

    const tokenHash = createHash("sha256").update(token).digest("hex");
    const result = await this.database.query<{
      access_id: string;
      tenant_id: string;
      owner_id: string;
    }>(
      `SELECT * FROM corebiz_resolve_3pl_portal_access($1)`,
      [tokenHash]
    );

    const row = result.rows[0];
    if (!row) {
      throw new ForbiddenException(
        "Доступ истёк, отозван или токен недействителен"
      );
    }

    return {
      accessId: row.access_id,
      tenantId: row.tenant_id,
      ownerId: row.owner_id
    };
  }

  private async audit(
    client: import("pg").PoolClient,
    context: TenantContext,
    action: string,
    resourceType: string,
    resourceId: string,
    data?: Record<string, unknown>
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_event(
         tenant_id,actor_user_id,actor_membership_id,
         action,resource_type,resource_id,after_data
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        context.tenantId,
        context.userId,
        context.membershipId,
        action,
        resourceType,
        resourceId,
        data ? JSON.stringify(data) : null
      ]
    );
  }
}
