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
  // Activity telemetry must not perform a PostgreSQL UPDATE on every
  // authenticated API request. Session validation remains DB-backed.
  private readonly sessionTouchAt = new Map<string,number>();
  private static readonly SESSION_TOUCH_INTERVAL_MS = 5*60*1000;
  private static readonly SESSION_TOUCH_CACHE_MAX = 20_000;

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

  async registerInvited(input:{
    email:string;password:string;invitationToken:string
  }):Promise<{token:string;auth:SessionAuth}>{
    if(!input || typeof input.invitationToken!=="string" ||
      input.invitationToken.length<32 || input.invitationToken.length>256){
      throw new BadRequestException("Некорректная ссылка приглашения");
    }
    const email=this.normalizeEmail(input.email);
    this.validatePassword(input.password);
    const passwordHash=await hash(input.password,{
      type:argon2id,memoryCost:19_456,timeCost:2,parallelism:1
    });
    try{
      return await this.database.withTransaction(async client=>{
        const created=await client.query<{id:string;email:string}>(
          `INSERT INTO app_user(email,password_hash)
           VALUES($1,$2) RETURNING id,email`,[email,passwordHash]);
        const user=created.rows[0];
        if(!user)throw new Error("USER_CREATE_FAILED");
        const accepted=await client.query<{tenant_id:string;membership_id:string}>(
          "SELECT * FROM public.corebiz_auth_accept_invitation($1::uuid,$2)",
          [user.id,hashToken(input.invitationToken)]);
        const membership=accepted.rows[0];
        if(!membership)throw new BadRequestException(
          "Приглашение недействительно, просрочено или указана другая почта"
        );
        await client.query("SELECT set_config('app.tenant_id',$1,true)",[
          membership.tenant_id]);
        const tenant=await client.query<{name:string}>(
          "SELECT name FROM tenant WHERE id=$1",[membership.tenant_id]);
        if(!tenant.rows[0])throw new Error("INVITED_TENANT_NOT_FOUND");
        const sessionToken=generateToken();
        const sessionId=await this.createSession(
          client,user.id,membership.membership_id,sessionToken);
        return {
          token:sessionToken,
          auth:{
            sessionId,tenantId:membership.tenant_id,
            tenantName:tenant.rows[0].name,
            userId:user.id,membershipId:membership.membership_id,
            email:user.email,isOwner:false
          }
        };
      });
    }catch(error){
      if(this.isUniqueViolation(error))
        throw new ConflictException(
          "Аккаунт уже существует. Войдите и примите приглашение."
        );
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
    this.sessionTouchAt.delete(sessionId);
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

    // A busy authenticated client may issue hundreds of API calls per minute.
    // Never write user_session on each request: this causes row contention,
    // WAL pressure and potentially degrades PostgreSQL under 99.9% SLO load.
    const now=Date.now();
    const previous=this.sessionTouchAt.get(row.session_id)??0;
    if(now-previous>=AuthService.SESSION_TOUCH_INTERVAL_MS) {
      // Mark BEFORE launching the best-effort write: concurrent requests
      // do not trigger an unbounded number of DB updates for one session.
      this.sessionTouchAt.delete(row.session_id);
      this.sessionTouchAt.set(row.session_id,now);
      if(this.sessionTouchAt.size>AuthService.SESSION_TOUCH_CACHE_MAX) {
        const oldest=this.sessionTouchAt.keys().next().value;
        if(oldest!==undefined)this.sessionTouchAt.delete(oldest);
      }
      void this.database.query(
        `UPDATE user_session SET last_seen_at=now()
         WHERE id=$1 AND
           (last_seen_at IS NULL OR last_seen_at<now()-interval '4 minutes')`,
        [row.session_id]
      ).catch(()=>{
        // Session authentication does not depend on activity telemetry.
      });
    }

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
