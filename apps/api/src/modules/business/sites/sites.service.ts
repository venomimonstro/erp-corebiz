import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { randomBytes } from "node:crypto";
import { DatabaseService } from "../../../infrastructure/database/database.service";

type BlockType =
  | "HERO"
  | "TEXT"
  | "IMAGE"
  | "FEATURES"
  | "CTA"
  | "FORM"
  | "BOOKING"
  | "CATALOG"
  | "PRODUCT_GRID"
  | "SPACER";

const BLOCK_TYPES = new Set<BlockType>([
  "HERO","TEXT","IMAGE","FEATURES","CTA",
  "FORM","BOOKING","CATALOG","PRODUCT_GRID","SPACER"
]);

@Injectable()
export class SitesService {
  constructor(private readonly database: DatabaseService) {}

  async sites(context: TenantContext): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT
           s.id,s.name,s.code,s.public_slug,s.status,s.theme,s.settings,
           s.created_at,s.updated_at,
           count(p.id) FILTER (WHERE p.status='ACTIVE')::int AS pages
         FROM site s
         LEFT JOIN site_page p
           ON p.tenant_id=s.tenant_id AND p.site_id=s.id
         WHERE s.tenant_id=$1
         GROUP BY s.id
         ORDER BY s.updated_at DESC`,
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async createSite(
    context: TenantContext,
    input: {
      name: string;
      code?: string;
      publicSlug?: string;
    }
  ): Promise<{
    id: string;
    code: string;
    publicSlug: string;
    pageId: string;
    versionId: string;
  }> {
    const name = String(input.name ?? "").trim();
    if (name.length < 2 || name.length > 160) {
      throw new BadRequestException("Некорректное название сайта");
    }

    const code = this.slug(input.code?.trim() || name);
    if (!code) throw new BadRequestException("Некорректный код сайта");

    const publicSlug = input.publicSlug?.trim()
      ? this.publicSlug(input.publicSlug)
      : this.publicSlug(
          this.latinSlug(name) ||
          "site-" + randomBytes(4).toString("hex")
        ) + "-" + randomBytes(3).toString("hex");

    return this.database.withTenantTransaction(context, async (client) => {
      try {
        const result = await client.query<{
          id: string;
          code: string;
          public_slug: string;
        }>(
          `INSERT INTO site(
             tenant_id,name,code,public_slug,theme,settings,
             created_by_membership_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING id,code,public_slug`,
          [
            context.tenantId,
            name,
            code,
            publicSlug,
            JSON.stringify({
              fontFamily: "Inter, system-ui, sans-serif",
              contentWidth: 1180,
              radius: 16
            }),
            JSON.stringify({
              locale: "ru-RU",
              currency: "RUB"
            }),
            context.membershipId
          ]
        );

        const site = result.rows[0]!;
        const page = await client.query<{ id: string }>(
          `INSERT INTO site_page(
             tenant_id,site_id,name,slug,page_type,created_by_membership_id
           ) VALUES ($1,$2,'Главная','/','HOME',$3)
           RETURNING id`,
          [context.tenantId, site.id, context.membershipId]
        );

        const pageId = page.rows[0]!.id;
        const version = await client.query<{ id: string }>(
          `INSERT INTO site_page_version(
             tenant_id,page_id,version_no,title,meta_description,
             created_by_membership_id
           ) VALUES ($1,$2,1,$3,$4,$5)
           RETURNING id`,
          [
            context.tenantId,
            pageId,
            name,
            name,
            context.membershipId
          ]
        );

        const versionId = version.rows[0]!.id;
        const defaults: Array<{ type: BlockType; config: Record<string, unknown> }> = [
          {
            type: "HERO",
            config: {
              heading: name,
              text: "Коротко объясните клиенту, чем вы полезны и почему стоит обратиться именно к вам.",
              buttonLabel: "Связаться",
              buttonHref: "#contact"
            }
          },
          {
            type: "FEATURES",
            config: {
              heading: "Почему выбирают нас",
              items: [
                { title: "Понятно", text: "Без лишней сложности и скрытых условий." },
                { title: "Надёжно", text: "Прозрачный процесс и контроль результата." },
                { title: "Удобно", text: "Быстрый путь от интереса до покупки." }
              ]
            }
          },
          {
            type: "CTA",
            config: {
              heading: "Готовы обсудить задачу?",
              text: "Оставьте заявку или свяжитесь с нами удобным способом.",
              buttonLabel: "Связаться",
              buttonHref: "#contact"
            }
          }
        ];

        for (let index = 0; index < defaults.length; index += 1) {
          const block = defaults[index]!;
          await client.query(
            `INSERT INTO site_block(
               tenant_id,page_version_id,block_type,sort_order,config
             ) VALUES ($1,$2,$3,$4,$5)`,
            [
              context.tenantId,
              versionId,
              block.type,
              index,
              JSON.stringify(this.validateBlock(block.type, block.config))
            ]
          );
        }

        await this.audit(
          client,
          context,
          "site.created",
          "site",
          site.id,
          { code: site.code, publicSlug: site.public_slug }
        );

        return {
          id: site.id,
          code: site.code,
          publicSlug: site.public_slug,
          pageId,
          versionId
        };
      } catch (error) {
        if (this.unique(error)) {
          throw new ConflictException(
            "Код или публичный адрес сайта уже занят"
          );
        }
        throw error;
      }
    });
  }

  async pages(
    context: TenantContext,
    siteId: string
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const site = await client.query(
        `SELECT 1 FROM site
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
        [context.tenantId, siteId]
      );
      if (!site.rowCount) throw new NotFoundException("Сайт не найден");

      const result = await client.query(
        `SELECT
           p.id,p.name,p.slug,p.page_type,p.status,p.published_version_id,
           p.updated_at,
           COALESCE(max(v.version_no),0)::int AS latest_version_no,
           count(v.id) FILTER (WHERE v.status='DRAFT')::int AS drafts
         FROM site_page p
         LEFT JOIN site_page_version v
           ON v.tenant_id=p.tenant_id AND v.page_id=p.id
         WHERE p.tenant_id=$1 AND p.site_id=$2
         GROUP BY p.id
         ORDER BY
           CASE WHEN p.page_type='HOME' THEN 0 ELSE 1 END,
           p.name`,
        [context.tenantId, siteId]
      );
      return result.rows;
    });
  }

  async createPage(
    context: TenantContext,
    siteId: string,
    input: {
      name: string;
      slug?: string;
      pageType?: "HOME" | "CONTENT" | "CATALOG" | "PRODUCT" | "BOOKING" | "LANDING";
      title?: string;
    }
  ): Promise<{ id: string; versionId: string }> {
    const name = String(input.name ?? "").trim();
    if (name.length < 2 || name.length > 200) {
      throw new BadRequestException("Некорректное название страницы");
    }

    const pageType = input.pageType ?? "CONTENT";
    const slug = pageType === "HOME"
      ? "/"
      : "/" + this.slug(input.slug?.trim() || name);

    if (slug !== "/" && slug.length < 2) {
      throw new BadRequestException("Некорректный URL страницы");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const site = await client.query(
        `SELECT 1 FROM site
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
        [context.tenantId, siteId]
      );
      if (!site.rowCount) throw new NotFoundException("Сайт не найден");

      try {
        const page = await client.query<{ id: string }>(
          `INSERT INTO site_page(
             tenant_id,site_id,name,slug,page_type,created_by_membership_id
           ) VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING id`,
          [
            context.tenantId,
            siteId,
            name,
            slug,
            pageType,
            context.membershipId
          ]
        );

        const pageId = page.rows[0]!.id;
        const version = await client.query<{ id: string }>(
          `INSERT INTO site_page_version(
             tenant_id,page_id,version_no,title,created_by_membership_id
           ) VALUES ($1,$2,1,$3,$4)
           RETURNING id`,
          [
            context.tenantId,
            pageId,
            input.title?.trim() || name,
            context.membershipId
          ]
        );

        return { id: pageId, versionId: version.rows[0]!.id };
      } catch (error) {
        if (this.unique(error)) {
          throw new ConflictException("Страница с таким URL уже существует");
        }
        throw error;
      }
    });
  }

  async editor(
    context: TenantContext,
    pageId: string,
    versionId?: string
  ): Promise<Record<string, unknown>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const page = await client.query(
        `SELECT
           p.id,p.site_id,p.name,p.slug,p.page_type,p.published_version_id,
           s.name AS site_name,s.public_slug
         FROM site_page p
         JOIN site s
           ON s.tenant_id=p.tenant_id AND s.id=p.site_id
         WHERE p.tenant_id=$1 AND p.id=$2 AND p.status='ACTIVE'`,
        [context.tenantId, pageId]
      );
      if (!page.rows[0]) throw new NotFoundException("Страница не найдена");

      const version = await client.query(
        versionId
          ? `SELECT * FROM site_page_version
             WHERE tenant_id=$1 AND page_id=$2 AND id=$3`
          : `SELECT * FROM site_page_version
             WHERE tenant_id=$1 AND page_id=$2
             ORDER BY version_no DESC LIMIT 1`,
        versionId
          ? [context.tenantId, pageId, versionId]
          : [context.tenantId, pageId]
      );
      if (!version.rows[0]) throw new NotFoundException("Версия не найдена");

      const blocks = await client.query(
        `SELECT id,block_type,sort_order,config,created_at,updated_at
         FROM site_block
         WHERE tenant_id=$1 AND page_version_id=$2
         ORDER BY sort_order`,
        [context.tenantId, version.rows[0].id]
      );

      return {
        page: page.rows[0],
        version: version.rows[0],
        blocks: blocks.rows
      };
    });
  }

  async createDraft(
    context: TenantContext,
    pageId: string
  ): Promise<{ versionId: string; versionNo: number }> {
    return this.database.withTenantTransaction(context, async (client) => {
      const existingDraft = await client.query<{
        id: string;
        version_no: number;
      }>(
        `SELECT id,version_no
         FROM site_page_version
         WHERE tenant_id=$1 AND page_id=$2 AND status='DRAFT'
         ORDER BY version_no DESC LIMIT 1
         FOR UPDATE`,
        [context.tenantId, pageId]
      );
      if (existingDraft.rows[0]) {
        return {
          versionId: existingDraft.rows[0].id,
          versionNo: existingDraft.rows[0].version_no
        };
      }

      const current = await client.query<{
        id: string;
        version_no: number;
        title: string;
        meta_description: string | null;
      }>(
        `SELECT id,version_no,title,meta_description
         FROM site_page_version
         WHERE tenant_id=$1 AND page_id=$2
         ORDER BY version_no DESC
         LIMIT 1
         FOR UPDATE`,
        [context.tenantId, pageId]
      );
      const row = current.rows[0];
      if (!row) throw new NotFoundException("Страница не найдена");

      const next = row.version_no + 1;
      const version = await client.query<{ id: string }>(
        `INSERT INTO site_page_version(
           tenant_id,page_id,version_no,title,meta_description,
           created_by_membership_id
         ) VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id`,
        [
          context.tenantId,
          pageId,
          next,
          row.title,
          row.meta_description,
          context.membershipId
        ]
      );
      const versionId = version.rows[0]!.id;

      await client.query(
        `INSERT INTO site_block(
           tenant_id,page_version_id,block_type,sort_order,config
         )
         SELECT tenant_id,$3,block_type,sort_order,config
         FROM site_block
         WHERE tenant_id=$1 AND page_version_id=$2
         ORDER BY sort_order`,
        [context.tenantId, row.id, versionId]
      );

      return { versionId, versionNo: next };
    });
  }

  async saveMeta(
    context: TenantContext,
    pageId: string,
    versionId: string,
    input: {
      title: string;
      metaDescription?: string;
      metaRobots?: string;
      canonicalPath?: string;
      ogTitle?: string;
      ogDescription?: string;
      ogImageUrl?: string;
    }
  ): Promise<void> {
    const title = String(input.title ?? "").trim();
    if (title.length < 1 || title.length > 240) {
      throw new BadRequestException("Некорректный title");
    }

    const meta = input.metaDescription?.trim() || null;
    if (meta && meta.length > 500) {
      throw new BadRequestException("Meta description слишком длинный");
    }

    const robots = (input.metaRobots?.trim() || "index,follow").toLowerCase();
    const allowedRobots = new Set([
      "index,follow",
      "noindex,follow",
      "index,nofollow",
      "noindex,nofollow"
    ]);
    if (!allowedRobots.has(robots)) {
      throw new BadRequestException("Некорректный meta robots");
    }

    const canonicalPath = input.canonicalPath?.trim() || null;
    if (
      canonicalPath &&
      (!canonicalPath.startsWith("/") ||
        canonicalPath.startsWith("//") ||
        canonicalPath.length > 500)
    ) {
      throw new BadRequestException("Canonical должен быть относительным path");
    }

    const ogTitle = input.ogTitle?.trim() || null;
    const ogDescription = input.ogDescription?.trim() || null;
    const ogImageUrl = input.ogImageUrl?.trim() || null;

    if (ogTitle && ogTitle.length > 240) {
      throw new BadRequestException("OG title слишком длинный");
    }
    if (ogDescription && ogDescription.length > 500) {
      throw new BadRequestException("OG description слишком длинный");
    }
    if (ogImageUrl) this.assertSafeUrl(ogImageUrl);

    await this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `UPDATE site_page_version
         SET title=$4,
             meta_description=$5,
             meta_robots=$6,
             canonical_path=$7,
             og_title=$8,
             og_description=$9,
             og_image_url=$10
         WHERE tenant_id=$1
           AND page_id=$2
           AND id=$3
           AND status='DRAFT'
         RETURNING id`,
        [
          context.tenantId,
          pageId,
          versionId,
          title,
          meta,
          robots,
          canonicalPath,
          ogTitle,
          ogDescription,
          ogImageUrl
        ]
      );
      if (!result.rowCount) {
        throw new ConflictException("Изменять можно только DRAFT");
      }
    });
  }

  async replaceBlocks(
    context: TenantContext,
    pageId: string,
    versionId: string,
    input: {
      blocks: Array<{ type: BlockType; config: Record<string, unknown> }>;
    }
  ): Promise<{ blocks: number }> {
    if (!Array.isArray(input.blocks) || input.blocks.length > 100) {
      throw new BadRequestException("Допустимо от 0 до 100 блоков");
    }

    const prepared = input.blocks.map((block, index) => {
      if (!BLOCK_TYPES.has(block.type)) {
        throw new BadRequestException(
          "Неизвестный тип блока в позиции " + index
        );
      }
      return {
        type: block.type,
        config: this.validateBlock(block.type, block.config ?? {}),
        sortOrder: index
      };
    });

    if (JSON.stringify(prepared).length > 300000) {
      throw new BadRequestException("Страница слишком большая");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const version = await client.query(
        `SELECT 1 FROM site_page_version
         WHERE tenant_id=$1 AND page_id=$2 AND id=$3 AND status='DRAFT'
         FOR UPDATE`,
        [context.tenantId, pageId, versionId]
      );
      if (!version.rowCount) {
        throw new ConflictException("Редактировать можно только DRAFT");
      }

      await client.query(
        `DELETE FROM site_block
         WHERE tenant_id=$1 AND page_version_id=$2`,
        [context.tenantId, versionId]
      );

      for (const block of prepared) {
        await client.query(
          `INSERT INTO site_block(
             tenant_id,page_version_id,block_type,sort_order,config
           ) VALUES ($1,$2,$3,$4,$5)`,
          [
            context.tenantId,
            versionId,
            block.type,
            block.sortOrder,
            JSON.stringify(block.config)
          ]
        );
      }

      return { blocks: prepared.length };
    });
  }

  async publish(
    context: TenantContext,
    pageId: string,
    versionId: string
  ): Promise<{ publicUrl: string }> {
    return this.database.withTenantTransaction(context, async (client) => {
      const version = await client.query(
        `SELECT v.id,p.site_id,p.slug,s.public_slug
         FROM site_page_version v
         JOIN site_page p
           ON p.tenant_id=v.tenant_id AND p.id=v.page_id
         JOIN site s
           ON s.tenant_id=p.tenant_id AND s.id=p.site_id
         WHERE v.tenant_id=$1
           AND v.page_id=$2
           AND v.id=$3
           AND v.status='DRAFT'
           AND p.status='ACTIVE'
           AND s.status='ACTIVE'
         FOR UPDATE OF v,p,s`,
        [context.tenantId, pageId, versionId]
      );
      const row = version.rows[0];
      if (!row) {
        throw new ConflictException("Публиковать можно только DRAFT");
      }

      const blockCount = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM site_block
         WHERE tenant_id=$1 AND page_version_id=$2`,
        [context.tenantId, versionId]
      );
      if (Number(blockCount.rows[0]?.count ?? "0") === 0) {
        throw new BadRequestException("Нельзя опубликовать пустую страницу");
      }

      await client.query(
        `UPDATE site_page_version
         SET status='ARCHIVED'
         WHERE tenant_id=$1 AND page_id=$2 AND status='PUBLISHED'`,
        [context.tenantId, pageId]
      );

      await client.query(
        `UPDATE site_page_version
         SET status='PUBLISHED',
             published_at=now(),
             published_by_membership_id=$4
         WHERE tenant_id=$1 AND page_id=$2 AND id=$3`,
        [context.tenantId, pageId, versionId, context.membershipId]
      );

      await client.query(
        `UPDATE site_page
         SET published_version_id=$3,updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId, pageId, versionId]
      );

      await client.query(
        `INSERT INTO site_publish_event(
           tenant_id,site_id,page_id,version_id,actor_membership_id
         ) VALUES ($1,$2,$3,$4,$5)`,
        [
          context.tenantId,
          row.site_id,
          pageId,
          versionId,
          context.membershipId
        ]
      );

      await this.audit(
        client,
        context,
        "site.page_published",
        "site_page",
        pageId,
        { versionId }
      );

      return {
        publicUrl:
          "/s/" +
          row.public_slug +
          (row.slug === "/" ? "" : row.slug)
      };
    });
  }

  async publicPage(
    publicSlug: string,
    pageSlug?: string
  ): Promise<Record<string, unknown>> {
    const slug = this.publicSlug(publicSlug);
    const path =
      !pageSlug || pageSlug.trim() === "/"
        ? "/"
        : "/" + pageSlug.trim().replace(/^\/+|\/+$/g, "");

    const result = await this.database.query<{
      payload: Record<string, unknown> | null;
    }>(
      `SELECT corebiz_public_site_page($1,$2) AS payload`,
      [slug, path]
    );

    const payload = result.rows[0]?.payload;
    if (!payload) {
      throw new NotFoundException("Страница не опубликована");
    }
    return payload;
  }

  private validateBlock(
    type: BlockType,
    config: Record<string, unknown>
  ): Record<string, unknown> {
    const json = JSON.stringify(config);
    if (json.length > 20000) {
      throw new BadRequestException("Config блока слишком большой");
    }

    const text = (key: string, max: number, required = false) => {
      const value = config[key];
      if (value === undefined || value === null || value === "") {
        if (required) {
          throw new BadRequestException(type + ": требуется " + key);
        }
        return null;
      }
      if (typeof value !== "string" || value.length > max) {
        throw new BadRequestException(type + ": некорректный " + key);
      }
      return value.trim();
    };

    const safeHref = (key: string, required = false) => {
      const value = text(key, 2000, required);
      if (value) this.assertSafeUrl(value);
      return value;
    };

    if (type === "HERO") {
      return {
        heading: text("heading", 240, true),
        text: text("text", 2000),
        buttonLabel: text("buttonLabel", 80),
        buttonHref: safeHref("buttonHref"),
        imageUrl: safeHref("imageUrl")
      };
    }

    if (type === "TEXT") {
      return {
        heading: text("heading", 240),
        text: text("text", 8000, true)
      };
    }

    if (type === "IMAGE") {
      return {
        src: safeHref("src", true),
        alt: text("alt", 300, true),
        caption: text("caption", 1000)
      };
    }

    if (type === "CTA") {
      return {
        heading: text("heading", 240, true),
        text: text("text", 1200),
        buttonLabel: text("buttonLabel", 80, true),
        buttonHref: safeHref("buttonHref", true)
      };
    }

    if (type === "FEATURES") {
      const items = Array.isArray(config.items)
        ? config.items.slice(0, 12)
        : [];

      return {
        heading: text("heading", 240),
        items: items
          .map((item) => {
            const row =
              item && typeof item === "object"
                ? item as Record<string, unknown>
                : {};
            return {
              title: String(row.title ?? "").trim().slice(0, 160),
              text: String(row.text ?? "").trim().slice(0, 700)
            };
          })
          .filter((item) => item.title)
      };
    }

    if (type === "SPACER") {
      const size = Number(config.size ?? 32);
      return {
        size: Math.max(8, Math.min(160, Math.round(size)))
      };
    }

    if (["FORM","BOOKING","CATALOG","PRODUCT_GRID"].includes(type)) {
      const limitNumber = Number(config.limit ?? 12);
      return {
        heading: text("heading", 240),
        bindingId: text("bindingId", 200),
        limit: Number.isFinite(limitNumber)
          ? Math.max(1, Math.min(100, Math.round(limitNumber)))
          : 12
      };
    }

    throw new BadRequestException("Неизвестный тип блока");
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

  private slug(value: string): string {
    return value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9а-яё]+/giu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120);
  }

  private latinSlug(value: string): string {
    return value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  }

  private publicSlug(value: string): string {
    const slug = value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 81);

    if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(slug)) {
      throw new BadRequestException("Некорректный публичный адрес сайта");
    }
    return slug;
  }

  private async audit(
    client: import("pg").PoolClient,
    context: TenantContext,
    action: string,
    resourceType: string,
    resourceId: string,
    data?: Record<string, unknown>
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
        data ? JSON.stringify(data) : null
      ]
    );
  }

  private unique(error: unknown): boolean {
    return Boolean(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23505"
    );
  }
}
