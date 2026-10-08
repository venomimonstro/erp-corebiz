import {
  BadRequestException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service";

@Injectable()
export class SupportService {
  constructor(private readonly database: DatabaseService) {}

  async listTickets(context: TenantContext): Promise<Array<{
    id: string;
    number: string;
    subject: string;
    status: string;
    priority: string;
    category: string | null;
    contextUrl: string | null;
    updatedAt: string;
  }>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{
        id: string;
        business_number: string;
        subject: string;
        status: string;
        priority: string;
        category: string | null;
        context_url: string | null;
        updated_at: Date;
      }>(
        `SELECT id, business_number, subject, status, priority,
                category, context_url, updated_at
         FROM support_ticket
         WHERE tenant_id = $1
         ORDER BY
           CASE priority
             WHEN 'URGENT' THEN 0
             WHEN 'HIGH' THEN 1
             WHEN 'NORMAL' THEN 2
             ELSE 3
           END,
           updated_at DESC
         LIMIT 500`,
        [context.tenantId]
      );

      return result.rows.map((row) => ({
        id: row.id,
        number: row.business_number,
        subject: row.subject,
        status: row.status,
        priority: row.priority,
        category: row.category,
        contextUrl: row.context_url,
        updatedAt: row.updated_at.toISOString()
      }));
    });
  }

  async createTicket(
    context: TenantContext,
    input: {
      subject: string;
      body: string;
      priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT";
      category?: string;
      contextUrl?: string;
    }
  ): Promise<{ id: string; number: string }> {
    const subject = input.subject.trim();
    const body = input.body.trim();

    if (subject.length < 3 || subject.length > 240) {
      throw new BadRequestException("Некорректная тема обращения");
    }
    if (body.length < 3 || body.length > 20_000) {
      throw new BadRequestException("Некорректное описание обращения");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const number = await this.nextNumber(
        client,
        context.tenantId,
        "support_ticket",
        "SUP"
      );

      const ticketResult = await client.query<{ id: string }>(
        `INSERT INTO support_ticket(
           tenant_id, business_number, subject, status, priority,
           category, context_url, created_by_membership_id
         ) VALUES ($1,$2,$3,'NEW',$4,$5,$6,$7)
         RETURNING id`,
        [
          context.tenantId,
          number,
          subject,
          input.priority ?? "NORMAL",
          input.category?.trim() || null,
          input.contextUrl?.trim() || null,
          context.membershipId
        ]
      );

      const ticket = ticketResult.rows[0];
      if (!ticket) throw new Error("SUPPORT_TICKET_CREATE_FAILED");

      await client.query(
        `INSERT INTO support_message(
           tenant_id, ticket_id, author_membership_id, body, visibility
         ) VALUES ($1,$2,$3,$4,'PUBLIC')`,
        [context.tenantId, ticket.id, context.membershipId, body]
      );

      await this.audit(
        client,
        context,
        "support.ticket_created",
        "support_ticket",
        ticket.id,
        { number, subject }
      );

      return { id: ticket.id, number };
    });
  }

  async ticket(
    context: TenantContext,
    ticketId: string
  ): Promise<{
    ticket: Record<string, unknown>;
    messages: Array<Record<string, unknown>>;
    attachments: Array<Record<string, unknown>>;
  }> {
    return this.database.withTenantTransaction(context, async (client) => {
      const ticket = await client.query<{
        id: string;
        business_number: string;
        subject: string;
        status: string;
        priority: string;
        category: string | null;
        context_url: string | null;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT id, business_number, subject, status, priority,
                category, context_url, created_at, updated_at
         FROM support_ticket
         WHERE tenant_id = $1 AND id = $2`,
        [context.tenantId, ticketId]
      );

      const row = ticket.rows[0];
      if (!row) throw new NotFoundException("Тикет не найден");

      const messages = await client.query<{
        id: string;
        body: string;
        visibility: string;
        author_membership_id: string | null;
        created_at: Date;
      }>(
        `SELECT id, body, visibility, author_membership_id, created_at
         FROM support_message
         WHERE tenant_id = $1
           AND ticket_id = $2
           AND visibility = 'PUBLIC'
         ORDER BY created_at`,
        [context.tenantId, ticketId]
      );

      const attachments = await client.query<{
        id: string;
        message_id: string | null;
        filename: string;
        mime_type: string | null;
        size_bytes: string;
        object_key: string;
        created_at: Date;
      }>(
        `SELECT id, message_id, filename, mime_type,
                size_bytes::text, object_key, created_at
         FROM support_attachment
         WHERE tenant_id = $1 AND ticket_id = $2
         ORDER BY created_at`,
        [context.tenantId, ticketId]
      );

      return {
        ticket: {
          id: row.id,
          number: row.business_number,
          subject: row.subject,
          status: row.status,
          priority: row.priority,
          category: row.category,
          contextUrl: row.context_url,
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString()
        },
        messages: messages.rows.map((message) => ({
          id: message.id,
          body: message.body,
          visibility: message.visibility,
          authorMembershipId: message.author_membership_id,
          createdAt: message.created_at.toISOString()
        })),
        attachments: attachments.rows.map((item) => ({
          id: item.id,
          messageId: item.message_id,
          filename: item.filename,
          mimeType: item.mime_type,
          sizeBytes: item.size_bytes,
          objectKey: item.object_key,
          createdAt: item.created_at.toISOString()
        }))
      };
    });
  }

  async reply(
    context: TenantContext,
    ticketId: string,
    bodyInput: string
  ): Promise<{ messageId: string }> {
    const body = bodyInput.trim();
    if (body.length < 1 || body.length > 20_000) {
      throw new BadRequestException("Некорректное сообщение");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const ticket = await client.query<{ status: string }>(
        `SELECT status FROM support_ticket
         WHERE tenant_id = $1 AND id = $2
         FOR UPDATE`,
        [context.tenantId, ticketId]
      );

      const row = ticket.rows[0];
      if (!row) throw new NotFoundException("Тикет не найден");
      if (row.status === "CLOSED") {
        throw new BadRequestException("Закрытый тикет нельзя продолжить");
      }

      const result = await client.query<{ id: string }>(
        `INSERT INTO support_message(
           tenant_id, ticket_id, author_membership_id, body, visibility
         ) VALUES ($1,$2,$3,$4,'PUBLIC')
         RETURNING id`,
        [context.tenantId, ticketId, context.membershipId, body]
      );

      await client.query(
        `UPDATE support_ticket
         SET status = 'WAITING_SUPPORT',
             updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [context.tenantId, ticketId]
      );

      return { messageId: result.rows[0]!.id };
    });
  }

  async close(
    context: TenantContext,
    ticketId: string
  ): Promise<void> {
    await this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `UPDATE support_ticket
         SET status = 'CLOSED',
             closed_at = now(),
             updated_at = now()
         WHERE tenant_id = $1
           AND id = $2
           AND status <> 'CLOSED'
         RETURNING id`,
        [context.tenantId, ticketId]
      );

      if (!result.rowCount) {
        const exists = await client.query(
          `SELECT 1 FROM support_ticket
           WHERE tenant_id = $1 AND id = $2`,
          [context.tenantId, ticketId]
        );
        if (!exists.rowCount) throw new NotFoundException("Тикет не найден");
      }
    });
  }

  async registerAttachment(
    context: TenantContext,
    input: {
      ticketId: string;
      messageId?: string;
      objectKey: string;
      filename: string;
      mimeType?: string;
      sizeBytes: string;
    }
  ): Promise<{ id: string }> {
    if (!/^\d+$/.test(input.sizeBytes)) {
      throw new BadRequestException("Некорректный размер файла");
    }

    const size = BigInt(input.sizeBytes);
    if (size > 25_000_000n) {
      throw new BadRequestException("Максимальный размер вложения 25 МБ");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const ticket = await client.query(
        `SELECT 1 FROM support_ticket
         WHERE tenant_id = $1 AND id = $2`,
        [context.tenantId, input.ticketId]
      );
      if (!ticket.rowCount) throw new NotFoundException("Тикет не найден");

      if (input.messageId) {
        const message = await client.query(
          `SELECT 1 FROM support_message
           WHERE tenant_id = $1 AND ticket_id = $2 AND id = $3`,
          [context.tenantId, input.ticketId, input.messageId]
        );
        if (!message.rowCount) throw new NotFoundException("Сообщение не найдено");
      }

      const result = await client.query<{ id: string }>(
        `INSERT INTO support_attachment(
           tenant_id, ticket_id, message_id, object_key,
           filename, mime_type, size_bytes, uploaded_by_membership_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id`,
        [
          context.tenantId,
          input.ticketId,
          input.messageId ?? null,
          input.objectKey,
          input.filename,
          input.mimeType?.trim() || null,
          size.toString(),
          context.membershipId
        ]
      );

      return { id: result.rows[0]!.id };
    });
  }

  async searchKnowledge(queryInput: string): Promise<Array<{
    id: string;
    slug: string;
    title: string;
    category: string | null;
    bodyMarkdown: string;
  }>> {
    const query = queryInput.trim();

    const result = await this.database.query<{
      id: string;
      slug: string;
      title: string;
      category: string | null;
      body_markdown: string;
    }>(
      query
        ? `SELECT id, slug, title, category, body_markdown
           FROM knowledge_article
           WHERE status = 'PUBLISHED'
             AND to_tsvector('simple', search_text)
                 @@ plainto_tsquery('simple', $1)
           ORDER BY ts_rank(
             to_tsvector('simple', search_text),
             plainto_tsquery('simple', $1)
           ) DESC
           LIMIT 20`
        : `SELECT id, slug, title, category, body_markdown
           FROM knowledge_article
           WHERE status = 'PUBLISHED'
           ORDER BY published_at DESC
           LIMIT 20`,
      query ? [query] : []
    );

    return result.rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      category: row.category,
      bodyMarkdown: row.body_markdown
    }));
  }

  async createTemporaryGrant(
    context: TenantContext,
    input: {
      hours?: number;
      scopes?: string[];
      reason?: string;
    }
  ): Promise<{ token: string; grantId: string; expiresAt: string }> {
    const hours = Math.max(1, Math.min(24, Math.floor(input.hours ?? 4)));
    const scopes = input.scopes?.length ? input.scopes : ["read"];
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + hours * 3600000);

    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO support_access_grant(
           tenant_id, token_hash, scopes, reason,
           granted_by_membership_id, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id`,
        [
          context.tenantId,
          tokenHash,
          JSON.stringify(scopes),
          input.reason?.trim() || null,
          context.membershipId,
          expiresAt
        ]
      );

      const grant = result.rows[0];
      if (!grant) throw new Error("SUPPORT_GRANT_CREATE_FAILED");

      await this.audit(
        client,
        context,
        "support.access_granted",
        "support_access_grant",
        grant.id,
        { scopes, expiresAt: expiresAt.toISOString() }
      );

      return {
        token,
        grantId: grant.id,
        expiresAt: expiresAt.toISOString()
      };
    });
  }

  async revokeGrant(
    context: TenantContext,
    grantId: string
  ): Promise<void> {
    await this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `UPDATE support_access_grant
         SET revoked_at = now()
         WHERE tenant_id = $1
           AND id = $2
           AND revoked_at IS NULL
         RETURNING id`,
        [context.tenantId, grantId]
      );

      if (!result.rowCount) {
        throw new NotFoundException("Активный доступ поддержки не найден");
      }

      await this.audit(
        client,
        context,
        "support.access_revoked",
        "support_access_grant",
        grantId
      );
    });
  }

  async validateGrant(
    token: string
  ): Promise<{
    tenantId: string;
    grantId: string;
    scopes: string[];
  } | null> {
    const hash = createHash("sha256").update(token).digest("hex");

    const result = await this.database.query<{
      id: string;
      tenant_id: string;
      scopes: string[];
    }>(
      `SELECT id, tenant_id, scopes
       FROM support_access_grant
       WHERE token_hash = $1
         AND revoked_at IS NULL
         AND expires_at > now()
       LIMIT 1`,
      [hash]
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      tenantId: row.tenant_id,
      grantId: row.id,
      scopes: Array.isArray(row.scopes) ? row.scopes : []
    };
  }

  private async nextNumber(
    client: PoolClient,
    tenantId: string,
    counterKey: string,
    prefix: string
  ): Promise<string> {
    const counter = await client.query<{ value: string }>(
      `INSERT INTO tenant_counter(tenant_id, counter_key, value)
       VALUES ($1,$2,1)
       ON CONFLICT (tenant_id, counter_key)
       DO UPDATE SET
         value = tenant_counter.value + 1,
         updated_at = now()
       RETURNING value::text`,
      [tenantId, counterKey]
    );

    const sequence = BigInt(counter.rows[0]?.value ?? "0");
    const year = new Date().getUTCFullYear();
    return `${prefix}-${year}-${sequence.toString().padStart(6, "0")}`;
  }

  private async audit(
    client: PoolClient,
    context: TenantContext,
    action: string,
    resourceType: string,
    resourceId: string,
    data?: Record<string, unknown>
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_event(
         tenant_id, actor_user_id, actor_membership_id,
         action, resource_type, resource_id, after_data
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        context.tenantId,
        context.userId,
        context.membershipId,
        action,
        resourceType,
        resourceId,
        data ? JSON.stringify(data) : null
      ]
    );
  }
}
