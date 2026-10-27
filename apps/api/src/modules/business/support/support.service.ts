import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { SupportStorageService } from "./support-storage.service";

const SUPPORT_ATTACHMENT_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
]);

@Injectable()
export class SupportService {
  constructor(
    private readonly database: DatabaseService,
    private readonly storage: SupportStorageService
  ) {}

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
      knowledgeSearchId?: string;
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

      if (input.knowledgeSearchId) {
        await client.query(
          `UPDATE support_knowledge_search
           SET ticket_id=$4,ticket_created_at=now()
           WHERE tenant_id=$1
             AND membership_id=$2
             AND id=$3
             AND ticket_id IS NULL`,
          [
            context.tenantId,
            context.membershipId,
            input.knowledgeSearchId,
            ticket.id
          ]
        );
      }

      await this.audit(
        client,
        context,
        "support.ticket_created",
        "support_ticket",
        ticket.id,
        {
          number,
          subject,
          knowledgeSearchId: input.knowledgeSearchId ?? null
        }
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
    ticketId: string,
    resolutionInput: string
  ): Promise<void> {
    if (typeof resolutionInput !== "string" ||
        resolutionInput.trim().length < 10 ||
        resolutionInput.trim().length > 2000) {
      throw new BadRequestException(
        "Укажите результат обращения (от 10 до 2000 символов)"
      );
    }
    const resolution = resolutionInput.trim();

    await this.database.withTenantTransaction(context, async (client) => {
      const current = await client.query<{ status: string }>(
        `SELECT status FROM support_ticket
         WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [context.tenantId, ticketId]
      );
      if (!current.rows[0]) throw new NotFoundException("Тикет не найден");
      if (current.rows[0].status === "CLOSED") return;

      await client.query(
        `INSERT INTO support_message(
           tenant_id,ticket_id,author_membership_id,body,visibility
         ) VALUES ($1,$2,$3,$4,'PUBLIC')`,
        [context.tenantId,ticketId,context.membershipId,
         "Результат обращения: " + resolution]
      );
      await client.query(
        `UPDATE support_ticket
         SET status='CLOSED',resolved_at=COALESCE(resolved_at,now()),
             closed_at=now(),updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,ticketId]
      );
      await this.audit(
        client,context,"support.ticket_closed","support_ticket",
        ticketId,{ resolutionRecorded: true }
      );
    });
  }

  async beginAttachmentUpload(
    context: TenantContext,
    ticketId: string,
    input: {
      messageId?: string;
      filename: string;
      mimeType: string;
      sizeBytes: string;
    }
  ): Promise<{
    uploadId: string;
    uploadUrl: string;
    expiresAt: string;
    requiredHeaders: Record<string, string>;
  }> {
    const filename=String(input.filename??"").trim();
    const mimeType=String(input.mimeType??"")
      .split(";")[0]!.trim().toLowerCase();
    if(filename.length<1||filename.length>240||
       /[\\/\u0000-\u001f]/.test(filename)){
      throw new BadRequestException("Некорректное имя файла");
    }
    if(!SUPPORT_ATTACHMENT_MIME_TYPES.has(mimeType)){
      throw new BadRequestException("Этот тип файла не поддерживается");
    }
    if(typeof input.sizeBytes!=="string"||!/^\d+$/.test(input.sizeBytes)){
      throw new BadRequestException("Некорректный размер файла");
    }
    const size=BigInt(input.sizeBytes);
    if(size<=0n||size>26214400n){
      throw new BadRequestException("Максимальный размер вложения 25 МБ");
    }

    const objectKey=
      "tenants/"+context.tenantId+"/support/"+ticketId+"/"+
      randomBytes(24).toString("hex");
    const uploadUrl=this.storage.createUploadUrl(objectKey,600);
    const expiresAt=new Date(Date.now()+15*60_000);

    const uploadId=await this.database.withTenantTransaction(
      context,
      async client=>{
        const subscription=await client.query(
          `SELECT plan_id
           FROM tenant_subscription
           WHERE tenant_id=$1
           FOR UPDATE`,
          [context.tenantId]
        );
        if(!subscription.rowCount){
          throw new ConflictException("Тариф компании не активирован");
        }

        const ticket=await client.query<{status:string}>(
          `SELECT status FROM support_ticket
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId,ticketId]
        );
        if(!ticket.rows[0]) throw new NotFoundException("Тикет не найден");
        if(ticket.rows[0].status==="CLOSED"){
          throw new ConflictException("Нельзя добавлять файлы в закрытый тикет");
        }

        if(input.messageId){
          const message=await client.query(
            `SELECT 1 FROM support_message
             WHERE tenant_id=$1 AND ticket_id=$2 AND id=$3`,
            [context.tenantId,ticketId,input.messageId]
          );
          if(!message.rowCount){
            throw new NotFoundException("Сообщение не найдено");
          }
        }

        const limit=await client.query<{limit_value:string|null}>(
          `SELECT corebiz_plan_bigint_limit(
             $1,'max_support_storage_bytes'
           )::text AS limit_value`,
          [context.tenantId]
        );
        const limitBytes=limit.rows[0]?.limit_value;
        if(!limitBytes){
          throw new ConflictException(
            "Для тарифа не настроен лимит файлового хранилища"
          );
        }

        const usage=await client.query<{used_bytes:string}>(
          `SELECT (
             COALESCE((
               SELECT sum(size_bytes)
               FROM support_attachment
               WHERE tenant_id=$1 AND verified_at IS NOT NULL
             ),0)
             +
             COALESCE((
               SELECT sum(declared_size_bytes)
               FROM support_attachment_upload
               WHERE tenant_id=$1 AND status='PENDING'
                 AND expires_at>now()
             ),0)
           )::text AS used_bytes`,
          [context.tenantId]
        );
        const used=BigInt(usage.rows[0]?.used_bytes??"0");
        if(used+size>BigInt(limitBytes)){
          throw new ConflictException(
            "Превышен лимит файлового хранилища тарифа"
          );
        }

        const created=await client.query<{id:string}>(
          `INSERT INTO support_attachment_upload(
             tenant_id,ticket_id,message_id,object_key,filename,
             declared_mime_type,declared_size_bytes,
             uploaded_by_membership_id,expires_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING id`,
          [
            context.tenantId,ticketId,input.messageId??null,objectKey,
            filename,mimeType,size.toString(),context.membershipId,expiresAt
          ]
        );
        return created.rows[0]!.id;
      }
    );

    return {
      uploadId,
      uploadUrl,
      expiresAt:expiresAt.toISOString(),
      requiredHeaders:{"Content-Type":mimeType}
    };
  }

  async completeAttachmentUpload(
    context: TenantContext,
    uploadId: string
  ): Promise<{id:string}> {
    const upload=await this.database.withTenantTransaction(
      context,
      async client=>{
        const result=await client.query<{
          id:string;ticket_id:string;message_id:string|null;
          object_key:string;filename:string;declared_mime_type:string;
          declared_size_bytes:string;status:string;attachment_id:string|null;
          expires_at:Date;
        }>(
          `SELECT id,ticket_id,message_id,object_key,filename,
                  declared_mime_type,declared_size_bytes::text,status,
                  attachment_id,expires_at
           FROM support_attachment_upload
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId,uploadId]
        );
        return result.rows[0]??null;
      }
    );
    if(!upload) throw new NotFoundException("Загрузка не найдена");
    if(upload.status==="VERIFIED"&&upload.attachment_id){
      return {id:upload.attachment_id};
    }
    if(upload.status!=="PENDING"){
      throw new ConflictException("Загрузка уже завершена или отклонена");
    }
    if(upload.expires_at.getTime()<=Date.now()){
      await this.database.withTenantTransaction(context,async client=>{
        await client.query(
          `UPDATE support_attachment_upload
           SET status='EXPIRED',failure_reason='UPLOAD_EXPIRED',updated_at=now()
           WHERE tenant_id=$1 AND id=$2 AND status='PENDING'`,
          [context.tenantId,uploadId]
        );
      });
      await this.storage.deleteObject(upload.object_key);
      throw new ConflictException("Срок загрузки файла истёк");
    }

    let info:{sizeBytes:bigint;mimeType:string;etag:string|null};
    try{
      info=await this.storage.verifyObject(upload.object_key);
    }catch(error){
      await this.database.withTenantTransaction(context,async client=>{
        await client.query(
          `UPDATE support_attachment_upload
           SET status='REJECTED',failure_reason='VERIFY_FAILED',updated_at=now()
           WHERE tenant_id=$1 AND id=$2 AND status='PENDING'`,
          [context.tenantId,uploadId]
        );
      });
      throw error;
    }

    const declaredSize=BigInt(upload.declared_size_bytes);
    if(info.sizeBytes!==declaredSize||
       info.mimeType!==upload.declared_mime_type){
      await this.database.withTenantTransaction(context,async client=>{
        await client.query(
          `UPDATE support_attachment_upload
           SET status='REJECTED',failure_reason='OBJECT_METADATA_MISMATCH',
               verified_size_bytes=$3,verified_mime_type=$4,updated_at=now()
           WHERE tenant_id=$1 AND id=$2 AND status='PENDING'`,
          [context.tenantId,uploadId,info.sizeBytes.toString(),info.mimeType]
        );
      });
      await this.storage.deleteObject(upload.object_key);
      throw new BadRequestException(
        "Размер или тип загруженного файла не совпадает с заявленным"
      );
    }

    const finalized=await this.database.withTenantTransaction(
      context,
      async client=>{
        const subscription=await client.query(
          `SELECT plan_id FROM tenant_subscription
           WHERE tenant_id=$1 FOR UPDATE`,
          [context.tenantId]
        );
        if(!subscription.rowCount){
          return {rejected:true as const,id:null};
        }

        const current=await client.query<{
          status:string;attachment_id:string|null;expires_at:Date;
        }>(
          `SELECT status,attachment_id,expires_at
           FROM support_attachment_upload
           WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
          [context.tenantId,uploadId]
        );
        const state=current.rows[0];
        if(!state) throw new NotFoundException("Загрузка не найдена");
        if(state.status==="VERIFIED"&&state.attachment_id){
          return {rejected:false as const,id:state.attachment_id};
        }
        if(state.status!=="PENDING"||state.expires_at.getTime()<=Date.now()){
          return {rejected:true as const,id:null};
        }

        const limit=await client.query<{limit_value:string|null}>(
          `SELECT corebiz_plan_bigint_limit(
             $1,'max_support_storage_bytes'
           )::text AS limit_value`,
          [context.tenantId]
        );
        const used=await client.query<{used_bytes:string}>(
          `SELECT COALESCE(sum(size_bytes),0)::text AS used_bytes
           FROM support_attachment
           WHERE tenant_id=$1 AND verified_at IS NOT NULL`,
          [context.tenantId]
        );
        const limitBytes=limit.rows[0]?.limit_value;
        if(!limitBytes||
           BigInt(used.rows[0]?.used_bytes??"0")+info.sizeBytes>
             BigInt(limitBytes)){
          await client.query(
            `UPDATE support_attachment_upload
             SET status='REJECTED',failure_reason='PLAN_STORAGE_LIMIT',
                 updated_at=now()
             WHERE tenant_id=$1 AND id=$2`,
            [context.tenantId,uploadId]
          );
          return {rejected:true as const,id:null};
        }

        const attachment=await client.query<{id:string}>(
          `INSERT INTO support_attachment(
             tenant_id,ticket_id,message_id,object_key,filename,mime_type,
             size_bytes,uploaded_by_membership_id,object_etag,verified_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
           RETURNING id`,
          [
            context.tenantId,upload.ticket_id,upload.message_id,
            upload.object_key,upload.filename,upload.declared_mime_type,
            info.sizeBytes.toString(),context.membershipId,info.etag
          ]
        );
        const id=attachment.rows[0]!.id;
        await client.query(
          `UPDATE support_attachment_upload
           SET status='VERIFIED',attachment_id=$3,object_etag=$4,
               verified_size_bytes=$5,verified_mime_type=$6,
               verified_at=now(),updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [
            context.tenantId,uploadId,id,info.etag,
            info.sizeBytes.toString(),info.mimeType
          ]
        );
        await this.audit(
          client,context,"support.attachment_verified",
          "support_attachment",id,
          {ticketId:upload.ticket_id,sizeBytes:info.sizeBytes.toString()}
        );
        return {rejected:false as const,id};
      }
    );

    if(finalized.rejected||!finalized.id){
      await this.storage.deleteObject(upload.object_key);
      throw new ConflictException(
        "Файл не может быть сохранён в текущем состоянии тарифа"
      );
    }
    return {id:finalized.id};
  }

  async attachmentDownload(
    context: TenantContext,
    attachmentId: string
  ): Promise<{url:string;expiresAt:string}> {
    const row=await this.database.withTenantTransaction(
      context,
      async client=>{
        const result=await client.query<{
          object_key:string;verified_at:Date|null;
        }>(
          `SELECT object_key,verified_at
           FROM support_attachment
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId,attachmentId]
        );
        const item=result.rows[0]??null;
        if(item?.verified_at){
          await client.query(
            `UPDATE support_attachment
             SET download_count=download_count+1,last_downloaded_at=now()
             WHERE tenant_id=$1 AND id=$2`,
            [context.tenantId,attachmentId]
          );
          await this.audit(
            client,context,"support.attachment_downloaded",
            "support_attachment",attachmentId
          );
        }
        return item;
      }
    );
    if(!row||!row.verified_at){
      throw new NotFoundException("Проверенное вложение не найдено");
    }
    const expiresAt=new Date(Date.now()+5*60_000);
    return {
      url:this.storage.createDownloadUrl(row.object_key,300),
      expiresAt:expiresAt.toISOString()
    };
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

  async trackedKnowledgeSearch(
    context: TenantContext,
    input: {
      query: string;
      contextUrl?: string;
    }
  ): Promise<{
    searchId: string;
    articles: Array<{
      id: string;
      slug: string;
      title: string;
      category: string | null;
      bodyMarkdown: string;
    }>;
  }> {
    const query = this.sanitizeKnowledgeQuery(input.query);
    const articles = await this.searchKnowledge(query);

    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO support_knowledge_search(
           tenant_id,membership_id,query_text,context_url,result_count
         ) VALUES ($1,$2,$3,$4,$5)
         RETURNING id`,
        [
          context.tenantId,
          context.membershipId,
          query,
          input.contextUrl?.trim().slice(0, 1000) || null,
          articles.length
        ]
      );

      return {
        searchId: result.rows[0]!.id,
        articles
      };
    });
  }

  async markKnowledgeSelection(
    context: TenantContext,
    searchId: string,
    articleId: string
  ): Promise<void> {
    await this.database.withTenantTransaction(context, async (client) => {
      const article = await client.query(
        `SELECT 1 FROM knowledge_article
         WHERE id=$1 AND status='PUBLISHED'`,
        [articleId]
      );
      if (!article.rowCount) {
        throw new NotFoundException("Статья не найдена");
      }

      const result = await client.query(
        `UPDATE support_knowledge_search
         SET selected_article_id=$4,selected_at=now()
         WHERE tenant_id=$1
           AND membership_id=$2
           AND id=$3
         RETURNING id`,
        [
          context.tenantId,
          context.membershipId,
          searchId,
          articleId
        ]
      );

      if (!result.rowCount) {
        throw new NotFoundException("Поиск базы знаний не найден");
      }
    });
  }

  async knowledgeFeedback(
    context: TenantContext,
    searchId: string,
    helpful: boolean
  ): Promise<void> {
    await this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `UPDATE support_knowledge_search
         SET helpful=$4,feedback_at=now()
         WHERE tenant_id=$1
           AND membership_id=$2
           AND id=$3
         RETURNING id`,
        [
          context.tenantId,
          context.membershipId,
          searchId,
          helpful
        ]
      );

      if (!result.rowCount) {
        throw new NotFoundException("Поиск базы знаний не найден");
      }
    });
  }

  async knowledgeTelemetry(
    context: TenantContext
  ): Promise<Record<string, unknown>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const summary = await client.query<{
        searches: string;
        no_result: string;
        helpful_yes: string;
        helpful_no: string;
        tickets_after_search: string;
      }>(
        `SELECT
           count(*)::text AS searches,
           count(*) FILTER (WHERE result_count=0)::text AS no_result,
           count(*) FILTER (WHERE helpful=true)::text AS helpful_yes,
           count(*) FILTER (WHERE helpful=false)::text AS helpful_no,
           count(*) FILTER (WHERE ticket_id IS NOT NULL)::text AS tickets_after_search
         FROM support_knowledge_search
         WHERE tenant_id=$1
           AND created_at >= now()-interval '30 days'`,
        [context.tenantId]
      );

      const gaps = await client.query<{
        query_text: string;
        searches: string;
        tickets: string;
      }>(
        `SELECT
           query_text,
           count(*)::text AS searches,
           count(*) FILTER (WHERE ticket_id IS NOT NULL)::text AS tickets
         FROM support_knowledge_search
         WHERE tenant_id=$1
           AND created_at >= now()-interval '30 days'
           AND (result_count=0 OR helpful=false OR ticket_id IS NOT NULL)
         GROUP BY query_text
         ORDER BY
           count(*) FILTER (WHERE ticket_id IS NOT NULL) DESC,
           count(*) DESC
         LIMIT 30`,
        [context.tenantId]
      );

      const row = summary.rows[0] ?? {
        searches: "0",
        no_result: "0",
        helpful_yes: "0",
        helpful_no: "0",
        tickets_after_search: "0"
      };

      const searches = Number(row.searches);
      const tickets = Number(row.tickets_after_search);

      return {
        periodDays: 30,
        searches,
        noResult: Number(row.no_result),
        helpfulYes: Number(row.helpful_yes),
        helpfulNo: Number(row.helpful_no),
        ticketsAfterSearch: tickets,
        selfServiceRatePercent:
          searches === 0
            ? null
            : Math.round(((searches - tickets) / searches) * 10000) / 100,
        gaps: gaps.rows.map((item) => ({
          query: item.query_text,
          searches: Number(item.searches),
          tickets: Number(item.tickets)
        }))
      };
    });
  }

  private sanitizeKnowledgeQuery(value: string): string {
    const query = String(value ?? "")
      .trim()
      .replace(
        /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
        "[email]"
      )
      .replace(/\+?\d[\d\s()\-]{8,}\d/g, "[phone]")
      .replace(/\s+/g, " ")
      .slice(0, 300);

    return query;
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
