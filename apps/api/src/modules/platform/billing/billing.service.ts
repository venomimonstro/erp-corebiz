import {
  BadRequestException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";

export type EffectiveBillingState = "ACTIVE" | "GRACE" | "READ_ONLY";

@Injectable()
export class BillingService {
  constructor(private readonly database: DatabaseService) {}

  async plans(): Promise<Array<{
    id: string;
    code: string;
    name: string;
    monthlyPriceMinor: string;
    currency: string;
    entitlements: Record<string, unknown>;
  }>> {
    const plans = await this.database.query<{
      id: string;
      code: string;
      name: string;
      monthly_price_minor: string;
      currency: string;
    }>(
      `SELECT id, code, name, monthly_price_minor::text, currency
       FROM billing_plan
       WHERE status = 'ACTIVE'
       ORDER BY sort_order, monthly_price_minor`
    );

    const result = [];

    for (const plan of plans.rows) {
      const entitlements = await this.database.query<{
        entitlement_key: string;
        entitlement_value: unknown;
      }>(
        `SELECT entitlement_key, entitlement_value
         FROM plan_entitlement
         WHERE plan_id = $1
         ORDER BY entitlement_key`,
        [plan.id]
      );

      result.push({
        id: plan.id,
        code: plan.code,
        name: plan.name,
        monthlyPriceMinor: plan.monthly_price_minor,
        currency: plan.currency,
        entitlements: Object.fromEntries(
          entitlements.rows.map((row) => [
            row.entitlement_key,
            row.entitlement_value
          ])
        )
      });
    }

    return result;
  }

  async current(context: TenantContext): Promise<{
    state: EffectiveBillingState;
    subscription: {
      planId: string;
      planCode: string;
      planName: string;
      status: string;
      currentPeriodStart: string;
      currentPeriodEnd: string;
      graceUntil: string | null;
      cancelAtPeriodEnd: boolean;
    };
    entitlements: Record<string, unknown>;
  }> {
    const state = await this.evaluate(context);

    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{
        plan_id: string;
        plan_code: string;
        plan_name: string;
        status: string;
        current_period_start: Date;
        current_period_end: Date;
        grace_until: Date | null;
        cancel_at_period_end: boolean;
      }>(
        `SELECT
           s.plan_id,
           p.code AS plan_code,
           p.name AS plan_name,
           s.status,
           s.current_period_start,
           s.current_period_end,
           s.grace_until,
           s.cancel_at_period_end
         FROM tenant_subscription s
         JOIN billing_plan p ON p.id = s.plan_id
         WHERE s.tenant_id = $1`,
        [context.tenantId]
      );

      const row = result.rows[0];
      if (!row) throw new NotFoundException("Подписка не найдена");

      const entitlements = await client.query<{
        entitlement_key: string;
        entitlement_value: unknown;
      }>(
        `SELECT entitlement_key, entitlement_value
         FROM plan_entitlement
         WHERE plan_id = $1`,
        [row.plan_id]
      );

      return {
        state,
        subscription: {
          planId: row.plan_id,
          planCode: row.plan_code,
          planName: row.plan_name,
          status: row.status,
          currentPeriodStart: row.current_period_start.toISOString(),
          currentPeriodEnd: row.current_period_end.toISOString(),
          graceUntil: row.grace_until?.toISOString() ?? null,
          cancelAtPeriodEnd: row.cancel_at_period_end
        },
        entitlements: Object.fromEntries(
          entitlements.rows.map((item) => [
            item.entitlement_key,
            item.entitlement_value
          ])
        )
      };
    });
  }

  async evaluate(context: TenantContext): Promise<EffectiveBillingState> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{
        status: string;
        current_period_end: Date;
        grace_until: Date | null;
      }>(
        `SELECT status, current_period_end, grace_until
         FROM tenant_subscription
         WHERE tenant_id = $1
         FOR UPDATE`,
        [context.tenantId]
      );

      const row = result.rows[0];
      if (!row) {
        return "ACTIVE";
      }

      const now = new Date();
      let state: EffectiveBillingState;
      let subscriptionStatus = row.status;

      if (
        ["TRIAL", "ACTIVE"].includes(row.status) &&
        row.current_period_end.getTime() > now.getTime()
      ) {
        state = "ACTIVE";
      } else if (
        row.status !== "CANCELLED" &&
        row.grace_until &&
        row.grace_until.getTime() > now.getTime()
      ) {
        state = "GRACE";
        subscriptionStatus = "GRACE";
      } else {
        state = "READ_ONLY";
        subscriptionStatus = "READ_ONLY";
      }

      await client.query(
        `UPDATE tenant_subscription
         SET status = $2,
             updated_at = now()
         WHERE tenant_id = $1
           AND status IS DISTINCT FROM $2`,
        [context.tenantId, subscriptionStatus]
      );

      const tenantStatus =
        state === "ACTIVE" ? "ACTIVE" : state === "GRACE" ? "GRACE" : "READ_ONLY";

      await client.query(
        `UPDATE tenant
         SET status = $2,
             updated_at = now()
         WHERE id = $1
           AND status IS DISTINCT FROM $2
           AND status NOT IN ('SUSPENDED','CANCELLED')`,
        [context.tenantId, tenantStatus]
      );

      return state;
    });
  }

  async selectPlan(
    context: TenantContext,
    planCode: string
  ): Promise<{ selected: true; planCode: string }> {
    const code = planCode.trim().toUpperCase();

    return this.database.withTenantTransaction(context, async (client) => {
      const plan = await client.query<{ id: string; code: string }>(
        `SELECT id, code
         FROM billing_plan
         WHERE code = $1 AND status = 'ACTIVE'`,
        [code]
      );

      const row = plan.rows[0];
      if (!row) throw new BadRequestException("Тариф не найден");

      const subscription = await client.query<{ status: string }>(
        `SELECT status
         FROM tenant_subscription
         WHERE tenant_id = $1
         FOR UPDATE`,
        [context.tenantId]
      );

      if (!subscription.rows[0]) {
        throw new NotFoundException("Подписка не найдена");
      }

      await client.query(
        `UPDATE tenant_subscription
         SET plan_id = $2,
             updated_at = now()
         WHERE tenant_id = $1`,
        [context.tenantId, row.id]
      );

      await client.query(
        `INSERT INTO billing_event(
           tenant_id, event_type, subscription_status, payload
         ) VALUES ($1,'plan_selected',$2,$3)`,
        [
          context.tenantId,
          subscription.rows[0].status,
          JSON.stringify({ planCode: row.code })
        ]
      );

      return { selected: true, planCode: row.code };
    });
  }

  async setCancelAtPeriodEnd(
    context: TenantContext,
    value: boolean
  ): Promise<void> {
    await this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `UPDATE tenant_subscription
         SET cancel_at_period_end = $2,
             updated_at = now()
         WHERE tenant_id = $1
         RETURNING tenant_id`,
        [context.tenantId, value]
      );

      if (!result.rowCount) throw new NotFoundException("Подписка не найдена");

      await client.query(
        `INSERT INTO billing_event(
           tenant_id, event_type, payload
         ) VALUES ($1,'cancel_at_period_end_changed',$2)`,
        [context.tenantId, JSON.stringify({ value })]
      );
    });
  }
}
