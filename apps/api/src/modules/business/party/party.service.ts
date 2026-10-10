import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
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

    const scopedMembershipIds =
      await this.authorization.membershipIdsForScope(context, scope);

    return this.database.withTenantTransaction(context, async (client) => {
      const values: unknown[] = [context.tenantId];
      let scopeSql = "";

      if (scopedMembershipIds) {
        values.push(scopedMembershipIds);
        scopeSql = `AND p.responsible_membership_id = ANY($${values.length}::uuid[])`;
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

  async assets(
    context: TenantContext,
    partyId: string
  ): Promise<Array<{
    id: string;
    partyId: string;
    assetType: string;
    name: string;
    manufacturer: string | null;
    model: string | null;
    identifier: string | null;
    registrationNumber: string | null;
    serialNumber: string | null;
    manufactureYear: number | null;
    meterValue: string | null;
    status: string;
  }>> {
    const scope = await this.authorization.resolveScope(context, "crm.read");
    if (!scope) return [];

    const scopedMembershipIds =
      await this.authorization.membershipIdsForScope(context, scope);

    return this.database.withTenantTransaction(context, async (client) => {
      const values: unknown[] = [context.tenantId, partyId];
      let scopeSql = "";

      if (scopedMembershipIds) {
        values.push(scopedMembershipIds);
        scopeSql =
          `AND p.responsible_membership_id = ANY(${values.length}::uuid[])`;
      }

      const party = await client.query(
        `SELECT 1
         FROM party p
         WHERE p.tenant_id=$1
           AND p.id=$2
           AND p.status='ACTIVE'
           ${scopeSql}`,
        values
      );
      if (!party.rowCount) {
        throw new NotFoundException("Клиент не найден");
      }

      const result = await client.query<{
        id: string;
        party_id: string;
        asset_type: string;
        name: string;
        manufacturer: string | null;
        model: string | null;
        identifier: string | null;
        registration_number: string | null;
        serial_number: string | null;
        manufacture_year: number | null;
        meter_value: string | null;
        status: string;
      }>(
        `SELECT
           id,party_id,asset_type,name,manufacturer,model,identifier,
           registration_number,serial_number,manufacture_year,
           meter_value::text,status
         FROM customer_asset
         WHERE tenant_id=$1 AND party_id=$2
         ORDER BY status='ACTIVE' DESC,updated_at DESC,name`,
        [context.tenantId, partyId]
      );

      return result.rows.map((row) => ({
        id: row.id,
        partyId: row.party_id,
        assetType: row.asset_type,
        name: row.name,
        manufacturer: row.manufacturer,
        model: row.model,
        identifier: row.identifier,
        registrationNumber: row.registration_number,
        serialNumber: row.serial_number,
        manufactureYear: row.manufacture_year,
        meterValue: row.meter_value,
        status: row.status
      }));
    });
  }

  async createAsset(
    context: TenantContext,
    partyId: string,
    input: {
      assetType?: "VEHICLE" | "EQUIPMENT" | "DEVICE" | "OTHER";
      name: string;
      manufacturer?: string;
      model?: string;
      identifier?: string;
      registrationNumber?: string;
      serialNumber?: string;
      manufactureYear?: number;
      meterValue?: string;
    }
  ): Promise<{ id: string; name: string }> {
    const scope = await this.authorization.resolveScope(context, "crm.write");
    if (!scope) throw new BadRequestException("Недостаточно прав");

    const scopedMembershipIds =
      await this.authorization.membershipIdsForScope(context, scope);

    const name = String(input.name ?? "").trim();
    if (name.length < 2 || name.length > 200) {
      throw new BadRequestException("Некорректное название объекта");
    }

    const assetType = input.assetType ?? "OTHER";
    if (!["VEHICLE", "EQUIPMENT", "DEVICE", "OTHER"].includes(assetType)) {
      throw new BadRequestException("Некорректный тип объекта");
    }

    const manufactureYear =
      input.manufactureYear === undefined
        ? null
        : Math.floor(Number(input.manufactureYear));
    if (
      manufactureYear !== null &&
      (!Number.isFinite(manufactureYear) ||
        manufactureYear < 1886 ||
        manufactureYear > 2200)
    ) {
      throw new BadRequestException("Некорректный год выпуска");
    }

    const meterValue = input.meterValue?.trim() || null;
    if (meterValue && !/^\d+$/.test(meterValue)) {
      throw new BadRequestException("Некорректное значение счётчика/пробега");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const values: unknown[] = [context.tenantId, partyId];
      let scopeSql = "";

      if (scopedMembershipIds) {
        values.push(scopedMembershipIds);
        scopeSql =
          `AND p.responsible_membership_id = ANY(${values.length}::uuid[])`;
      }

      const party = await client.query(
        `SELECT 1
         FROM party p
         WHERE p.tenant_id=$1
           AND p.id=$2
           AND p.status='ACTIVE'
           ${scopeSql}`,
        values
      );
      if (!party.rowCount) throw new NotFoundException("Клиент не найден");

      try {
        const result = await client.query<{ id: string; name: string }>(
          `INSERT INTO customer_asset(
             tenant_id,party_id,asset_type,name,manufacturer,model,
             identifier,registration_number,serial_number,manufacture_year,
             meter_value,created_by_membership_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING id,name`,
          [
            context.tenantId,
            partyId,
            assetType,
            name,
            input.manufacturer?.trim() || null,
            input.model?.trim() || null,
            input.identifier?.trim().toUpperCase() || null,
            input.registrationNumber?.trim().toUpperCase() || null,
            input.serialNumber?.trim() || null,
            manufactureYear,
            meterValue,
            context.membershipId
          ]
        );

        return result.rows[0]!;
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "23505"
        ) {
          throw new ConflictException(
            "Объект с таким идентификатором уже существует"
          );
        }
        throw error;
      }
    });
  }

  async updateAsset(
    context: TenantContext,
    assetId: string,
    input: {
      name?: string;
      registrationNumber?: string | null;
      meterValue?: string | null;
      status?: "ACTIVE" | "ARCHIVED";
    }
  ): Promise<void> {
    const scope = await this.authorization.resolveScope(context, "crm.write");
    if (!scope) throw new BadRequestException("Недостаточно прав");

    const scopedMembershipIds =
      await this.authorization.membershipIdsForScope(context, scope);

    if (
      input.meterValue !== undefined &&
      input.meterValue !== null &&
      !/^\d+$/.test(input.meterValue)
    ) {
      throw new BadRequestException("Некорректное значение счётчика/пробега");
    }

    const name =
      input.name === undefined ? undefined : input.name.trim();
    if (name !== undefined && (name.length < 2 || name.length > 200)) {
      throw new BadRequestException("Некорректное название объекта");
    }

    if (
      input.status !== undefined &&
      !["ACTIVE", "ARCHIVED"].includes(input.status)
    ) {
      throw new BadRequestException("Некорректный статус объекта");
    }

    await this.database.withTenantTransaction(context, async (client) => {
      const values: unknown[] = [context.tenantId, assetId];
      let scopeSql = "";

      if (scopedMembershipIds) {
        values.push(scopedMembershipIds);
        scopeSql =
          `AND p.responsible_membership_id = ANY(${values.length}::uuid[])`;
      }

      const exists = await client.query(
        `SELECT 1
         FROM customer_asset a
         JOIN party p
           ON p.tenant_id=a.tenant_id AND p.id=a.party_id
         WHERE a.tenant_id=$1
           AND a.id=$2
           ${scopeSql}
         FOR UPDATE OF a`,
        values
      );
      if (!exists.rowCount) {
        throw new NotFoundException("Объект клиента не найден");
      }

      await client.query(
        `UPDATE customer_asset
         SET name=COALESCE($3,name),
             registration_number=CASE
               WHEN $4::boolean THEN $5
               ELSE registration_number
             END,
             meter_value=CASE
               WHEN $6::boolean THEN $7::bigint
               ELSE meter_value
             END,
             status=COALESCE($8,status),
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [
          context.tenantId,
          assetId,
          name ?? null,
          input.registrationNumber !== undefined,
          input.registrationNumber?.trim().toUpperCase() || null,
          input.meterValue !== undefined,
          input.meterValue ?? null,
          input.status ?? null
        ]
      );
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
      idempotencyKey?: string;
    }
  ): Promise<{ id: string; displayName: string; reused?: boolean }> {
    const scope = await this.authorization.resolveScope(context, "crm.write");
    if (!scope) throw new BadRequestException("Недостаточно прав");

    const scopedMembershipIds =
      await this.authorization.membershipIdsForScope(context, scope);

    const displayName = input.displayName.trim();
    if (displayName.length < 2 || displayName.length > 200) {
      throw new BadRequestException("Некорректное имя клиента");
    }

    const idempotencyKey = input.idempotencyKey?.trim() || null;
    if (idempotencyKey && (idempotencyKey.length < 8 || idempotencyKey.length > 180)) {
      throw new BadRequestException("Некорректный ключ идемпотентности клиента");
    }

    const responsibleMembershipId =
      input.responsibleMembershipId ?? context.membershipId;

    if (
      scopedMembershipIds &&
      !scopedMembershipIds.includes(responsibleMembershipId)
    ) {
      throw new BadRequestException("Ответственный сотрудник недоступен");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const normalizedPhone = input.phone?.trim() || "";
      const normalizedEmail = input.email?.trim().toLowerCase() || "";
      const fingerprint = JSON.stringify({
        type: input.type ?? "PERSON",
        displayName,
        phone: normalizedPhone,
        email: normalizedEmail,
        responsibleMembershipId
      });

      if (idempotencyKey) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [context.tenantId + "|party-create|" + idempotencyKey]
        );

        const existing = await client.query<{
          fingerprint: string;
          party_id: string;
          display_name: string;
        }>(
          `SELECT i.fingerprint,i.party_id,p.display_name
           FROM party_create_idempotency i
           JOIN party p
             ON p.tenant_id=i.tenant_id AND p.id=i.party_id
           WHERE i.tenant_id=$1 AND i.idempotency_key=$2`,
          [context.tenantId,idempotencyKey]
        );

        const row = existing.rows[0];
        if (row) {
          if (row.fingerprint !== fingerprint) {
            throw new ConflictException(
              "Ключ идемпотентности уже использован с другими данными клиента"
            );
          }

          return {
            id: row.party_id,
            displayName: row.display_name,
            reused: true
          };
        }
      }

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
        input.email
          ? { type: "EMAIL", value: input.email.trim().toLowerCase() }
          : null
      ].filter(Boolean) as Array<{ type: string; value: string }>) {
        if (!contact.value) continue;

        await client.query(
          `INSERT INTO party_contact(
             tenant_id, party_id, type, value, is_primary
           ) VALUES ($1, $2, $3, $4, true)`,
          [context.tenantId, party.id, contact.type, contact.value]
        );
      }

      if (idempotencyKey) {
        await client.query(
          `INSERT INTO party_create_idempotency(
             tenant_id,idempotency_key,fingerprint,party_id
           ) VALUES ($1,$2,$3,$4)`,
          [
            context.tenantId,
            idempotencyKey,
            fingerprint,
            party.id
          ]
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
