import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";

type ServiceCode =
  | "RECEIPT_UNIT"
  | "PUTAWAY_TASK"
  | "PICK_TASK"
  | "PACK_TASK"
  | "SHIPMENT_UNIT"
  | "STORAGE_UNIT_DAY";

@Injectable()
export class Wms3plBillingService {
  constructor(private readonly database: DatabaseService) {}

  async contracts(
    context: TenantContext,
    warehouseId?: string
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT
           c.id,c.warehouse_id,w.name AS warehouse_name,
           c.owner_id,o.code AS owner_code,o.name AS owner_name,
           c.status,c.services,c.billing_rules,c.created_at,c.updated_at,
           COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'id',r.id,
                 'serviceCode',r.service_code,
                 'unit',r.unit,
                 'rateMinor',r.rate_minor::text,
                 'currency',r.currency,
                 'effectiveFrom',r.effective_from,
                 'effectiveTo',r.effective_to
               )
               ORDER BY r.service_code,r.effective_from DESC
             ) FILTER (WHERE r.id IS NOT NULL),
             '[]'::jsonb
           ) AS rates
         FROM warehouse_3pl_contract c
         JOIN warehouse w
           ON w.tenant_id=c.tenant_id AND w.id=c.warehouse_id
         JOIN inventory_owner o
           ON o.tenant_id=c.tenant_id AND o.id=c.owner_id
         LEFT JOIN wms_3pl_rate r
           ON r.tenant_id=c.tenant_id AND r.contract_id=c.id
         WHERE c.tenant_id=$1
           AND ($2::uuid IS NULL OR c.warehouse_id=$2)
         GROUP BY c.id,w.name,o.code,o.name
         ORDER BY w.name,o.name`,
        [context.tenantId, warehouseId ?? null]
      );
      return result.rows;
    });
  }

  async setRate(
    context: TenantContext,
    contractId: string,
    input: {
      serviceCode: ServiceCode;
      rateMinor: string;
      currency?: string;
      effectiveFrom: string;
    }
  ): Promise<{ id: string }> {
    if (!/^\d+$/.test(input.rateMinor)) {
      throw new BadRequestException("Некорректный тариф");
    }

    const date = new Date(input.effectiveFrom + "T00:00:00Z");
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException("Некорректная дата начала тарифа");
    }

    const currency = (input.currency ?? "RUB").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new BadRequestException("Некорректная валюта");
    }

    const unit =
      input.serviceCode.endsWith("_TASK")
        ? "TASK"
        : input.serviceCode === "STORAGE_UNIT_DAY"
          ? "UNIT_DAY"
          : "UNIT";

    return this.database.withTenantTransaction(context, async (client) => {
      const contract = await client.query(
        `SELECT 1 FROM warehouse_3pl_contract
         WHERE tenant_id=$1 AND id=$2 AND status<>'CLOSED'`,
        [context.tenantId, contractId]
      );
      if (!contract.rowCount) {
        throw new NotFoundException("3PL-контракт не найден");
      }

      const overlap = await client.query(
        `SELECT 1
         FROM wms_3pl_rate
         WHERE tenant_id=$1
           AND contract_id=$2
           AND service_code=$3
           AND effective_from=$4::date
         LIMIT 1`,
        [
          context.tenantId,
          contractId,
          input.serviceCode,
          input.effectiveFrom
        ]
      );
      if (overlap.rowCount) {
        throw new ConflictException(
          "Тариф на эту услугу с такой датой уже существует"
        );
      }

      await client.query(
        `UPDATE wms_3pl_rate
         SET effective_to=$4::date - 1
         WHERE tenant_id=$1
           AND contract_id=$2
           AND service_code=$3
           AND effective_from < $4::date
           AND (effective_to IS NULL OR effective_to >= $4::date)`,
        [
          context.tenantId,
          contractId,
          input.serviceCode,
          input.effectiveFrom
        ]
      );

      const result = await client.query<{ id: string }>(
        `INSERT INTO wms_3pl_rate(
           tenant_id,contract_id,service_code,unit,
           rate_minor,currency,effective_from,created_by_membership_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id`,
        [
          context.tenantId,
          contractId,
          input.serviceCode,
          unit,
          input.rateMinor,
          currency,
          input.effectiveFrom,
          context.membershipId
        ]
      );

      return result.rows[0]!;
    });
  }

  async statements(
    context: TenantContext,
    contractId?: string
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT
           s.id,s.contract_id,s.warehouse_id,w.name AS warehouse_name,
           s.owner_id,o.name AS owner_name,
           s.period_from,s.period_to,s.status,s.currency,
           s.total_minor::text,s.generated_at,s.finalized_at,s.updated_at
         FROM wms_3pl_statement s
         JOIN warehouse w
           ON w.tenant_id=s.tenant_id AND w.id=s.warehouse_id
         JOIN inventory_owner o
           ON o.tenant_id=s.tenant_id AND o.id=s.owner_id
         WHERE s.tenant_id=$1
           AND ($2::uuid IS NULL OR s.contract_id=$2)
         ORDER BY s.period_from DESC,s.created_at DESC
         LIMIT 500`,
        [context.tenantId, contractId ?? null]
      );
      return result.rows;
    });
  }

  async statement(
    context: TenantContext,
    statementId: string
  ): Promise<Record<string, unknown>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const head = await client.query(
        `SELECT
           s.*,w.name AS warehouse_name,o.name AS owner_name,o.code AS owner_code
         FROM wms_3pl_statement s
         JOIN warehouse w
           ON w.tenant_id=s.tenant_id AND w.id=s.warehouse_id
         JOIN inventory_owner o
           ON o.tenant_id=s.tenant_id AND o.id=s.owner_id
         WHERE s.tenant_id=$1 AND s.id=$2`,
        [context.tenantId, statementId]
      );
      if (!head.rows[0]) throw new NotFoundException("Statement не найден");

      const lines = await client.query(
        `SELECT
           l.id,l.service_code,l.quantity_milli::text,l.unit,
           l.rate_minor::text,l.amount_minor::text,l.calculation,
           r.effective_from,r.effective_to
         FROM wms_3pl_statement_line l
         JOIN wms_3pl_rate r
           ON r.tenant_id=l.tenant_id AND r.id=l.rate_id
         WHERE l.tenant_id=$1 AND l.statement_id=$2
         ORDER BY l.service_code,r.effective_from`,
        [context.tenantId, statementId]
      );

      return { statement: head.rows[0], lines: lines.rows };
    });
  }

  async generate(
    context: TenantContext,
    contractId: string,
    input: { periodFrom: string; periodTo: string }
  ): Promise<{ id: string; totalMinor: string; lines: number }> {
    const from = this.date(input.periodFrom, "Начало периода");
    const to = this.date(input.periodTo, "Конец периода");
    if (to < from) {
      throw new BadRequestException("Конец периода раньше начала");
    }
    if ((to.getTime() - from.getTime()) / 86400000 > 92) {
      throw new BadRequestException("Период statement не более 93 дней");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const contract = await client.query<{
        warehouse_id: string;
        owner_id: string;
        status: string;
      }>(
        `SELECT warehouse_id,owner_id,status
         FROM warehouse_3pl_contract
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [context.tenantId, contractId]
      );
      const row = contract.rows[0];
      if (!row) throw new NotFoundException("3PL-контракт не найден");
      if (row.status === "CLOSED") {
        throw new BadRequestException("3PL-контракт закрыт");
      }

      const existing = await client.query<{
        id: string;
        status: string;
      }>(
        `SELECT id,status
         FROM wms_3pl_statement
         WHERE tenant_id=$1
           AND contract_id=$2
           AND period_from=$3::date
           AND period_to=$4::date
         FOR UPDATE`,
        [
          context.tenantId,
          contractId,
          input.periodFrom,
          input.periodTo
        ]
      );

      let statementId = existing.rows[0]?.id;
      if (existing.rows[0]?.status === "FINALIZED") {
        throw new ConflictException(
          "Финализированный statement нельзя пересчитать"
        );
      }

      if (!statementId) {
        const created = await client.query<{ id: string }>(
          `INSERT INTO wms_3pl_statement(
             tenant_id,warehouse_id,owner_id,contract_id,
             period_from,period_to,created_by_membership_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING id`,
          [
            context.tenantId,
            row.warehouse_id,
            row.owner_id,
            contractId,
            input.periodFrom,
            input.periodTo,
            context.membershipId
          ]
        );
        statementId = created.rows[0]!.id;
      } else {
        await client.query(
          `DELETE FROM wms_3pl_statement_line
           WHERE tenant_id=$1 AND statement_id=$2`,
          [context.tenantId, statementId]
        );
      }

      const rates = await client.query<{
        id: string;
        service_code: ServiceCode;
        unit: "UNIT" | "TASK" | "UNIT_DAY";
        rate_minor: string;
        currency: string;
        effective_from: string;
        effective_to: string | null;
      }>(
        `SELECT
           id,service_code,unit,rate_minor::text,currency,
           effective_from::text,effective_to::text
         FROM wms_3pl_rate
         WHERE tenant_id=$1
           AND contract_id=$2
           AND effective_from <= $4::date
           AND (effective_to IS NULL OR effective_to >= $3::date)
         ORDER BY service_code,effective_from`,
        [
          context.tenantId,
          contractId,
          input.periodFrom,
          input.periodTo
        ]
      );

      let total = 0n;
      let lines = 0;

      for (const rate of rates.rows) {
        const rateFrom =
          rate.effective_from > input.periodFrom
            ? rate.effective_from
            : input.periodFrom;
        const rateTo =
          rate.effective_to && rate.effective_to < input.periodTo
            ? rate.effective_to
            : input.periodTo;

        const quantity = await this.quantity(
          client,
          context.tenantId,
          row.warehouse_id,
          row.owner_id,
          rate.service_code,
          rateFrom,
          rateTo
        );

        if (quantity === 0n) continue;

        const amount =
          (quantity * BigInt(rate.rate_minor) + 500n) / 1000n;

        await client.query(
          `INSERT INTO wms_3pl_statement_line(
             tenant_id,statement_id,service_code,rate_id,
             quantity_milli,unit,rate_minor,amount_minor,calculation
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            context.tenantId,
            statementId,
            rate.service_code,
            rate.id,
            quantity.toString(),
            rate.unit,
            rate.rate_minor,
            amount.toString(),
            JSON.stringify({
              rateFrom,
              rateTo,
              formula:
                rate.unit === "TASK"
                  ? "tasks × rate"
                  : rate.unit === "UNIT_DAY"
                    ? "unit-days × rate"
                    : "units × rate"
            })
          ]
        );

        total += amount;
        lines += 1;
      }

      await client.query(
        `UPDATE wms_3pl_statement
         SET total_minor=$3,
             generated_at=now(),
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId, statementId, total.toString()]
      );

      return {
        id: statementId,
        totalMinor: total.toString(),
        lines
      };
    });
  }

  async finalize(
    context: TenantContext,
    statementId: string
  ): Promise<void> {
    await this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `UPDATE wms_3pl_statement
         SET status='FINALIZED',
             finalized_at=now(),
             finalized_by_membership_id=$3,
             updated_at=now()
         WHERE tenant_id=$1
           AND id=$2
           AND status='DRAFT'
         RETURNING id`,
        [context.tenantId, statementId, context.membershipId]
      );
      if (!result.rowCount) {
        throw new ConflictException(
          "Statement уже финализирован или недоступен"
        );
      }
    });
  }

  private async quantity(
    client: import("pg").PoolClient,
    tenantId: string,
    warehouseId: string,
    ownerId: string,
    service: ServiceCode,
    from: string,
    to: string
  ): Promise<bigint> {
    if (service === "RECEIPT_UNIT" || service === "SHIPMENT_UNIT") {
      const movementType =
        service === "RECEIPT_UNIT" ? "RECEIPT" : "SHIPMENT";
      const result = await client.query<{ quantity: string }>(
        `SELECT
           COALESCE(sum(abs(physical_delta_milli)),0)::text AS quantity
         FROM inventory_owner_movement
         WHERE tenant_id=$1
           AND warehouse_id=$2
           AND owner_id=$3
           AND movement_type=$4
           AND created_at >= $5::date
           AND created_at < ($6::date + 1)`,
        [tenantId, warehouseId, ownerId, movementType, from, to]
      );
      return BigInt(result.rows[0]?.quantity ?? "0");
    }

    if (
      service === "PUTAWAY_TASK" ||
      service === "PICK_TASK" ||
      service === "PACK_TASK"
    ) {
      const taskType = service.replace("_TASK", "");
      const result = await client.query<{ quantity: string }>(
        `SELECT (count(*) * 1000)::text AS quantity
         FROM warehouse_task
         WHERE tenant_id=$1
           AND warehouse_id=$2
           AND owner_id=$3
           AND task_type=$4
           AND status='COMPLETED'
           AND completed_at >= $5::date
           AND completed_at < ($6::date + 1)`,
        [tenantId, warehouseId, ownerId, taskType, from, to]
      );
      return BigInt(result.rows[0]?.quantity ?? "0");
    }

    const result = await client.query<{ quantity: string }>(
      `WITH days AS (
         SELECT generate_series(
           $4::date,
           $5::date,
           interval '1 day'
         )::date AS day
       ),
       skus AS (
         SELECT DISTINCT sku_id
         FROM inventory_owner_movement
         WHERE tenant_id=$1
           AND warehouse_id=$2
           AND owner_id=$3
           AND created_at < ($5::date + 1)
       ),
       balances AS (
         SELECT
           d.day,
           s.sku_id,
           COALESCE((
             SELECT sum(m.physical_delta_milli)
             FROM inventory_owner_movement m
             WHERE m.tenant_id=$1
               AND m.warehouse_id=$2
               AND m.owner_id=$3
               AND m.sku_id=s.sku_id
               AND m.created_at < (d.day + 1)
           ),0) AS physical_milli
         FROM days d
         CROSS JOIN skus s
       )
       SELECT COALESCE(sum(GREATEST(physical_milli,0)),0)::text AS quantity
       FROM balances`,
      [tenantId, warehouseId, ownerId, from, to]
    );

    return BigInt(result.rows[0]?.quantity ?? "0");
  }

  private date(value: string, label: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new BadRequestException(label + ": формат YYYY-MM-DD");
    }
    const date = new Date(value + "T00:00:00Z");
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(label + ": некорректная дата");
    }
    return date;
  }
}
