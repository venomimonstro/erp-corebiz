import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service";

type BlockType =
  | "HERO"
  | "TEXT"
  | "FEATURES"
  | "CTA"
  | "IMAGE"
  | "GALLERY"
  | "PRODUCTS"
  | "SERVICES"
  | "FAQ"
  | "CONTACTS"
  | "SPACER";

type EditorBlock = {
  type: BlockType;
  props?: Record<string, unknown>;
};

const BLOCK_KEYS: Record<BlockType, ReadonlySet<string>> = {
  HERO: new Set([
    "eyebrow","title","subtitle","primaryLabel","primaryHref",
    "secondaryLabel","secondaryHref","imageUrl","align"
  ]),
  TEXT: new Set(["heading","body","align"]),
  FEATURES: new Set(["heading","items"]),
  CTA: new Set(["heading","text","buttonLabel","buttonHref"]),
  IMAGE: new Set(["url","alt","caption"]),
  GALLERY: new Set(["images"]),
  PRODUCTS: new Set(["heading","limit","sort","showPrice","showStock"]),
  SERVICES: new Set(["heading","limit"]),
  FAQ: new Set(["heading","items"]),
  CONTACTS: new Set([
    "heading","phone","email","address","mapUrl","workingHours"
  ]),
  SPACER: new Set(["size"])
};

@Injectable()
export class SiteBuilderService {
  constructor(private readonly database: DatabaseService) {}

  async projects(
    context: TenantContext
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT
           sp.id,sp.name,sp.public_slug,sp.status,sp.theme,sp.settings,
           sp.created_at,sp.updated_at,
           count(pg.id) FILTER (WHERE pg.status='ACTIVE')::int AS pages
         FROM site_project sp
         LEFT JOIN site_page pg
           ON pg.tenant_id=sp.tenant_id AND pg.project_id=sp.id
         WHERE sp.tenant_id=$1
         GROUP BY sp.id
         ORDER BY sp.updated_at DESC`,
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async createProject(
    context: TenantContext,
    input: {
      name: string;
      publicSlug: string;
    }
  ): Promise<{ id: string; pageId: string; publicSlug: string }> {
    const name = this.text(input.name, 2, 160, "Название сайта");
    const publicSlug = this.slug(input.publicSlug, false);

    return this.database.withTenantTransaction(context, async (client) => {
      try {
        const project = await client.query<{ id: string }>(
          `INSERT INTO site_project(
             tenant_id,name,public_slug,theme,settings,created_by_membership_id
           ) VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING id`,
          [
            context.tenantId,
            name,
            publicSlug,
            JSON.stringify({
              fontFamily: "Inter, system-ui, sans-serif",
              radius: 16,
              contentWidth: 1180
            }),
            JSON.stringify({
              locale: "ru-RU",
              currency: "RUB"
            }),
            context.membershipId
          ]
        );

        const projectId = project.rows[0]!.id;
        const page = await client.query<{ id: string }>(
          `INSERT INTO site_page(
             tenant_id,project_id,slug,title,seo_title,seo_description,
             sort_order,created_by_membership_id
           ) VALUES ($1,$2,'','Главная',$3,$4,0,$5)
           RETURNING id`,
          [
            context.tenantId,
            projectId,
            name,
            name,
            context.membershipId
          ]
        );

        const pageId = page.rows[0]!.id;
        const version = await client.query<{ id: string }>(
          `INSERT INTO site_page_version(
             tenant_id,page_id,version_no,state,created_by_membership_id
           ) VALUES ($1,$2,1,'DRAFT',$3)
           RETURNING id`,
          [context.tenantId, pageId, context.membershipId]
        );

        const versionId = version.rows[0]!.id;
        const defaults: EditorBlock[] = [
          {
            type: "HERO",
            props: {
              eyebrow: "Бизнес",
              title: name,
              subtitle: "Расскажите клиенту главное простыми словами.",
              primaryLabel: "Связаться",
              primaryHref: "#contacts",
              align: "left"
            }
          },
          {
            type: "FEATURES",
            props: {
              heading: "Почему выбирают нас",
              items: [
                { title: "Понятно", text: "Без лишней сложности." },
                { title: "Надёжно", text: "Чёткие процессы и ответственность." },
                { title: "Удобно", text: "Быстрый путь от интереса до заказа." }
              ]
            }
          },
          {
            type: "CTA",
            props: {
              heading: "Готовы обсудить задачу?",
              text: "Оставьте заявку — мы свяжемся с вами.",
              buttonLabel: "Оставить заявку",
              buttonHref: "#contacts"
            }
          },
          {
            type: "CONTACTS",
            props: {
              heading: "Контакты",
              phone: "",
              email: "",
              address: "",
              workingHours: ""
            }
          }
        ];

        await this.replaceBlocks(
          client,
          context,
          versionId,
          this.validateBlocks(defaults)
        );

        await this.audit(
          client,
          context,
          "site.project_created",
          "site_project",
          projectId,
          { name, publicSlug }
        );

        return { id: projectId, pageId, publicSlug };
      } catch (error) {
        if (this.isUniqueViolation(error)) {
          throw new ConflictException(
            "Такой публичный адрес сайта уже занят"
          );
        }
        throw error;
      }
    });
  }

  async pages(
    context: TenantContext,
    projectId: string
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      await this.assertProject(client, context.tenantId, projectId);

      const result = await client.query(
        `SELECT
           pg.id,pg.slug,pg.title,pg.seo_title,pg.seo_description,
           pg.status,pg.sort_order,pg.updated_at,
           draft.version_no AS draft_version,
           published.version_no AS published_version,
           published.published_at
         FROM site_page pg
         LEFT JOIN site_page_version draft
           ON draft.tenant_id=pg.tenant_id
          AND draft.page_id=pg.id
          AND draft.state='DRAFT'
         LEFT JOIN site_page_version published
           ON published.tenant_id=pg.tenant_id
          AND published.page_id=pg.id
          AND published.state='PUBLISHED'
         WHERE pg.tenant_id=$1
           AND pg.project_id=$2
           AND pg.status='ACTIVE'
         ORDER BY pg.sort_order,pg.created_at`,
        [context.tenantId, projectId]
      );

      return result.rows;
    });
  }

  async createPage(
    context: TenantContext,
    projectId: string,
    input: {
      title: string;
      slug: string;
    }
  ): Promise<{ id: string }> {
    const title = this.text(input.title, 1, 160, "Название страницы");
    const slug = this.slug(input.slug, true);

    return this.database.withTenantTransaction(context, async (client) => {
      await this.assertProject(client, context.tenantId, projectId);

      try {
        const page = await client.query<{ id: string }>(
          `INSERT INTO site_page(
             tenant_id,project_id,slug,title,seo_title,
             sort_order,created_by_membership_id
           )
           SELECT $1,$2,$3,$4,$4,
                  COALESCE(max(sort_order),0)+100,$5
           FROM site_page
           WHERE tenant_id=$1 AND project_id=$2
           RETURNING id`,
          [
            context.tenantId,
            projectId,
            slug,
            title,
            context.membershipId
          ]
        );

        const pageId = page.rows[0]!.id;

        await client.query(
          `INSERT INTO site_page_version(
             tenant_id,page_id,version_no,state,created_by_membership_id
           ) VALUES ($1,$2,1,'DRAFT',$3)`,
          [context.tenantId, pageId, context.membershipId]
        );

        return { id: pageId };
      } catch (error) {
        if (this.isUniqueViolation(error)) {
          throw new ConflictException(
            "Страница с таким адресом уже существует"
          );
        }
        throw error;
      }
    });
  }

  async editor(
    context: TenantContext,
    pageId: string
  ): Promise<Record<string, unknown>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const page = await client.query(
        `SELECT
           pg.id,pg.project_id,pg.slug,pg.title,
           pg.seo_title,pg.seo_description,pg.status,
           sp.name AS project_name,sp.public_slug,sp.status AS project_status,
           sp.theme,sp.settings
         FROM site_page pg
         JOIN site_project sp
           ON sp.tenant_id=pg.tenant_id AND sp.id=pg.project_id
         WHERE pg.tenant_id=$1 AND pg.id=$2`,
        [context.tenantId, pageId]
      );

      if (!page.rows[0]) throw new NotFoundException("Страница не найдена");

      const version = await client.query<{
        id: string;
        version_no: number;
      }>(
        `SELECT id,version_no
         FROM site_page_version
         WHERE tenant_id=$1 AND page_id=$2 AND state='DRAFT'
         LIMIT 1`,
        [context.tenantId, pageId]
      );

      const draft = version.rows[0];
      if (!draft) throw new ConflictException("Draft страницы отсутствует");

      const blocks = await client.query(
        `SELECT id,position,block_type,props
         FROM site_block
         WHERE tenant_id=$1 AND version_id=$2
         ORDER BY position`,
        [context.tenantId, draft.id]
      );

      return {
        page: page.rows[0],
        draft: {
          id: draft.id,
          versionNo: draft.version_no,
          blocks: blocks.rows
        }
      };
    });
  }

  async saveDraft(
    context: TenantContext,
    pageId: string,
    input: {
      title: string;
      slug: string;
      seoTitle?: string;
      seoDescription?: string;
      blocks: EditorBlock[];
    }
  ): Promise<{ versionNo: number; blocks: number }> {
    const title = this.text(input.title, 1, 160, "Название страницы");
    const slug = this.slug(input.slug, true);
    const seoTitle = this.optionalText(input.seoTitle, 180);
    const seoDescription = this.optionalText(input.seoDescription, 320);
    const blocks = this.validateBlocks(input.blocks);

    return this.database.withTenantTransaction(context, async (client) => {
      const page = await client.query<{ project_id: string }>(
        `SELECT project_id FROM site_page
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'
         FOR UPDATE`,
        [context.tenantId, pageId]
      );
      if (!page.rows[0]) throw new NotFoundException("Страница не найдена");

      try {
        await client.query(
          `UPDATE site_page
           SET slug=$3,title=$4,seo_title=$5,seo_description=$6,updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [
            context.tenantId,
            pageId,
            slug,
            title,
            seoTitle,
            seoDescription
          ]
        );
      } catch (error) {
        if (this.isUniqueViolation(error)) {
          throw new ConflictException(
            "Страница с таким адресом уже существует"
          );
        }
        throw error;
      }

      const version = await client.query<{
        id: string;
        version_no: number;
      }>(
        `SELECT id,version_no
         FROM site_page_version
         WHERE tenant_id=$1 AND page_id=$2 AND state='DRAFT'
         FOR UPDATE`,
        [context.tenantId, pageId]
      );

      const draft = version.rows[0];
      if (!draft) throw new ConflictException("Draft страницы отсутствует");

      await this.replaceBlocks(client, context, draft.id, blocks);

      await client.query(
        `UPDATE site_page_version
         SET updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId, draft.id]
      );

      return {
        versionNo: draft.version_no,
        blocks: blocks.length
      };
    });
  }

  async publish(
    context: TenantContext,
    pageId: string
  ): Promise<{ publishedVersion: number; previewUrl: string }> {
    return this.database.withTenantTransaction(context, async (client) => {
      const page = await client.query<{
        project_id: string;
        slug: string;
        public_slug: string;
      }>(
        `SELECT pg.project_id,pg.slug,sp.public_slug
         FROM site_page pg
         JOIN site_project sp
           ON sp.tenant_id=pg.tenant_id AND sp.id=pg.project_id
         WHERE pg.tenant_id=$1 AND pg.id=$2 AND pg.status='ACTIVE'
         FOR UPDATE OF pg,sp`,
        [context.tenantId, pageId]
      );

      const pageRow = page.rows[0];
      if (!pageRow) throw new NotFoundException("Страница не найдена");

      const draftResult = await client.query<{
        id: string;
        version_no: number;
      }>(
        `SELECT id,version_no
         FROM site_page_version
         WHERE tenant_id=$1 AND page_id=$2 AND state='DRAFT'
         FOR UPDATE`,
        [context.tenantId, pageId]
      );

      const draft = draftResult.rows[0];
      if (!draft) throw new ConflictException("Draft страницы отсутствует");

      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM site_block
         WHERE tenant_id=$1 AND version_id=$2`,
        [context.tenantId, draft.id]
      );
      if (Number(count.rows[0]?.count ?? "0") === 0) {
        throw new BadRequestException("Нельзя опубликовать пустую страницу");
      }

      await client.query(
        `UPDATE site_page_version
         SET state='SUPERSEDED',updated_at=now()
         WHERE tenant_id=$1 AND page_id=$2 AND state='PUBLISHED'`,
        [context.tenantId, pageId]
      );

      await client.query(
        `UPDATE site_page_version
         SET state='PUBLISHED',
             published_by_membership_id=$3,
             published_at=now(),
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId, draft.id, context.membershipId]
      );

      await client.query(
        `INSERT INTO site_publish_event(
           tenant_id,project_id,page_id,version_id,actor_membership_id
         ) VALUES ($1,$2,$3,$4,$5)`,
        [
          context.tenantId,
          pageRow.project_id,
          pageId,
          draft.id,
          context.membershipId
        ]
      );

      const nextVersion = draft.version_no + 1;
      const next = await client.query<{ id: string }>(
        `INSERT INTO site_page_version(
           tenant_id,page_id,version_no,state,created_by_membership_id
         ) VALUES ($1,$2,$3,'DRAFT',$4)
         RETURNING id`,
        [
          context.tenantId,
          pageId,
          nextVersion,
          context.membershipId
        ]
      );

      await client.query(
        `INSERT INTO site_block(
           tenant_id,version_id,position,block_type,props
         )
         SELECT tenant_id,$3,position,block_type,props
         FROM site_block
         WHERE tenant_id=$1 AND version_id=$2
         ORDER BY position`,
        [context.tenantId, draft.id, next.rows[0]!.id]
      );

      await client.query(
        `UPDATE site_project
         SET status='PUBLISHED',updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId, pageRow.project_id]
      );

      await this.audit(
        client,
        context,
        "site.page_published",
        "site_page",
        pageId,
        { versionNo: draft.version_no }
      );

      const suffix = pageRow.slug ? "/" + pageRow.slug : "";
      return {
        publishedVersion: draft.version_no,
        previewUrl: "/s/" + pageRow.public_slug + suffix
      };
    });
  }

  async publicPage(
    publicSlug: string,
    pageSlug?: string
  ): Promise<Record<string, unknown>> {
    const slug = publicSlug.trim().toLowerCase();
    const page = (pageSlug ?? "").trim().replace(/^\/+|\/+$/g, "");

    if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(slug)) {
      throw new NotFoundException("Сайт не найден");
    }
    if (page && !/^[a-z0-9][a-z0-9/-]{0,120}$/.test(page)) {
      throw new NotFoundException("Страница не найдена");
    }

    const result = await this.database.query<{ payload: Record<string, unknown> | null }>(
      `SELECT corebiz_public_site_page($1,$2) AS payload`,
      [slug, page]
    );

    const payload = result.rows[0]?.payload;
    if (!payload) throw new NotFoundException("Страница не опубликована");
    return payload;
  }

  private validateBlocks(input: EditorBlock[]): Array<{
    type: BlockType;
    props: Record<string, unknown>;
  }> {
    if (!Array.isArray(input)) {
      throw new BadRequestException("blocks должен быть массивом");
    }
    if (input.length > 80) {
      throw new BadRequestException("На странице допускается не более 80 блоков");
    }

    const blocks = input.map((block, index) => {
      if (!block || typeof block !== "object" || !(block.type in BLOCK_KEYS)) {
        throw new BadRequestException(
          "Неизвестный тип блока в позиции " + index
        );
      }

      const source =
        block.props && typeof block.props === "object"
          ? block.props
          : {};
      const allowed = BLOCK_KEYS[block.type];
      const props: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(source)) {
        if (!allowed.has(key)) {
          throw new BadRequestException(
            "Свойство " + key + " запрещено для блока " + block.type
          );
        }
        props[key] = this.sanitizeValue(value, key, 0);
      }

      const json = JSON.stringify(props);
      if (json.length > 24000) {
        throw new BadRequestException(
          "Содержимое одного блока превышает допустимый размер"
        );
      }

      return { type: block.type, props };
    });

    if (JSON.stringify(blocks).length > 256000) {
      throw new BadRequestException("Страница слишком большая");
    }

    return blocks;
  }

  private sanitizeValue(
    value: unknown,
    key: string,
    depth: number
  ): unknown {
    if (depth > 4) {
      throw new BadRequestException("Слишком глубокая структура блока");
    }

    if (value === null || typeof value === "boolean") return value;

    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new BadRequestException("Некорректное числовое значение");
      }
      return value;
    }

    if (typeof value === "string") {
      const result = value.trim().slice(0, 5000);
      if (/href|url/i.test(key) && result) {
        this.assertSafeUrl(result);
      }
      return result;
    }

    if (Array.isArray(value)) {
      if (value.length > 40) {
        throw new BadRequestException("Слишком много элементов в блоке");
      }
      return value.map((item) =>
        this.sanitizeValue(item, key, depth + 1)
      );
    }

    if (typeof value === "object") {
      const object = value as Record<string, unknown>;
      const output: Record<string, unknown> = {};
      const entries = Object.entries(object);
      if (entries.length > 20) {
        throw new BadRequestException("Слишком много свойств в элементе");
      }
      for (const [childKey, childValue] of entries) {
        if (/^(html|script|javascript|on[a-z]+|style)$/i.test(childKey)) {
          throw new BadRequestException(
            "Опасное свойство блока запрещено"
          );
        }
        output[childKey] = this.sanitizeValue(
          childValue,
          childKey,
          depth + 1
        );
      }
      return output;
    }

    throw new BadRequestException("Неподдерживаемое значение блока");
  }

  private assertSafeUrl(value: string): void {
    if (
      value.startsWith("/") ||
      value.startsWith("#") ||
      value.startsWith("mailto:") ||
      value.startsWith("tel:")
    ) {
      return;
    }

    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("unsafe");
      }
    } catch {
      throw new BadRequestException("Недопустимая ссылка в блоке");
    }
  }

  private async replaceBlocks(
    client: PoolClient,
    context: TenantContext,
    versionId: string,
    blocks: Array<{
      type: BlockType;
      props: Record<string, unknown>;
    }>
  ): Promise<void> {
    await client.query(
      `DELETE FROM site_block
       WHERE tenant_id=$1 AND version_id=$2`,
      [context.tenantId, versionId]
    );

    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]!;
      await client.query(
        `INSERT INTO site_block(
           tenant_id,version_id,position,block_type,props
         ) VALUES ($1,$2,$3,$4,$5)`,
        [
          context.tenantId,
          versionId,
          index,
          block.type,
          JSON.stringify(block.props)
        ]
      );
    }
  }

  private slug(value: string, allowEmpty: boolean): string {
    const slug = String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/^\/+|\/+$/g, "")
      .replace(/\s+/g, "-");

    if (allowEmpty && slug === "") return "";
    const regex = allowEmpty
      ? /^[a-z0-9][a-z0-9/-]{0,120}$/
      : /^[a-z0-9][a-z0-9-]{2,62}$/;

    if (!regex.test(slug) || slug.includes("//")) {
      throw new BadRequestException(
        "Адрес может содержать только a-z, 0-9, дефис и /"
      );
    }
    return slug;
  }

  private text(
    value: unknown,
    min: number,
    max: number,
    label: string
  ): string {
    const result = String(value ?? "").trim();
    if (result.length < min || result.length > max) {
      throw new BadRequestException(
        label + ": длина от " + min + " до " + max
      );
    }
    return result;
  }

  private optionalText(value: unknown, max: number): string | null {
    const result = String(value ?? "").trim();
    return result ? result.slice(0, max) : null;
  }

  private async assertProject(
    client: PoolClient,
    tenantId: string,
    projectId: string
  ): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM site_project
       WHERE tenant_id=$1 AND id=$2 AND status <> 'ARCHIVED'`,
      [tenantId, projectId]
    );
    if (!result.rowCount) throw new NotFoundException("Сайт не найден");
  }

  private async audit(
    client: PoolClient,
    context: TenantContext,
    action: string,
    resourceType: string,
    resourceId: string,
    afterData?: Record<string, unknown>
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_event(
         tenant_id,actor_user_id,actor_membership_id,
         action,resource_type,resource_id,after_data
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        context.tenantId,
        context.userId,
        context.membershipId,
        action,
        resourceType,
        resourceId,
        afterData ? JSON.stringify(afterData) : null
      ]
    );
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
