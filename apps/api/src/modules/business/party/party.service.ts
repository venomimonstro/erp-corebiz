import { BadRequestException, Injectable } from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { AuthorizationService } from "../../platform/authorization/authorization.service";

@Injectable()
export class PartyService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: AuthorizationService
  ) {}

  async list(context: TenantContext): Promise<Array<{
    id: string;
    type: string;
    displayName: string;
    responsibleMembershipId: string | null;
    phone: string | null;
    email: string | null;
  }>> {
    const scope = await this.authorization.resolveScope(context, "crm.read");
    if (!scope) return [];

    return this.database.withTenantTransaction(context, async (client) => {
      const values: unknown[] = [context.tenantId];
      let scopeSql = "";

      if (scope === "own") {
        values.push(context.membershipId);
        scopeSql = "AND p.responsible_membership_id = $2";
      }

      const result = await client.query<{
        id: string;
        type: string;
        display_name: string;
        responsible_membership_id: string | null;
        phone: string | null;
        email: string | null;
      }>(
        `SELECT
           p.id,
           p.type,
           p.display_name,
           p.responsible_membership_id,
           (
             SELECT pc.value FROM party_contact pc
             WHERE pc.party_id = p.id AND pc.type = 'PHONE'
             ORDER BY pc.is_primary DESC, pc.created_at ASC
             LIMIT 1
           ) AS phone,
           (
             SELECT pc.value FROM party_contact pc
             WHERE pc.party_id = p.id AND pc.type = 'EMAIL'
             ORDER BY pc.is_primary DESC, pc.created_at ASC
             LIMIT 1
           ) AS email
         FROM party p
         WHERE p.tenant_id = $1
           AND p.status = 'ACTIVE'
           AND EXISTS (
             SELECT 1 FROM party_role pr
             WHERE pr.party_id = p.id AND pr.role = 'CUSTOMER'
           )
           ${scopeSql}
         ORDER BY p.updated_at DESC
         LIMIT 500`,
        values
      );

      return result.rows.map((row) => ({
        id: row.id,
        type: row.type,
        displayName: row.display_name,
        responsibleMembershipId: row.responsible_membership_id,
        phone: row.phone,
        email: row.email
      }));
    });
  }

  async create(
    context: TenantContext,
    input: {
      type?: "PERSON" | "ORGANIZATION";
      displayName: string;
      phone?: string;
      email?: string;
      responsibleMembershipId?: string;
    }
  ): Promise<{ id: string; displayName: string }> {
    const scope = await this.authorization.resolveScope(context, "crm.write");
    if (!scope) throw new BadRequestException("Недостаточно прав");

    const displayName = input.displayName.trim();
    if (displayName.length < 2 || displayName.length > 200) {
      throw new BadRequestException("Некорректное имя клиента");
    }

    const responsibleMembershipId =
      scope === "own"
        ? context.membershipId
        : input.responsibleMembershipId ?? context.membershipId;

    return this.database.withTenantTransaction(context, async (client) => {
      const responsible = await client.query(
        `SELECT 1 FROM tenant_membership
         WHERE tenant_id = $1 AND id = $2 AND status = 'ACTIVE'`,
        [context.tenantId, responsibleMembershipId]
      );

      if (!responsible.rowCount) {
        throw new BadRequestException("Ответственный сотрудник недоступен");
      }

      const result = await client.query<{ id: string; display_name: string }>(
        `INSERT INTO party(
           tenant_id, type, display_name, responsible_membership_id
         ) VALUES ($1, $2, $3, $4)
         RETURNING id, display_name`,
        [
          context.tenantId,
          input.type ?? "PERSON",
          displayName,
          responsibleMembershipId
        ]
      );

      const party = result.rows[0];
      if (!party) throw new Error("PARTY_CREATE_FAILED");

      await client.query(
        `INSERT INTO party_role(tenant_id, party_id, role)
         VALUES ($1, $2, 'CUSTOMER')`,
        [context.tenantId, party.id]
      );

      for (const contact of [
        input.phone ? { type: "PHONE", value: input.phone.trim() } : null,
        input.email ? { type: "EMAIL", value: input.email.trim().toLowerCase() } : null
      ].filter(Boolean) as Array<{ type: string; value: string }>) {
        if (!contact.value) continue;
        await client.query(
          `INSERT INTO party_contact(
             tenant_id, party_id, type, value, is_primary
           ) VALUES ($1, $2, $3, $4, true)`,
          [context.tenantId, party.id, contact.type, contact.value]
        );
      }

      await client.query(
        `INSERT INTO audit_event(
           tenant_id, actor_user_id, actor_membership_id,
           action, resource_type, resource_id, after_data
         ) VALUES ($1, $2, $3, 'party.customer_created', 'party', $4, $5)`,
        [
          context.tenantId,
          context.userId,
          context.membershipId,
          party.id,
          JSON.stringify({ displayName })
        ]
      );

      return { id: party.id, displayName: party.display_name };
    });
  }
}
