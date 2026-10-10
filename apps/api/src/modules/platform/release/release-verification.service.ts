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
  "STABILITY","PERFORMANCE","INTEGRATION","BROWSER_SMOKE",
  "RESTORE","RECONCILIATION","RUNTIME_RLS",
  "BUSINESS_JOURNEYS","NOISY_NEIGHBOR"
]);

const OUTCOMES = new Set(["PASS","FAIL","BLOCKED"]);

@Injectable()
export class ReleaseVerificationService {
  constructor(private readonly database: DatabaseService) {}

  async overview(
    context: TenantContext
  ): Promise<Record<string, unknown>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const approvedCandidate = await client.query<{
        id: string;
        target_version: string;
        reviewed_at: Date | null;
        verdict_snapshot: {
          readyForApproval?: boolean;
          evaluatedAt?: string;
        };
      }>(
        `SELECT id,target_version,reviewed_at,verdict_snapshot
         FROM release_candidate
         WHERE tenant_id=$1
           AND status='APPROVED'
         ORDER BY reviewed_at DESC NULLS LAST,created_at DESC
         LIMIT 1`,
        [context.tenantId]
      );

      const latestCandidate = await client.query<{
        id: string;
        target_version: string;
        status: string;
        verdict_snapshot: {
          readyForApproval?: boolean;
          evaluatedAt?: string;
        };
        created_at: Date;
      }>(
        `SELECT id,target_version,status,verdict_snapshot,created_at
         FROM release_candidate
         WHERE tenant_id=$1
           AND status <> 'SUPERSEDED'
         ORDER BY created_at DESC
         LIMIT 1`,
        [context.tenantId]
      );

      const approved = approvedCandidate.rows[0] ?? null;
      const active = latestCandidate.rows[0] ?? approved;
      const targetVersion = active?.target_version ?? null;

      const latest = targetVersion
        ? await client.query<{
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
               AND target_version=$2
             ORDER BY component_code,verification_kind,executed_at DESC`,
            [context.tenantId, targetVersion]
          )
        : { rows: [] as Array<{
            component_code: string;
            verification_kind: string;
            target_version: string;
            outcome: string;
            evidence_reference: string;
            executed_at: Date;
            executed_by_membership_id: string;
          }> };

      const rows = latest.rows.map((row) => ({
        component: row.component_code,
        kind: row.verification_kind,
        targetVersion: row.target_version,
        outcome: row.outcome,
        evidenceReference: row.evidence_reference,
        executedAt: row.executed_at.toISOString(),
        executedByMembershipId: row.executed_by_membership_id
      }));

      const mandatory = this.mandatoryMatrix();
      const map = new Map(
        rows.map((row) => [row.component + ":" + row.kind, row])
      );

      const missing = mandatory
        .filter(([component, kind]) => !map.has(component + ":" + kind))
        .map(([component, kind]) => ({
          component,
          kind,
          ...this.remediation(component, kind)
        }));

      const staleBefore = Date.now() - 7 * 86400000;
      const stale = mandatory
        .map(([component, kind]) => map.get(component + ":" + kind))
        .filter((row): row is NonNullable<typeof row> => Boolean(row))
        .filter(
          (row) => new Date(row.executedAt).getTime() < staleBefore
        )
        .map((row) => ({
          component: row.component,
          kind: row.kind,
          executedAt: row.executedAt,
          ...this.remediation(row.component, row.kind)
        }));

      const failing = mandatory
        .map(([component, kind]) => map.get(component + ":" + kind))
        .filter((row): row is NonNullable<typeof row> => Boolean(row))
        .filter((row) => row.outcome !== "PASS")
        .map((row) => ({
          component: row.component,
          kind: row.kind,
          outcome: row.outcome,
          evidenceReference: row.evidenceReference,
          ...this.remediation(row.component, row.kind)
        }));

      const evidenceHealthy =
        Boolean(targetVersion) &&
        missing.length === 0 &&
        stale.length === 0 &&
        failing.length === 0;

      const approvedMatchesTarget =
        Boolean(approved) &&
        approved?.target_version === targetVersion &&
        approved?.verdict_snapshot?.readyForApproval === true;

      return {
        ready: evidenceHealthy && approvedMatchesTarget,
        evidenceHealthy,
        targetVersion,
        activeCandidate: active
          ? {
              id: active.id,
              targetVersion: active.target_version,
              status: "status" in active ? active.status : "APPROVED",
              evaluatedAt:
                active.verdict_snapshot?.evaluatedAt ?? null
            }
          : null,
        approvedCandidate: approved
          ? {
              id: approved.id,
              targetVersion: approved.target_version,
              reviewedAt: approved.reviewed_at?.toISOString() ?? null,
              evaluatedAt:
                approved.verdict_snapshot?.evaluatedAt ?? null
            }
          : null,
        summary: {
          evidence: rows.length,
          mandatory: mandatory.length,
          failing: failing.length,
          missing: missing.length,
          stale: stale.length,
          blockers: missing.length + stale.length + failing.length
        },
        blockers: [
          ...missing.map((item) => ({
            type: "MISSING",
            ...item
          })),
          ...stale.map((item) => ({
            type: "STALE",
            ...item
          })),
          ...failing.map((item) => ({
            type: "FAILING",
            ...item
          }))
        ],
        mandatoryMissing: missing,
        stale,
        failing,
        latest: rows
      };
    });
  }

  private mandatoryMatrix(): Array<[string, string]> {
    return [
      ["CORE","MIGRATIONS"],
      ["CORE","TYPECHECK"],
      ["CORE","TESTS"],
      ["CORE","BUILD"],
      ["CORE","SECURITY"],
      ["CORE","STABILITY"],
      ["CORE","PERFORMANCE"],
      ["CORE","RESTORE"],
      ["CORE","NOISY_NEIGHBOR"],
      ["AUTH","RUNTIME_RLS"],
      ["API","INTEGRATION"],
      ["API","BUSINESS_JOURNEYS"],
      ["API","BROWSER_SMOKE"],
      ["FINANCE","RECONCILIATION"],
      ["ACCOUNTING","RECONCILIATION"],
      ["WMS","RECONCILIATION"]
    ];
  }

  private remediation(
    component: string,
    kind: string
  ): {
    href: string;
    action: string;
    command?: string;
  } {
    const key = component + ":" + kind;
    const map: Record<
      string,
      { href: string; action: string; command?: string }
    > = {
      "CORE:MIGRATIONS": {
        href: "/app/settings/release",
        action: "Повторить replay всех миграций на чистой disposable PostgreSQL.",
        command:
          "COREBIZ_CONFIRM_DISPOSABLE_DB=YES COREBIZ_DISPOSABLE_DATABASE_URL=... pnpm release:gate"
      },
      "CORE:TYPECHECK": {
        href: "/app/settings/release",
        action: "Исправить TypeScript ошибки и повторить typecheck.",
        command: "pnpm typecheck"
      },
      "CORE:TESTS": {
        href: "/app/settings/release",
        action: "Исправить упавшие unit/integration tests.",
        command: "pnpm test"
      },
      "CORE:BUILD": {
        href: "/app/settings/release",
        action: "Получить чистую production-сборку.",
        command: "pnpm build"
      },
      "CORE:SECURITY": {
        href: "/app/settings/security",
        action:
          "Закрыть security preflight, grants, secret boundaries и критические findings."
      },
      "CORE:STABILITY": {
        href: "/app/settings/release",
        action: "Закрыть source stability blockers.",
        command: "pnpm stability:check"
      },
      "CORE:PERFORMANCE": {
        href: "/app/settings/runtime-pressure",
        action:
          "Записать performance evidence после проверки latency/queue budgets."
      },
      "CORE:NOISY_NEIGHBOR": {
        href: "/app/settings/runtime-pressure",
        action:
          "Проверить concurrency budgets, lease release, 429/retry и отсутствие starvation."
      },
      "AUTH:RUNTIME_RLS": {
        href: "/app/settings/security",
        action:
          "Запустить runtime DB-role/RLS cross-tenant тесты под non-owner NOBYPASSRLS ролью."
      },
      "API:INTEGRATION": {
        href: "/app/settings/release",
        action: "Пройти API integration smoke на целевой версии."
      },
      "API:BUSINESS_JOURNEYS": {
        href: "/app/settings/release",
        action:
          "Пройти Golden Business Journeys для TRADE, ECOMMERCE, SERVICE и WAREHOUSE_3PL.",
        command: "node scripts/golden-business-journeys.mjs"
      },
      "API:BROWSER_SMOKE": {
        href: "/app/settings/release",
        action: "Пройти browser smoke на production-like HTTPS environment."
      },
      "CORE:RESTORE": {
        href: "/app/settings/release",
        action:
          "Выполнить backup/restore drill и подтвердить читаемость восстановленной БД.",
        command: "bash scripts/restore-postgres.sh"
      },
      "FINANCE:RECONCILIATION": {
        href: "/app/finance",
        action: "Закрыть Finance reconciliation и unmatched exceptions."
      },
      "ACCOUNTING:RECONCILIATION": {
        href: "/app/accounting",
        action: "Закрыть Accounting double-entry/VAT/month-close reconciliation."
      },
      "WMS:RECONCILIATION": {
        href: "/app/wms",
        action: "Закрыть WMS inventory/location/owner reconciliation."
      }
    };

    return (
      map[key] ?? {
        href: "/app/settings/release",
        action: "Повторить обязательную проверку и приложить immutable evidence."
      }
    );
  }

  async candidates(
    context: TenantContext
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT
           c.id,c.target_version,c.status,c.verdict_snapshot,
           c.created_by_membership_id,c.reviewed_by_membership_id,
           c.review_reason,c.reviewed_at,c.created_at,c.updated_at
         FROM release_candidate c
         WHERE c.tenant_id=$1
         ORDER BY c.created_at DESC
         LIMIT 100`,
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async createCandidate(
    context: TenantContext,
    targetVersionInput: string
  ): Promise<{ id: string; targetVersion: string }> {
    const targetVersion = String(targetVersionInput ?? "").trim();
    if (targetVersion.length < 1 || targetVersion.length > 200) {
      throw new BadRequestException("Некорректная версия релиза");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const existing = await client.query<{ id: string }>(
        `SELECT id
         FROM release_candidate
         WHERE tenant_id=$1
           AND target_version=$2
           AND status IN ('DRAFT','BLOCKED','READY_FOR_APPROVAL','APPROVED')
         LIMIT 1`,
        [context.tenantId, targetVersion]
      );

      if (existing.rows[0]) {
        return { id: existing.rows[0].id, targetVersion };
      }

      const result = await client.query<{ id: string }>(
        `INSERT INTO release_candidate(
           tenant_id,target_version,created_by_membership_id
         ) VALUES ($1,$2,$3)
         RETURNING id`,
        [context.tenantId, targetVersion, context.membershipId]
      );

      return { id: result.rows[0]!.id, targetVersion };
    });
  }

  async evaluateCandidate(
    context: TenantContext,
    candidateId: string
  ): Promise<Record<string, unknown>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const candidateResult = await client.query<{
        id: string;
        target_version: string;
        status: string;
      }>(
        `SELECT id,target_version,status
         FROM release_candidate
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [context.tenantId, candidateId]
      );

      const candidate = candidateResult.rows[0];
      if (!candidate) {
        throw new BadRequestException("Release candidate не найден");
      }

      if (candidate.status === "APPROVED") {
        throw new BadRequestException(
          "Одобренный release candidate неизменяем"
        );
      }

      const evidence = await client.query<{
        component_code: string;
        verification_kind: string;
        outcome: string;
        evidence_reference: string;
        executed_at: Date;
        executed_by_membership_id: string;
      }>(
        `SELECT DISTINCT ON (component_code,verification_kind)
           component_code,verification_kind,outcome,evidence_reference,
           executed_at,executed_by_membership_id
         FROM release_verification_record
         WHERE tenant_id=$1
           AND target_version=$2
         ORDER BY component_code,verification_kind,executed_at DESC`,
        [context.tenantId, candidate.target_version]
      );

      const rows = evidence.rows.map((row) => ({
        component: row.component_code,
        kind: row.verification_kind,
        outcome: row.outcome,
        evidenceReference: row.evidence_reference,
        executedAt: row.executed_at.toISOString(),
        executedByMembershipId: row.executed_by_membership_id
      }));

      const map = new Map(
        rows.map((row) => [row.component + ":" + row.kind, row])
      );
      const mandatory = this.mandatoryMatrix();
      const missing = mandatory
        .filter(([component, kind]) => !map.has(component + ":" + kind))
        .map(([component, kind]) => ({ component, kind }));

      const staleBefore = Date.now() - 7 * 86400000;
      const stale = mandatory
        .map(([component, kind]) => map.get(component + ":" + kind))
        .filter((row): row is NonNullable<typeof row> => Boolean(row))
        .filter(
          (row) => new Date(row.executedAt).getTime() < staleBefore
        )
        .map((row) => ({
          component: row.component,
          kind: row.kind,
          executedAt: row.executedAt
        }));

      const failing = mandatory
        .map(([component, kind]) => map.get(component + ":" + kind))
        .filter((row): row is NonNullable<typeof row> => Boolean(row))
        .filter((row) => row.outcome !== "PASS")
        .map((row) => ({
          component: row.component,
          kind: row.kind,
          outcome: row.outcome,
          evidenceReference: row.evidenceReference
        }));

      const ready =
        missing.length === 0 &&
        stale.length === 0 &&
        failing.length === 0;

      const verdict = {
        targetVersion: candidate.target_version,
        evaluatedAt: new Date().toISOString(),
        readyForApproval: ready,
        mandatoryChecks: mandatory.length,
        evidenceCount: rows.length,
        missing,
        stale,
        failing,
        blockers: [
          ...missing.map((item) => ({
            type: "MISSING",
            ...item
          })),
          ...stale.map((item) => ({
            type: "STALE",
            ...item
          })),
          ...failing.map((item) => ({
            type: "FAILING",
            ...item
          }))
        ],
        evidence: rows
      };

      await client.query(
        `UPDATE release_candidate
         SET status=$3,
             verdict_snapshot=$4,
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [
          context.tenantId,
          candidate.id,
          ready ? "READY_FOR_APPROVAL" : "BLOCKED",
          JSON.stringify(verdict)
        ]
      );

      return verdict;
    });
  }

  async reviewCandidate(
    context: TenantContext,
    candidateId: string,
    input: {
      decision: "APPROVE" | "REJECT";
      reason?: string;
    }
  ): Promise<{ status: "APPROVED" | "REJECTED" }> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{
        status: string;
        verdict_snapshot: {
          readyForApproval?: boolean;
        };
      }>(
        `SELECT status,verdict_snapshot
         FROM release_candidate
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [context.tenantId, candidateId]
      );

      const row = result.rows[0];
      if (!row) {
        throw new BadRequestException("Release candidate не найден");
      }

      if (row.status === "APPROVED" || row.status === "REJECTED") {
        throw new BadRequestException(
          "Release candidate уже имеет финальное решение"
        );
      }

      const decision = input.decision;
      if (!["APPROVE","REJECT"].includes(decision)) {
        throw new BadRequestException("Некорректное решение");
      }

      if (
        decision === "APPROVE" &&
        (
          row.status !== "READY_FOR_APPROVAL" ||
          row.verdict_snapshot?.readyForApproval !== true
        )
      ) {
        throw new BadRequestException(
          "Кандидат не прошёл обязательные release gates"
        );
      }

      if (decision === "APPROVE") {
        const evaluatedAtRaw =
          row.verdict_snapshot?.evaluatedAt ?? null;
        const evaluatedAt = evaluatedAtRaw
          ? new Date(evaluatedAtRaw)
          : null;

        if (
          !evaluatedAt ||
          Number.isNaN(evaluatedAt.getTime()) ||
          Date.now() - evaluatedAt.getTime() > 4 * 3600000
        ) {
          throw new BadRequestException(
            "Verdict устарел. Выполните повторный evaluate перед approval."
          );
        }

        const candidateMeta = await client.query<{
          target_version: string;
        }>(
          `SELECT target_version
           FROM release_candidate
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId, candidateId]
        );

        const targetVersion = candidateMeta.rows[0]?.target_version;
        if (!targetVersion) {
          throw new BadRequestException("Release candidate не найден");
        }

        const newerEvidence = await client.query<{ exists: boolean }>(
          `SELECT EXISTS(
             SELECT 1
             FROM release_verification_record
             WHERE tenant_id=$1
               AND target_version=$2
               AND executed_at > $3
           ) AS exists`,
          [context.tenantId, targetVersion, evaluatedAt]
        );

        if (newerEvidence.rows[0]?.exists) {
          throw new BadRequestException(
            "После evaluate появилось новое evidence. Пересчитайте verdict."
          );
        }

        await client.query(
          `UPDATE release_candidate
           SET status='SUPERSEDED',updated_at=now()
           WHERE tenant_id=$1
             AND status='APPROVED'
             AND id<>$2`,
          [context.tenantId, candidateId]
        );
      }

      const status =
        decision === "APPROVE" ? "APPROVED" : "REJECTED";

      await client.query(
        `UPDATE release_candidate
         SET status=$3,
             reviewed_by_membership_id=$4,
             review_reason=$5,
             reviewed_at=now(),
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [
          context.tenantId,
          candidateId,
          status,
          context.membershipId,
          String(input.reason ?? "").trim().slice(0, 2000) || null
        ]
      );

      await client.query(
        `INSERT INTO audit_event(
           tenant_id,actor_user_id,actor_membership_id,
           action,resource_type,resource_id,after_data
         ) VALUES ($1,$2,$3,$4,'release_candidate',$5,$6)`,
        [
          context.tenantId,
          context.userId,
          context.membershipId,
          status === "APPROVED"
            ? "release.candidate_approved"
            : "release.candidate_rejected",
          candidateId,
          JSON.stringify({
            status,
            reason: String(input.reason ?? "").trim() || null
          })
        ]
      );

      return { status };
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
