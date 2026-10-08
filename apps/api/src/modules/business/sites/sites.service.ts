import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
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

@Injectable()
export class SitesService {
  constructor(private readonly database: DatabaseService) {}

  async sites(context: TenantContext): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT s.id,s.name,s.code,s.status,s.created_at,s.updated_at,
                count(p.id)::int AS pages
         FROM site s
         LEFT JOIN site_page p
           ON p.tenant_id=s.tenant_id AND p.site_id=s.id AND p.status='ACTIVE'
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
    input: { name: string; code?: string }
  ): Promise<{ id: string; code: string }> {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 160) {
      throw new BadRequestException("Некорректное название сайта");
    }

    const code = this.slug(input.code?.trim() || name);
    if (!code) throw new BadRequestException("Некорректный код сайта");

    return this.database.withTenantTransaction(context, async (client) => {
      try {
        const result = await client.query<{ id: string; code: string }>(
          `INSERT INTO site(
             tenant_id,name,code,created_by_membership_id
           ) VALUES ($1,$2,$3,$4)
           RETURNING id,code`,
          [context.tenantId,name,code,context.membershipId]
        );
        return result.rows[0]!;
      } catch (error) {
        if (this.unique(error)) {
          throw new ConflictException("Сайт с таким кодом уже существует");
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
        [context.tenantId,siteId]
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
    const name = input.name.trim();
    if (name.length < 2 || name.length > 200) {
      throw new BadRequestException("Некорректное название страницы");
    }
    const slug = input.pageType === "HOME"
      ? "/"
      : "/" + this.slug(input.slug?.trim() || name);

    return this.database.withTenantTransaction(context, async (client) => {
      const site = await client.query(
        `SELECT 1 FROM site
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
        [context.tenantId,siteId]
      );
      if (!site.rowCount) throw new NotFoundException("Сайт не найден");

      try {
        const page = await client.query<{ id: string }>(
          `INSERT INTO site_page(
             tenant_id,site_id,name,slug,page_type,created_by_membership_id
           ) VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING id`,
          [
            context.tenantId,siteId,name,slug,
            input.pageType ?? "CONTENT",
            context.membershipId
          ]
        );

        const pageId=page.rows[0]!.id;
        const version=await client.query<{id:string}>(
          `INSERT INTO site_page_version(
             tenant_id,page_id,version_no,title,created_by_membership_id
           ) VALUES ($1,$2,1,$3,$4)
           RETURNING id`,
          [
            context.tenantId,pageId,
            input.title?.trim() || name,
            context.membershipId
          ]
        );

        return {id:pageId,versionId:version.rows[0]!.id};
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
      const page=await client.query(
        `SELECT p.id,p.site_id,p.name,p.slug,p.page_type,p.published_version_id
         FROM site_page p
         WHERE p.tenant_id=$1 AND p.id=$2 AND p.status='ACTIVE'`,
        [context.tenantId,pageId]
      );
      if(!page.rows[0]) throw new NotFoundException("Страница не найдена");

      const version=await client.query(
        versionId
          ? `SELECT * FROM site_page_version
             WHERE tenant_id=$1 AND page_id=$2 AND id=$3`
          : `SELECT * FROM site_page_version
             WHERE tenant_id=$1 AND page_id=$2
             ORDER BY version_no DESC LIMIT 1`,
        versionId
          ? [context.tenantId,pageId,versionId]
          : [context.tenantId,pageId]
      );
      if(!version.rows[0]) throw new NotFoundException("Версия не найдена");

      const blocks=await client.query(
        `SELECT id,block_type,sort_order,config,created_at,updated_at
         FROM site_block
         WHERE tenant_id=$1 AND page_version_id=$2
         ORDER BY sort_order`,
        [context.tenantId,version.rows[0].id]
      );

      return {page:page.rows[0],version:version.rows[0],blocks:blocks.rows};
    });
  }

  async createDraft(
    context: TenantContext,
    pageId: string
  ): Promise<{ versionId: string; versionNo: number }> {
    return this.database.withTenantTransaction(context, async (client) => {
      const current=await client.query<{
        id:string; version_no:number; title:string; meta_description:string|null;
      }>(
        `SELECT id,version_no,title,meta_description
         FROM site_page_version
         WHERE tenant_id=$1 AND page_id=$2
         ORDER BY version_no DESC
         LIMIT 1
         FOR UPDATE`,
        [context.tenantId,pageId]
      );
      const row=current.rows[0];
      if(!row) throw new NotFoundException("Страница не найдена");

      const existingDraft=await client.query<{id:string;version_no:number}>(
        `SELECT id,version_no
         FROM site_page_version
         WHERE tenant_id=$1 AND page_id=$2 AND status='DRAFT'
         ORDER BY version_no DESC LIMIT 1`,
        [context.tenantId,pageId]
      );
      if(existingDraft.rows[0]){
        return {
          versionId:existingDraft.rows[0].id,
          versionNo:existingDraft.rows[0].version_no
        };
      }

      const next=row.version_no+1;
      const version=await client.query<{id:string}>(
        `INSERT INTO site_page_version(
           tenant_id,page_id,version_no,title,meta_description,created_by_membership_id
         ) VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id`,
        [
          context.tenantId,pageId,next,row.title,row.meta_description,
          context.membershipId
        ]
      );
      const versionId=version.rows[0]!.id;

      await client.query(
        `INSERT INTO site_block(
           tenant_id,page_version_id,block_type,sort_order,config
         )
         SELECT tenant_id,$3,block_type,sort_order,config
         FROM site_block
         WHERE tenant_id=$1 AND page_version_id=$2
         ORDER BY sort_order`,
        [context.tenantId,row.id,versionId]
      );

      return {versionId,versionNo:next};
    });
  }

  async saveMeta(
    context: TenantContext,
    pageId: string,
    versionId: string,
    input:{title:string;metaDescription?:string}
  ):Promise<void>{
    const title=input.title.trim();
    if(title.length<1||title.length>240){
      throw new BadRequestException("Некорректный title");
    }
    const meta=input.metaDescription?.trim()||null;
    if(meta && meta.length>500){
      throw new BadRequestException("Meta description слишком длинный");
    }

    await this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `UPDATE site_page_version
         SET title=$4,meta_description=$5
         WHERE tenant_id=$1 AND page_id=$2 AND id=$3 AND status='DRAFT'
         RETURNING id`,
        [context.tenantId,pageId,versionId,title,meta]
      );
      if(!result.rowCount) throw new ConflictException("Изменять можно только DRAFT");
    });
  }

  async replaceBlocks(
    context: TenantContext,
    pageId:string,
    versionId:string,
    input:{blocks:Array<{type:BlockType;config:Record<string,unknown>}>}
  ):Promise<{blocks:number}>{
    if(!Array.isArray(input.blocks)||input.blocks.length>100){
      throw new BadRequestException("Допустимо от 0 до 100 блоков");
    }

    const prepared=input.blocks.map((block,index)=>({
      type:block.type,
      config:this.validateBlock(block.type,block.config??{}),
      sortOrder:index
    }));

    return this.database.withTenantTransaction(context,async client=>{
      const version=await client.query(
        `SELECT 1 FROM site_page_version
         WHERE tenant_id=$1 AND page_id=$2 AND id=$3 AND status='DRAFT'
         FOR UPDATE`,
        [context.tenantId,pageId,versionId]
      );
      if(!version.rowCount) throw new ConflictException("Редактировать можно только DRAFT");

      await client.query(
        `DELETE FROM site_block
         WHERE tenant_id=$1 AND page_version_id=$2`,
        [context.tenantId,versionId]
      );

      for(const block of prepared){
        await client.query(
          `INSERT INTO site_block(
             tenant_id,page_version_id,block_type,sort_order,config
           ) VALUES ($1,$2,$3,$4,$5)`,
          [
            context.tenantId,versionId,block.type,block.sortOrder,
            JSON.stringify(block.config)
          ]
        );
      }

      return {blocks:prepared.length};
    });
  }

  async publish(
    context:TenantContext,
    pageId:string,
    versionId:string
  ):Promise<void>{
    await this.database.withTenantTransaction(context,async client=>{
      const version=await client.query(
        `SELECT id FROM site_page_version
         WHERE tenant_id=$1 AND page_id=$2 AND id=$3 AND status='DRAFT'
         FOR UPDATE`,
        [context.tenantId,pageId,versionId]
      );
      if(!version.rowCount) throw new ConflictException("Публиковать можно только DRAFT");

      await client.query(
        `UPDATE site_page_version
         SET status='ARCHIVED'
         WHERE tenant_id=$1 AND page_id=$2 AND status='PUBLISHED'`,
        [context.tenantId,pageId]
      );

      await client.query(
        `UPDATE site_page_version
         SET status='PUBLISHED',published_at=now(),published_by_membership_id=$4
         WHERE tenant_id=$1 AND page_id=$2 AND id=$3`,
        [context.tenantId,pageId,versionId,context.membershipId]
      );

      await client.query(
        `UPDATE site_page
         SET published_version_id=$3,updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,pageId,versionId]
      );
    });
  }

  private validateBlock(type:BlockType,config:Record<string,unknown>):Record<string,unknown>{
    const json=JSON.stringify(config);
    if(json.length>20000) throw new BadRequestException("Config блока слишком большой");

    const text=(key:string,max:number,required=false)=>{
      const value=config[key];
      if(value===undefined||value===null||value===""){
        if(required) throw new BadRequestException(type+": требуется "+key);
        return null;
      }
      if(typeof value!=="string"||value.length>max){
        throw new BadRequestException(type+": некорректный "+key);
      }
      return value;
    };

    if(type==="HERO"){
      return {
        heading:text("heading",240,true),
        text:text("text",2000),
        buttonLabel:text("buttonLabel",80),
        buttonHref:text("buttonHref",500),
        imageUrl:text("imageUrl",2000)
      };
    }
    if(type==="TEXT"){
      return {heading:text("heading",240),text:text("text",8000,true)};
    }
    if(type==="IMAGE"){
      return {
        src:text("src",2000,true),
        alt:text("alt",300,true),
        caption:text("caption",1000)
      };
    }
    if(type==="CTA"){
      return {
        heading:text("heading",240,true),
        text:text("text",1200),
        buttonLabel:text("buttonLabel",80,true),
        buttonHref:text("buttonHref",500,true)
      };
    }
    if(type==="FEATURES"){
      const items=Array.isArray(config.items)?config.items.slice(0,12):[];
      return {
        heading:text("heading",240),
        items:items.map((item)=>{
          const row=item&&typeof item==="object"?item as Record<string,unknown>:{};
          return {
            title:String(row.title??"").slice(0,160),
            text:String(row.text??"").slice(0,700)
          };
        }).filter(x=>x.title)
      };
    }
    if(type==="SPACER"){
      const size=Number(config.size??32);
      return {size:Math.max(8,Math.min(160,Math.round(size)))};
    }

    if(["FORM","BOOKING","CATALOG","PRODUCT_GRID"].includes(type)){
      return {
        heading:text("heading",240),
        bindingId:text("bindingId",200),
        limit:Math.max(1,Math.min(100,Math.round(Number(config.limit??12))))
      };
    }

    throw new BadRequestException("Неизвестный тип блока");
  }

  private slug(value:string):string{
    return value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9а-яё]+/giu,"-")
      .replace(/^-+|-+$/g,"")
      .slice(0,120);
  }

  private unique(error:unknown):boolean{
    return Boolean(error&&typeof error==="object"&&"code" in error&&error.code==="23505");
  }
}
