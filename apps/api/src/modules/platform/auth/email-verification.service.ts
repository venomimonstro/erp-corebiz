import {
  BadRequestException,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { generateToken, hashToken } from "./auth.utils";
import { AuthMailService } from "./auth-mail.service";

@Injectable()
export class EmailVerificationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly mail: AuthMailService
  ) {}

  async status(userId: string): Promise<{ verified: boolean; email: string }> {
    const result = await this.database.query<{
      email: string; email_verified_at: Date | null;
    }>(
      "SELECT email,email_verified_at FROM app_user WHERE id=$1 AND status='ACTIVE'",
      [userId]
    );
    const user = result.rows[0];
    if (!user) throw new UnauthorizedException("Аккаунт недоступен");
    return { verified: user.email_verified_at !== null, email: user.email };
  }

  async request(userId: string): Promise<{ sent: boolean; verified: boolean }> {
    const pending = await this.database.withTransaction(async client => {
      const result = await client.query<{
        id: string; email: string; email_verified_at: Date | null;
      }>(
        "SELECT id,email,email_verified_at FROM app_user WHERE id=$1 AND status='ACTIVE' FOR UPDATE",
        [userId]
      );
      const user = result.rows[0];
      if (!user) throw new UnauthorizedException("Аккаунт недоступен");
      if (user.email_verified_at !== null) return null;

      const token = generateToken();
      await client.query(
        "UPDATE email_verification_token SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL",
        [user.id]
      );
      await client.query(
        "INSERT INTO email_verification_token(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '24 hours')",
        [user.id,hashToken(token)]
      );
      return { email:user.email, token };
    });

    if (!pending) return {sent:false,verified:true};
    try {
      await this.mail.sendVerification(pending.email,pending.token);
    } catch (error) {
      await this.database.query(
        "UPDATE email_verification_token SET consumed_at=now() WHERE token_hash=$1 AND consumed_at IS NULL",
        [hashToken(pending.token)]
      );
      throw error;
    }
    return {sent:true,verified:false};
  }

  async complete(rawToken: unknown): Promise<{ verified: true }> {
    if (typeof rawToken !== "string" ||
        !/^[A-Za-z0-9_-]{40,128}$/.test(rawToken)) {
      throw new BadRequestException("Ссылка недействительна или устарела");
    }
    await this.database.withTransaction(async client => {
      // Lock order MUST match request(): app_user first, token second.
      // Otherwise reissue and completion can deadlock on the same account.
      const candidate = await client.query<{user_id:string}>(
        "SELECT t.user_id FROM email_verification_token t JOIN app_user u ON u.id=t.user_id WHERE t.token_hash=$1 AND t.consumed_at IS NULL AND t.expires_at>now() AND u.status='ACTIVE' LIMIT 1",
        [hashToken(rawToken)]
      );
      if (!candidate.rows[0]) {
        throw new BadRequestException("Ссылка недействительна или устарела");
      }
      const owner = await client.query<{id:string}>(
        "SELECT id FROM app_user WHERE id=$1 AND status='ACTIVE' FOR UPDATE",
        [candidate.rows[0].user_id]
      );
      if (!owner.rows[0]) {
        throw new BadRequestException("Ссылка недействительна или устарела");
      }
      const result = await client.query<{ user_id: string }>(
        "SELECT t.user_id FROM email_verification_token t JOIN app_user u ON u.id=t.user_id WHERE t.token_hash=$1 AND t.consumed_at IS NULL AND t.expires_at>now() AND u.status='ACTIVE' FOR UPDATE OF t",
        [hashToken(rawToken)]
      );
      const row = result.rows[0];
      if (!row) throw new BadRequestException(
        "Ссылка недействительна или устарела"
      );
      await client.query(
        "UPDATE app_user SET email_verified_at=COALESCE(email_verified_at,now()),updated_at=now() WHERE id=$1 AND status='ACTIVE'",
        [row.user_id]
      );
      await client.query(
        "UPDATE email_verification_token SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL",
        [row.user_id]
      );
    });
    return {verified:true};
  }
}
