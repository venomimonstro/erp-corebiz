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
    emailInput: string
  ): Promise<{ invitationId: string; token: string; expiresAt: string }> {
    const email = emailInput.trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException("Некорректный email");
    }

    return this.database.withTenantTransaction(context, async (client) => {
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
           tenant_id, email, token_hash, invited_by_user_id, expires_at
         ) VALUES ($1, $2, $3, $4, now() + interval '7 days')
         RETURNING id, expires_at`,
        [context.tenantId, email, hashToken(token), context.userId]
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
          JSON.stringify({ email })
        ]
      );

      return {
        invitationId: invitation.id,
        token,
        expiresAt: invitation.expires_at.toISOString()
      };
    });
  }

  async acceptInvitation(
    userId: string,
    userEmail: string,
    token: string
  ): Promise<{ tenantId: string; membershipId: string }> {
    const tokenHash = hashToken(token);

    return this.database.withTransaction(async (client) => {
      const inviteResult = await client.query<{
        id: string;
        tenant_id: string;
        email: string;
      }>(
        `SELECT id, tenant_id, email
         FROM tenant_invitation
         WHERE token_hash = $1
           AND status = 'PENDING'
           AND expires_at > now()
         FOR UPDATE`,
        [tokenHash]
      );

      const invite = inviteResult.rows[0];
      if (!invite) {
        throw new NotFoundException("Приглашение недействительно или истекло");
      }

      if (invite.email.toLowerCase() !== userEmail.toLowerCase()) {
        throw new BadRequestException("Приглашение предназначено для другого email");
      }

      const membershipResult = await client.query<{ id: string }>(
        `INSERT INTO tenant_membership(tenant_id, user_id, status, is_owner)
         VALUES ($1, $2, 'ACTIVE', false)
         ON CONFLICT (tenant_id, user_id)
         DO UPDATE SET status = 'ACTIVE'
         RETURNING id`,
        [invite.tenant_id, userId]
      );

      const membership = membershipResult.rows[0];
      if (!membership) throw new Error("MEMBERSHIP_ACCEPT_FAILED");

      await client.query(
        `UPDATE tenant_invitation
         SET status = 'ACCEPTED', accepted_at = now()
         WHERE id = $1`,
        [invite.id]
      );

      await client.query(
        `INSERT INTO audit_event(
           tenant_id, actor_user_id, actor_membership_id,
           action, resource_type, resource_id
         ) VALUES ($1, $2, $3, 'membership.accepted', 'tenant_membership', $3::text)`,
        [invite.tenant_id, userId, membership.id]
      );

      return {
        tenantId: invite.tenant_id,
        membershipId: membership.id
      };
    });
  }
}
