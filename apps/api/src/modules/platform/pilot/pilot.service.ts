import {
  BadRequestException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { GoLiveService } from "../go-live/go-live.service";

type PilotStatus =
  | "PLANNED"
  | "READY"
  | "RUNNING"
  | "PAUSED"
  | "COMPLETED"
  | "STOPPED";

@Injectable()
export class PilotService {
  constructor(
    private readonly database: DatabaseService,
    private readonly goLive: GoLiveService
  ) {}

  async overview(context: TenantContext): Promise<Record<string, unknown>> {
    const readiness = await this.goLive.readiness(context) as any;
    const hypercare = await this.goLive.hypercare(context) as any;

    return this.database.withTenantTransaction(context, async (client) => {
      const enrollment = await client.query(
        `SELECT
           p.*,
           rc.target_version,
           rc.status AS release_status,
           owner_user.email AS pilot_owner_email
         FROM tenant_pilot_enrollment p
         LEFT JOIN release_candidate rc
           ON rc.tenant_id=p.tenant_id AND rc.id=p.release_candidate_id
         LEFT JOIN tenant_membership owner_m
           ON owner_m.tenant_id=p.tenant_id
          AND owner_m.id=p.pilot_owner_membership_id
         LEFT JOIN app_user owner_user
           ON owner_user.id=owner_m.user_id
         WHERE p.tenant_id=$1
         LIMIT 1`,
        [context.tenantId]
      );

      const row = enrollment.rows[0] ?? null;

      const incidents = row
        ? await client.query(
            `SELECT
               id,severity,code,summary,status,resolution_note,
               opened_at,resolved_at,updated_at
             FROM tenant_pilot_incident
             WHERE tenant_id=$1
               AND pilot_enrollment_id=$2
             ORDER BY
               CASE severity
                 WHEN 'P0' THEN 0 WHEN 'P1' THEN 1
                 WHEN 'P2' THEN 2 ELSE 3
               END,
               opened_at DESC
             LIMIT 200`,
            [context.tenantId, row.id]
          )
        : { rows: [] };

      const history = row
        ? await client.query(
            `SELECT
               id,from_status,to_status,reason,snapshot,
               actor_membership_id,created_at
             FROM tenant_pilot_status_event
             WHERE tenant_id=$1
               AND pilot_enrollment_id=$2
             ORDER BY created_at DESC
             LIMIT 100`,
            [context.tenantId, row.id]
          )
        : { rows: [] };

      const snapshots = row
        ? await client.query(
            `SELECT
               id,stage,health,metrics,blockers,warnings,captured_at
             FROM tenant_hypercare_snapshot
             WHERE tenant_id=$1
               AND pilot_enrollment_id=$2
             ORDER BY captured_at DESC
             LIMIT 30`,
            [context.tenantId, row.id]
          )
        : { rows: [] };

      const approved = await client.query<{
        id: string;
        target_version: string;
        reviewed_at: Date | null;
      }>(
        `SELECT id,target_version,reviewed_at
         FROM release_candidate
         WHERE tenant_id=$1 AND status='APPROVED'
         ORDER BY reviewed_at DESC NULLS LAST
         LIMIT 1`,
        [context.tenantId]
      );

      const openP0 = incidents.rows.filter(
        (incident: any) =>
          incident.severity === "P0" &&
          incident.status !== "RESOLVED"
      ).length;

      const latestSnapshot = snapshots.rows[0] ?? null;
      const snapshotFresh =
        Boolean(latestSnapshot) &&
        new Date(latestSnapshot.captured_at).getTime() >=
          Date.now() - 24 * 3600000;

      return {
        enrollment: row,
        approvedRelease: approved.rows[0]
          ? {
              id: approved.rows[0].id,
              targetVersion: approved.rows[0].target_version,
              reviewedAt:
                approved.rows[0].reviewed_at?.toISOString() ?? null
            }
          : null,
        prerequisites: {
          releaseApproved: Boolean(approved.rows[0]),
          tenantReady: readiness.ready === true,
          launchStage: readiness.stage,
          formalGo:
            readiness.stage === "HYPERCARE" ||
            readiness.stage === "LIVE",
          latestHypercareGreen:
            latestSnapshot?.health === "GREEN" && snapshotFresh,
          openP0
        },
        currentHypercare: hypercare,
        incidents: incidents.rows,
        history: history.rows,
        snapshots: snapshots.rows
      };
    });
  }

  async enroll(
    context: TenantContext,
    input: {
      cohortCode: string;
      targetEndAt?: string;
    }
  ): Promise<{ id: string; status: PilotStatus }> {
    const cohort = String(input.cohortCode ?? "").trim();
    if (cohort.length < 2 || cohort.length > 80) {
      throw new BadRequestException("Некорректный код pilot cohort");
    }

    const targetEnd = input.targetEndAt
      ? new Date(input.targetEndAt)
      : new Date(Date.now() + 30 * 86400000);

    if (Number.isNaN(targetEnd.getTime()) || targetEnd <= new Date()) {
      throw new BadRequestException("Некорректная дата завершения pilot");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const profile = await client.query<{ profile_code: string }>(
        `SELECT profile_code
         FROM tenant_business_profile
         WHERE tenant_id=$1`,
        [context.tenantId]
      );

      const approved = await client.query<{ id: string }>(
        `SELECT id
         FROM release_candidate
         WHERE tenant_id=$1 AND status='APPROVED'
         ORDER BY reviewed_at DESC NULLS LAST
         LIMIT 1`,
        [context.tenantId]
      );

      const result = await client.query<{
        id: string;
        status: PilotStatus;
      }>(
        `INSERT INTO tenant_pilot_enrollment(
           tenant_id,cohort_code,status,profile_snapshot,
           release_candidate_id,pilot_owner_membership_id,
           planned_start_at,target_end_at,success_criteria,
           created_by_membership_id
         ) VALUES ($1,$2,'PLANNED',$3,$4,$5,now(),$6,$7,$5)
         ON CONFLICT (tenant_id) DO UPDATE SET
           cohort_code=EXCLUDED.cohort_code,
           target_end_at=EXCLUDED.target_end_at,
           pilot_owner_membership_id=EXCLUDED.pilot_owner_membership_id,
           updated_at=now()
         RETURNING id,status`,
        [
          context.tenantId,
          cohort,
          profile.rows[0]?.profile_code ?? "GENERAL",
          approved.rows[0]?.id ?? null,
          context.membershipId,
          targetEnd,
          JSON.stringify({
            noOpenP0: true,
            freshGreenHypercareHours: 24,
            tenantReadiness: true
          })
        ]
      );

      const row = result.rows[0]!;
      await this.ensureInitialEvent(
        client,
        context,
        row.id,
        row.status
      );

      return row;
    });
  }

  async transition(
    context: TenantContext,
    toStatus: PilotStatus,
    reason?: string
  ): Promise<{ status: PilotStatus }> {
    const overview = await this.overview(context) as any;
    const enrollment = overview.enrollment;
    if (!enrollment) {
      throw new NotFoundException("Pilot enrollment не создан");
    }

    const fromStatus = enrollment.status as PilotStatus;
    if (fromStatus === toStatus) return { status: toStatus };

    const allowed: Record<PilotStatus, PilotStatus[]> = {
      PLANNED: ["READY","STOPPED"],
      READY: ["RUNNING","STOPPED"],
      RUNNING: ["PAUSED","COMPLETED","STOPPED"],
      PAUSED: ["RUNNING","STOPPED"],
      COMPLETED: [],
      STOPPED: []
    };

    if (!allowed[fromStatus].includes(toStatus)) {
      throw new BadRequestException(
        "Недопустимый переход pilot: " +
          fromStatus +
          " → " +
          toStatus
      );
    }

    if (
      ["PAUSED","STOPPED"].includes(toStatus) &&
      !String(reason ?? "").trim()
    ) {
      throw new BadRequestException(
        "Для PAUSED/STOPPED требуется причина"
      );
    }

    if (toStatus === "READY") {
      if (!overview.prerequisites.releaseApproved) {
        throw new BadRequestException(
          "Pilot READY требует APPROVED release candidate"
        );
      }
      if (!overview.prerequisites.tenantReady) {
        throw new BadRequestException(
          "Pilot READY требует tenant readiness без blockers"
        );
      }
    }

    if (toStatus === "RUNNING") {
      if (!overview.prerequisites.releaseApproved) {
        throw new BadRequestException(
          "Pilot RUNNING требует APPROVED release candidate"
        );
      }
      if (!overview.prerequisites.tenantReady) {
        throw new BadRequestException(
          "Pilot RUNNING требует tenant readiness"
        );
      }
      if (!overview.prerequisites.formalGo) {
        throw new BadRequestException(
          "Сначала примите формальное GO в Go-Live Center"
        );
      }
      if (overview.prerequisites.openP0 > 0) {
        throw new BadRequestException(
          "Нельзя запустить pilot при открытом P0"
        );
      }
    }

    if (toStatus === "COMPLETED") {
      if (!overview.prerequisites.tenantReady) {
        throw new BadRequestException(
          "Pilot completion требует READY tenant"
        );
      }
      if (!overview.prerequisites.latestHypercareGreen) {
        throw new BadRequestException(
          "Pilot completion требует GREEN snapshot не старше 24 часов"
        );
      }
      if (overview.prerequisites.openP0 > 0) {
        throw new BadRequestException(
          "Pilot completion заблокирован открытым P0"
        );
      }
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const approved = await client.query<{ id: string }>(
        `SELECT id FROM release_candidate
         WHERE tenant_id=$1 AND status='APPROVED'
         ORDER BY reviewed_at DESC NULLS LAST LIMIT 1`,
        [context.tenantId]
      );

      const result = await client.query<{ status: PilotStatus }>(
        `UPDATE tenant_pilot_enrollment
         SET status=$3,
             release_candidate_id=COALESCE($4,release_candidate_id),
             started_at=CASE
               WHEN $3='RUNNING' THEN COALESCE(started_at,now())
               ELSE started_at
             END,
             paused_at=CASE WHEN $3='PAUSED' THEN now() ELSE paused_at END,
             stopped_at=CASE WHEN $3='STOPPED' THEN now() ELSE stopped_at END,
             completed_at=CASE WHEN $3='COMPLETED' THEN now() ELSE completed_at END,
             stop_reason=CASE
               WHEN $3 IN ('PAUSED','STOPPED') THEN $5
               ELSE stop_reason
             END,
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND status=$6
         RETURNING status`,
        [
          context.tenantId,
          enrollment.id,
          toStatus,
          approved.rows[0]?.id ?? null,
          String(reason ?? "").trim() || null,
          fromStatus
        ]
      );

      const updated = result.rows[0];
      if (!updated) {
        throw new BadRequestException(
          "Pilot status изменился конкурентно. Обновите страницу."
        );
      }

      await client.query(
        `INSERT INTO tenant_pilot_status_event(
           tenant_id,pilot_enrollment_id,from_status,to_status,
           reason,snapshot,actor_membership_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          context.tenantId,
          enrollment.id,
          fromStatus,
          toStatus,
          String(reason ?? "").trim() || null,
          JSON.stringify({
            prerequisites: overview.prerequisites,
            launchStage: overview.prerequisites.launchStage
          }),
          context.membershipId
        ]
      );

      return updated;
    });
  }

  async captureSnapshot(
    context: TenantContext
  ): Promise<Record<string, unknown>> {
    const captured = await this.goLive.captureHypercare(context);

    return this.database.withTenantTransaction(context, async (client) => {
      const enrollment = await client.query<{ id: string }>(
        `SELECT id FROM tenant_pilot_enrollment
         WHERE tenant_id=$1
         LIMIT 1`,
        [context.tenantId]
      );
      const row = enrollment.rows[0];
      if (!row) throw new NotFoundException("Pilot enrollment не создан");

      const snapshot = await client.query(
        `UPDATE tenant_hypercare_snapshot
         SET pilot_enrollment_id=$3
         WHERE tenant_id=$1 AND id=$2
         RETURNING id,stage,health,metrics,blockers,warnings,captured_at`,
        [context.tenantId, captured.id, row.id]
      );

      const latest = snapshot.rows[0];
      if (!latest) {
        throw new BadRequestException(
          "Созданный hypercare snapshot не найден"
        );
      }

      return {
        ...latest,
        pilotEnrollmentId: row.id
      };
    });
  }

  async openIncident(
    context: TenantContext,
    input: {
      severity: "P0" | "P1" | "P2" | "P3";
      code: string;
      summary: string;
    }
  ): Promise<{ id: string }> {
    const code = String(input.code ?? "").trim().toUpperCase();
    const summary = String(input.summary ?? "").trim();
    if (!["P0","P1","P2","P3"].includes(input.severity)) {
      throw new BadRequestException("Некорректная severity");
    }
    if (code.length < 2 || code.length > 100) {
      throw new BadRequestException("Некорректный incident code");
    }
    if (summary.length < 3 || summary.length > 500) {
      throw new BadRequestException("Некорректное описание incident");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const enrollment = await client.query<{ id: string; status: string }>(
        `SELECT id,status
         FROM tenant_pilot_enrollment
         WHERE tenant_id=$1 FOR UPDATE`,
        [context.tenantId]
      );
      const pilot = enrollment.rows[0];
      if (!pilot) throw new NotFoundException("Pilot enrollment не создан");

      const result = await client.query<{ id: string }>(
        `INSERT INTO tenant_pilot_incident(
           tenant_id,pilot_enrollment_id,severity,code,summary,
           opened_by_membership_id
         ) VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id`,
        [
          context.tenantId,
          pilot.id,
          input.severity,
          code,
          summary,
          context.membershipId
        ]
      );

      if (input.severity === "P0" && pilot.status === "RUNNING") {
        await client.query(
          `UPDATE tenant_pilot_enrollment
           SET status='PAUSED',
               paused_at=now(),
               stop_reason=$3,
               updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [
            context.tenantId,
            pilot.id,
            "AUTO_PAUSE_P0: " + code
          ]
        );

        await client.query(
          `INSERT INTO tenant_pilot_status_event(
             tenant_id,pilot_enrollment_id,from_status,to_status,
             reason,snapshot,actor_membership_id
           ) VALUES ($1,$2,'RUNNING','PAUSED',$3,$4,$5)`,
          [
            context.tenantId,
            pilot.id,
            "Открыт P0 incident: " + code,
            JSON.stringify({ incidentId: result.rows[0]!.id }),
            context.membershipId
          ]
        );
      }

      return result.rows[0]!;
    });
  }

  async resolveIncident(
    context: TenantContext,
    incidentId: string,
    resolutionNote: string
  ): Promise<void> {
    const note = String(resolutionNote ?? "").trim();
    if (note.length < 3 || note.length > 2000) {
      throw new BadRequestException("Укажите результат решения incident");
    }

    await this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `UPDATE tenant_pilot_incident
         SET status='RESOLVED',
             resolution_note=$3,
             resolved_by_membership_id=$4,
             resolved_at=now(),
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND status<>'RESOLVED'
         RETURNING id`,
        [
          context.tenantId,
          incidentId,
          note,
          context.membershipId
        ]
      );
      if (!result.rowCount) {
        throw new NotFoundException("Открытый incident не найден");
      }
    });
  }

  private async ensureInitialEvent(
    client: import("pg").PoolClient,
    context: TenantContext,
    pilotId: string,
    status: PilotStatus
  ): Promise<void> {
    await client.query(
      `INSERT INTO tenant_pilot_status_event(
         tenant_id,pilot_enrollment_id,from_status,to_status,
         reason,snapshot,actor_membership_id
       )
       SELECT $1,$2,NULL,$3,'Pilot enrollment created','{}'::jsonb,$4
       WHERE NOT EXISTS (
         SELECT 1 FROM tenant_pilot_status_event
         WHERE tenant_id=$1 AND pilot_enrollment_id=$2
       )`,
      [context.tenantId, pilotId, status, context.membershipId]
    );
  }
}
