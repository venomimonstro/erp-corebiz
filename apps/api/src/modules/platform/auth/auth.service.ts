import {
  ConflictException,
  Injectable,
  UnauthorizedException,
  BadRequestException
} from "@nestjs/common";
import { hash, verify, argon2id } from "argon2";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import type { AuthenticatedRequest } from "./auth.types";
import { generateToken, hashToken } from "./auth.utils";

type SessionAuth = NonNullable<AuthenticatedRequest["auth"]>;

type RegisterInput = {
  email: string;
  password: string;
  companyName: string;
};

type LoginInput = {
  email: string;
  password: string;
};

@Injectable()
export class AuthService {
  constructor(private readonly database: DatabaseService) {}

  async register(input: RegisterInput): Promise<{
    token: string;
    auth: SessionAuth;
  }> {
    const email = this.normalizeEmail(input.email);
    const companyName = input.companyName.trim();

    if (companyName.length < 2 || companyName.length > 160) {
      throw new BadRequestException("Некорректное название компании");
    }

    this.validatePassword(input.password);

    const passwordHash = await hash(input.password, {
      type: argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1
    });

    try {
      return await this.database.withTransaction(async (client) => {
        const userResult = await client.query<{
          id: string;
          email: string;
        }>(
          `INSERT INTO app_user(email, password_hash)
           VALUES ($1, $2)
           RETURNING id, email`,
          [email, passwordHash]
        );

        const user = userResult.rows[0];
        if (!user) throw new Error("USER_CREATE_FAILED");

        const slug = `company-${generateToken().slice(0, 10).toLowerCase()}`;
        const tenantResult = await client.query<{
          id: string;
          name: string;
        }>(
          `INSERT INTO tenant(name, slug)
           VALUES ($1, $2)
           RETURNING id, name`,
          [companyName, slug]
        );

        const tenant = tenantResult.rows[0];
        if (!tenant) throw new Error("TENANT_CREATE_FAILED");

        // Tenant bootstrap is authorized in the scope of the new tenant only.
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.id]);

        const membershipResult = await client.query<{
          id: string;
        }>(
          `INSERT INTO tenant_membership(tenant_id, user_id, status, is_owner)
           VALUES ($1, $2, 'ACTIVE', true)
           RETURNING id`,
          [tenant.id, user.id]
        );

        const membership = membershipResult.rows[0];
        if (!membership) throw new Error("MEMBERSHIP_CREATE_FAILED");

        const token = generateToken();
        const sessionId = await this.createSession(
          client,
          user.id,
          membership.id,
          token
        );

        await client.query(
          `INSERT INTO audit_event(
             tenant_id, actor_user_id, actor_membership_id,
             action, resource_type, resource_id
           ) VALUES ($1, $2, $3, 'tenant.created', 'tenant', $1::text)`,
          [tenant.id, user.id, membership.id]
        );

        return {
          token,
          auth: {
            sessionId,
            tenantId: tenant.id,
            tenantName: tenant.name,
            userId: user.id,
            membershipId: membership.id,
            email: user.email,
            isOwner: true
          }
        };
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException("Аккаунт с таким email уже существует");
      }
      throw error;
    }
  }

  async login(input: LoginInput): Promise<{
    token: string;
    auth: SessionAuth;
  }> {
    const email = this.normalizeEmail(input.email);

    const result = await this.database.query<{
      id: string;
      email: string;
      password_hash: string | null;
      membership_id: string;
      tenant_id: string;
      tenant_name: string;
      is_owner: boolean;
    }>(
      "SELECT * FROM public.corebiz_auth_login_identity($1)",
      [email]
    );

    const user = result.rows[0];

    if (
      !user?.password_hash ||
      !(await verify(user.password_hash, input.password))
    ) {
      throw new UnauthorizedException("Неверный email или пароль");
    }

    return this.database.withTransaction(async (client) => {
      const token = generateToken();
      const sessionId = await this.createSession(
        client,
        user.id,
        user.membership_id,
        token
      );

      await client.query("SELECT set_config('app.tenant_id', $1, true)", [user.tenant_id]);

      await client.query(
        `INSERT INTO audit_event(
           tenant_id, actor_user_id, actor_membership_id,
           action, resource_type, resource_id
         ) VALUES ($1, $2, $3, 'auth.login', 'session', $4)`,
        [user.tenant_id, user.id, user.membership_id, sessionId]
      );

      return {
        token,
        auth: {
          sessionId,
          tenantId: user.tenant_id,
          tenantName: user.tenant_name,
          userId: user.id,
          membershipId: user.membership_id,
          email: user.email,
          isOwner: user.is_owner
        }
      };
    });
  }

  async logout(sessionId: string): Promise<void> {
    await this.database.query(
      "UPDATE user_session SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
      [sessionId]
    );
  }

  async resolveSession(token: string): Promise<SessionAuth | null> {
    const result = await this.database.query<{
      session_id: string;
      user_id: string;
      email: string;
      membership_id: string;
      tenant_id: string;
      tenant_name: string;
      is_owner: boolean;
    }>("SELECT * FROM public.corebiz_auth_resolve_session($1)", [hashToken(token)]);

    const row = result.rows[0];
    if (!row) return null;

    // The activity timestamp is best-effort telemetry, not part of
    // authentication. Handle its rejection to avoid an unhandled promise.
    void this.database
      .query(
        "UPDATE user_session SET last_seen_at = now() WHERE id = $1",
        [row.session_id]
      )
      .catch(() => {
        // A transient telemetry write failure must not crash the API process.
      });

    return {
      sessionId: row.session_id,
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      userId: row.user_id,
      membershipId: row.membership_id,
      email: row.email,
      isOwner: row.is_owner
    };
  }

  async switchTenant(
    sessionId: string,
    userId: string,
    membershipId: string
  ): Promise<void> {
    const result = await this.database.query<{ switched: boolean }>(
      "SELECT public.corebiz_auth_switch_tenant($1::uuid, $2::uuid, $3::uuid) AS switched",
      [sessionId, userId, membershipId]
    );
    if (result.rows[0]?.switched !== true) {
      throw new UnauthorizedException("Компания недоступна");
    }
  }

  async listMemberships(userId: string): Promise<
    Array<{
      membershipId: string;
      tenantId: string;
      tenantName: string;
      isOwner: boolean;
    }>
  > {
    const result = await this.database.query<{
      membership_id: string;
      tenant_id: string;
      tenant_name: string;
      is_owner: boolean;
    }>("SELECT * FROM public.corebiz_auth_memberships($1::uuid)", [userId]);

    return result.rows.map((row) => ({
      membershipId: row.membership_id,
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      isOwner: row.is_owner
    }));
  }

  private async createSession(
    client: PoolClient,
    userId: string,
    membershipId: string,
    token: string
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO user_session(
         user_id, session_hash, active_membership_id, expires_at, last_seen_at
       ) VALUES ($1, $2, $3, now() + interval '30 days', now())
       RETURNING id`,
      [userId, hashToken(token), membershipId]
    );

    const row = result.rows[0];
    if (!row) throw new Error("SESSION_CREATE_FAILED");
    return row.id;
  }

  private normalizeEmail(value: string): string {
    const email = value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException("Некорректный email");
    }
    return email;
  }

  private validatePassword(password: string): void {
    if (password.length < 10 || password.length > 200) {
      throw new BadRequestException("Пароль должен содержать не менее 10 символов");
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return Boolean(
      error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "23505"
    );
  }
}
