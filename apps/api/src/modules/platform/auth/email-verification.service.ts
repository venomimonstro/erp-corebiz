import {
  BadRequestException,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { hashToken } from "./auth.utils";

@Injectable()
export class EmailVerificationService {
  constructor(private readonly database: DatabaseService) {}

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

  async request(
    userId: string
  ): Promise<{ queued: boolean; verified: boolean }> {
    const result=await this.database.query<{
      email_verified_at:Date|null;
    }>(
      `SELECT email_verified_at
       FROM app_user
       WHERE id=$1 AND status='ACTIVE'`,
      [userId]
    );
    const user=result.rows[0];
    if(!user)throw new UnauthorizedException("Аккаунт недоступен");
    if(user.email_verified_at!==null){
      return {queued:false,verified:true};
    }

    const queued=await this.database.query<{queued:boolean}>(
      `SELECT public.corebiz_enqueue_auth_mail(
         $1::uuid,'EMAIL_VERIFICATION'
       ) AS queued`,
      [userId]
    );
    return {
      queued:queued.rows[0]?.queued===true,
      verified:false
    };
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
