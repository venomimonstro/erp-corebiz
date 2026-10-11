import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import type { TenantContext } from "@corebiz/contracts";
import { generateToken, hashToken } from "../auth/auth.utils";

@Injectable()
export class TenantsService {
  constructor(private readonly database: DatabaseService) {}

  private async requireManageAll(client:import("pg").PoolClient,
    context:TenantContext):Promise<void>{
    const ok=await client.query(
      `SELECT 1 FROM tenant_membership tm
       JOIN membership_role mr ON mr.tenant_id=tm.tenant_id
         AND mr.membership_id=tm.id
       JOIN role_permission rp ON rp.tenant_id=mr.tenant_id
         AND rp.role_id=mr.role_id
       WHERE tm.tenant_id=$1 AND tm.id=$2 AND tm.user_id=$3
         AND tm.status='ACTIVE'
         AND rp.permission_code IN ('*','users.manage')
         AND rp.scope='all' LIMIT 1`,
      [context.tenantId,context.membershipId,context.userId]);
    if(!ok.rowCount)throw new BadRequestException(
      "Приглашать сотрудников может только руководитель с правом управления всей компанией"
    );
  }

  async createTenant(
    userId: string,
    companyName: string
  ): Promise<{ tenantId: string; membershipId: string; tenantName: string }> {
    const name = companyName.trim();
    if (name.length < 2 || name.length > 160) {
      throw new BadRequestException("Некорректное название компании");
    }

    return this.database.withTransaction(async (client) => {
      const slug = `company-${generateToken().slice(0, 10).toLowerCase()}`;

      const tenantResult = await client.query<{ id: string; name: string }>(
        `INSERT INTO tenant(name, slug)
         VALUES ($1, $2)
         RETURNING id, name`,
        [name, slug]
      );

      const tenant = tenantResult.rows[0];
      if (!tenant) throw new Error("TENANT_CREATE_FAILED");

      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.id]);

      const membershipResult = await client.query<{ id: string }>(
        `INSERT INTO tenant_membership(tenant_id, user_id, status, is_owner)
         VALUES ($1, $2, 'ACTIVE', true)
         RETURNING id`,
        [tenant.id, userId]
      );

      const membership = membershipResult.rows[0];
      if (!membership) throw new Error("MEMBERSHIP_CREATE_FAILED");

      await client.query(
        `INSERT INTO audit_event(
           tenant_id, actor_user_id, actor_membership_id,
           action, resource_type, resource_id
         ) VALUES ($1, $2, $3, 'tenant.created', 'tenant', $1::text)`,
        [tenant.id, userId, membership.id]
      );

      return {
        tenantId: tenant.id,
        membershipId: membership.id,
        tenantName: tenant.name
      };
    });
  }

  async createInvitation(
    context: TenantContext,
    emailInput: string,
    roleId?: string
  ): Promise<{ invitationId: string; token: string; expiresAt: string }> {
    if (typeof emailInput!=="string" || emailInput.length>254)
      throw new BadRequestException("Некорректный email");
    const email = emailInput.trim().toLowerCase();
    if(roleId!==undefined &&
      (typeof roleId!=="string" ||
      !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(roleId)))
      throw new BadRequestException("Некорректная роль");

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException("Некорректный email");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      await this.requireManageAll(client,context);
      const existing = await client.query(
        `SELECT 1
         FROM tenant_membership m
         JOIN app_user u ON u.id = m.user_id
         WHERE m.tenant_id = $1
           AND lower(u.email) = lower($2)
           AND m.status IN ('INVITED', 'ACTIVE')
         LIMIT 1`,
        [context.tenantId, email]
      );

      if (existing.rowCount) {
        throw new ConflictException("Пользователь уже состоит в компании");
      }

      if(roleId){
        const chosen=await client.query<{code:string}>(
          `SELECT code FROM tenant_role
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId,roleId]);
        if(!chosen.rows[0] || chosen.rows[0].code==="OWNER")
          throw new BadRequestException("Нельзя назначить владельца по ссылке");
        const manager=await client.query<{is_owner:boolean}>(
          `SELECT tm.is_owner FROM tenant_membership tm
           JOIN membership_role mr ON mr.tenant_id=tm.tenant_id
             AND mr.membership_id=tm.id
           JOIN role_permission rp ON rp.tenant_id=mr.tenant_id
             AND rp.role_id=mr.role_id
           WHERE tm.tenant_id=$1 AND tm.id=$2 AND tm.user_id=$3
             AND tm.status='ACTIVE' AND rp.permission_code IN ('*','roles.manage')
             AND rp.scope='all' LIMIT 1`,
          [context.tenantId,context.membershipId,context.userId]);
        if(!manager.rows[0])throw new BadRequestException(
          "Выбор роли требует права управления ролями"
        );
        if(!manager.rows[0].is_owner){
          const elevated=await client.query(
            `SELECT 1 FROM role_permission target
             WHERE target.tenant_id=$1 AND target.role_id=$2
               AND NOT EXISTS (
                 SELECT 1 FROM membership_role actor_role
                 JOIN role_permission owned ON owned.tenant_id=actor_role.tenant_id
                   AND owned.role_id=actor_role.role_id
                 WHERE actor_role.tenant_id=$1
                   AND actor_role.membership_id=$3
                   AND owned.permission_code IN ('*',target.permission_code)
                   AND (CASE owned.scope WHEN 'all' THEN 4 WHEN 'branch' THEN 3
                          WHEN 'team' THEN 2 WHEN 'own' THEN 1 ELSE 0 END)
                       >= (CASE target.scope WHEN 'all' THEN 4 WHEN 'branch' THEN 3
                          WHEN 'team' THEN 2 WHEN 'own' THEN 1 ELSE 0 END)
               ) LIMIT 1`,
            [context.tenantId,roleId,context.membershipId]);
          if(elevated.rowCount)throw new BadRequestException(
            "Нельзя делегировать права выше своих"
          );
        }
      }

      await client.query(
        `UPDATE tenant_invitation
         SET status = 'REVOKED'
         WHERE tenant_id = $1
           AND lower(email) = lower($2)
           AND status = 'PENDING'`,
        [context.tenantId, email]
      );

      const token = generateToken();
      const result = await client.query<{
        id: string;
        expires_at: Date;
      }>(
        `INSERT INTO tenant_invitation(
           tenant_id, email, token_hash, invited_by_user_id, expires_at, role_id
         ) VALUES ($1, $2, $3, $4, now() + interval '7 days', $5)
         RETURNING id, expires_at`,
        [context.tenantId, email, hashToken(token), context.userId, roleId??null]
      );

      const invitation = result.rows[0];
      if (!invitation) throw new Error("INVITATION_CREATE_FAILED");

      await client.query(
        `INSERT INTO audit_event(
           tenant_id, actor_user_id, actor_membership_id,
           action, resource_type, resource_id, after_data
         ) VALUES ($1, $2, $3, 'membership.invited', 'tenant_invitation', $4, $5)`,
        [
          context.tenantId,
          context.userId,
          context.membershipId,
          invitation.id,
          JSON.stringify({ email, roleId:roleId??null })
        ]
      );

      return {
        invitationId: invitation.id,
        token,
        expiresAt: invitation.expires_at.toISOString()
      };
    });
  }

  async invitations(context:TenantContext){
    return this.database.withTenantTransaction(context,async client=>{
      await this.requireManageAll(client,context);
      const result=await client.query(
        `SELECT i.id,i.email,
           CASE WHEN i.status='PENDING' AND i.expires_at<=now()
             THEN 'EXPIRED' ELSE i.status END AS status,
           i.expires_at,i.created_at,
           r.name AS role_name,r.code AS role_code
         FROM tenant_invitation i
         LEFT JOIN tenant_role r ON r.tenant_id=i.tenant_id AND r.id=i.role_id
         WHERE i.tenant_id=$1 ORDER BY i.created_at DESC LIMIT 100`,
        [context.tenantId]);
      return result.rows;
    });
  }

  async team(context:TenantContext){
    return this.database.withTenantTransaction(context,async client=>{
      await this.requireManageAll(client,context);
      const result=await client.query(
        `SELECT m.id AS membership_id,u.email,m.status,m.is_owner,
            coalesce(json_agg(json_build_object('id',r.id,'code',r.code,'name',r.name))
              FILTER (WHERE r.id IS NOT NULL),'[]'::json) AS roles
         FROM tenant_membership m
         JOIN app_user u ON u.id=m.user_id
         LEFT JOIN membership_role mr ON mr.tenant_id=m.tenant_id
           AND mr.membership_id=m.id
         LEFT JOIN tenant_role r ON r.tenant_id=mr.tenant_id AND r.id=mr.role_id
         WHERE m.tenant_id=$1
         GROUP BY m.id,u.id ORDER BY m.is_owner DESC,u.email LIMIT 200`,
        [context.tenantId]);
      return result.rows;
    });
  }

  async revokeInvitation(context:TenantContext,id:string){
    if(!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id))
      throw new BadRequestException("Некорректный идентификатор");
    return this.database.withTenantTransaction(context,async client=>{
      await this.requireManageAll(client,context);
      const r=await client.query(
        `UPDATE tenant_invitation SET status='REVOKED'
         WHERE tenant_id=$1 AND id=$2 AND status='PENDING'
         RETURNING id`,
        [context.tenantId,id]);
      if(!r.rowCount)throw new NotFoundException("Активное приглашение не найдено");
      await client.query(
        `INSERT INTO audit_event(
          tenant_id,actor_user_id,actor_membership_id,
          action,resource_type,resource_id
        ) VALUES($1,$2,$3,'membership.invitation_revoked','tenant_invitation',$4)`,
        [context.tenantId,context.userId,context.membershipId,id]);
      return {revoked:true};
    });
  }

  async acceptInvitation(
    userId: string,
    userEmail: string,
    token: string
  ): Promise<{ tenantId: string; membershipId: string }> {
    // The SECURITY DEFINER function checks the invitation's email against
    // the database user record and locks the token until consumption.
    // userEmail is retained for the existing service interface.
    void userEmail;
    const result = await this.database.query<{
      tenant_id: string;
      membership_id: string;
    }>("SELECT * FROM public.corebiz_auth_accept_invitation($1::uuid, $2)", [
      userId,
      hashToken(token)
    ]);
    const accepted = result.rows[0];
    if (!accepted) {
      throw new NotFoundException("Приглашение недействительно или истекло");
    }
    return { tenantId: accepted.tenant_id, membershipId: accepted.membership_id };
  }

}
