import {
  BadRequestException,
  Injectable
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";

const COMPONENTS = new Set([
  "CORE","API","AUTH","COMMERCE","SITES","WMS",
  "FINANCE","BANK","ACCOUNTING","VAT","PAYROLL","ANALYTICS"
]);

const KINDS = new Set([
  "MIGRATIONS","TYPECHECK","TESTS","BUILD","SECURITY",
  "INTEGRATION","BROWSER_SMOKE","RESTORE","RECONCILIATION"
]);

const OUTCOMES = new Set(["PASS","FAIL","BLOCKED"]);

@Injectable()
export class ReleaseVerificationService {
  constructor(private readonly database: DatabaseService) {}

  async overview(
    context: TenantContext
  ): Promise<Record<string, unknown>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const latest = await client.query<{
        component_code: string;
        verification_kind: string;
        target_version: string;
        outcome: string;
        evidence_reference: string;
        executed_at: Date;
        executed_by_membership_id: string;
      }>(
        `SELECT DISTINCT ON (component_code,verification_kind)
           component_code,verification_kind,target_version,outcome,
           evidence_reference,executed_at,executed_by_membership_id
         FROM release_verification_record
         WHERE tenant_id=$1
         ORDER BY component_code,verification_kind,executed_at DESC`,
        [context.tenantId]
      );

      const rows = latest.rows.map((row) => ({
        component: row.component_code,
        kind: row.verification_kind,
        targetVersion: row.target_version,
        outcome: row.outcome,
        evidenceReference: row.evidence_reference,
        executedAt: row.executed_at.toISOString(),
        executedByMembershipId: row.executed_by_membership_id
      }));

      const failCount = rows.filter(
        (row) => row.outcome === "FAIL" || row.outcome === "BLOCKED"
      ).length;

      const coreMandatory = [
        ["CORE","MIGRATIONS"],
        ["CORE","TYPECHECK"],
        ["CORE","TESTS"],
        ["CORE","BUILD"],
        ["CORE","SECURITY"],
        ["API","INTEGRATION"],
        ["API","BROWSER_SMOKE"],
        ["CORE","RESTORE"],
        ["FINANCE","RECONCILIATION"],
        ["ACCOUNTING","RECONCILIATION"],
        ["WMS","RECONCILIATION"]
      ];

      const map = new Map(
        rows.map((row) => [row.component + ":" + row.kind, row])
      );

      const missing = coreMandatory
        .filter(([component, kind]) => !map.has(component + ":" + kind))
        .map(([component, kind]) => ({ component, kind }));

      const staleBefore = Date.now() - 30 * 86400000;
      const stale = rows
        .filter((row) => new Date(row.executedAt).getTime() < staleBefore)
        .map((row) => ({
          component: row.component,
          kind: row.kind,
          executedAt: row.executedAt
        }));

      return {
        ready:
          failCount === 0 &&
          missing.length === 0 &&
          stale.length === 0,
        summary: {
          evidence: rows.length,
          failing: failCount,
          missing: missing.length,
          stale: stale.length
        },
        mandatoryMissing: missing,
        stale,
        latest: rows
      };
    });
  }

  async record(
    context: TenantContext,
    input: {
      component: string;
      targetVersion: string;
      kind: string;
      outcome: string;
      evidenceReference: string;
    }
  ): Promise<{ id: string }> {
    const component = String(input.component ?? "").trim().toUpperCase();
    const kind = String(input.kind ?? "").trim().toUpperCase();
    const outcome = String(input.outcome ?? "").trim().toUpperCase();
    const targetVersion = String(input.targetVersion ?? "").trim();
    const evidence = String(input.evidenceReference ?? "").trim();

    if (!COMPONENTS.has(component)) {
      throw new BadRequestException("Неизвестный компонент проверки");
    }
    if (!KINDS.has(kind)) {
      throw new BadRequestException("Неизвестный тип проверки");
    }
    if (!OUTCOMES.has(outcome)) {
      throw new BadRequestException("Некорректный результат");
    }
    if (targetVersion.length < 1 || targetVersion.length > 200) {
      throw new BadRequestException("Некорректная версия");
    }
    if (evidence.length < 3 || evidence.length > 2000) {
      throw new BadRequestException("Укажите ссылку или описание evidence");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO release_verification_record(
           tenant_id,component_code,target_version,verification_kind,
           outcome,evidence_reference,executed_by_membership_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id`,
        [
          context.tenantId,
          component,
          targetVersion,
          kind,
          outcome,
          evidence,
          context.membershipId
        ]
      );

      return result.rows[0]!;
    });
  }
}
