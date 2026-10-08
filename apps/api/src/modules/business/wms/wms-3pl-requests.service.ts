import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { createHash } from "node:crypto";
import { DatabaseService } from "../../../infrastructure/database/database.service";

type RequestType = "DAMAGE"|"SHORTAGE"|"DELAY"|"DOCUMENT"|"GENERAL";
type Priority = "P1"|"P2"|"P3"|"P4";

@Injectable()
export class Wms3plRequestsService {
  constructor(private readonly database: DatabaseService) {}

  async queue(
    context: TenantContext,
    status?: string
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async client => {
      const result=await client.query(
        "SELECT r.id,r.request_number,r.request_type,r.priority,r.status,"+
        "r.subject,r.sla_due_at,r.first_response_at,r.resolved_at,r.created_at,"+
        "o.name AS owner_name,o.code AS owner_code,w.name AS warehouse_name,"+
        "r.assigned_membership_id,"+
        "(r.status NOT IN ('RESOLVED','CLOSED') AND r.sla_due_at<now()) AS sla_breached "+
        "FROM wms_3pl_client_request r "+
        "JOIN inventory_owner o ON o.tenant_id=r.tenant_id AND o.id=r.owner_id "+
        "LEFT JOIN warehouse w ON w.tenant_id=r.tenant_id AND w.id=r.warehouse_id "+
        "WHERE r.tenant_id=$1 AND ($2::text IS NULL OR r.status=$2) "+
        "ORDER BY CASE r.priority WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END,"+
        "r.sla_due_at,r.created_at LIMIT 1000",
        [context.tenantId,status??null]
      );
      return result.rows;
    });
  }

  async operatorDetail(
    context: TenantContext,
    requestId: string
  ): Promise<Record<string, unknown>> {
    return this.database.withTenantTransaction(context, async client => {
      const head=await client.query(
        "SELECT r.*,o.name AS owner_name,o.code AS owner_code,w.name AS warehouse_name "+
        "FROM wms_3pl_client_request r "+
        "JOIN inventory_owner o ON o.tenant_id=r.tenant_id AND o.id=r.owner_id "+
        "LEFT JOIN warehouse w ON w.tenant_id=r.tenant_id AND w.id=r.warehouse_id "+
        "WHERE r.tenant_id=$1 AND r.id=$2",
        [context.tenantId,requestId]
      );
      if(!head.rows[0]) throw new NotFoundException("Обращение не найдено");

      const messages=await client.query(
        "SELECT id,author_type,body,created_at,author_membership_id "+
        "FROM wms_3pl_client_request_message "+
        "WHERE tenant_id=$1 AND request_id=$2 ORDER BY created_at,id",
        [context.tenantId,requestId]
      );
      return {request:head.rows[0],messages:messages.rows};
    });
  }

  async operatorReply(
    context: TenantContext,
    requestId: string,
    input: {
      body: string;
      status?: "IN_PROGRESS"|"WAITING_CLIENT"|"RESOLVED"|"CLOSED";
      priority?: Priority;
    }
  ): Promise<void> {
    const body=this.body(input.body);

    await this.database.withTenantTransaction(context,async client=>{
      const request=await client.query<{status:string}>(
        "SELECT status FROM wms_3pl_client_request "+
        "WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [context.tenantId,requestId]
      );
      const row=request.rows[0];
      if(!row) throw new NotFoundException("Обращение не найдено");
      if(row.status==="CLOSED") throw new BadRequestException("Обращение закрыто");

      await client.query(
        "INSERT INTO wms_3pl_client_request_message("+
        "tenant_id,request_id,author_type,author_membership_id,body"+
        ") VALUES ($1,$2,'OPERATOR',$3,$4)",
        [context.tenantId,requestId,context.membershipId,body]
      );

      const nextStatus=input.status??(row.status==="OPEN"?"IN_PROGRESS":row.status);
      const priority=input.priority??null;

      await client.query(
        "UPDATE wms_3pl_client_request SET "+
        "status=$3,priority=COALESCE($4,priority),"+
        "assigned_membership_id=COALESCE(assigned_membership_id,$5),"+
        "first_response_at=COALESCE(first_response_at,now()),"+
        "resolved_at=CASE WHEN $3 IN ('RESOLVED','CLOSED') THEN COALESCE(resolved_at,now()) ELSE resolved_at END,"+
        "updated_at=now() WHERE tenant_id=$1 AND id=$2",
        [context.tenantId,requestId,nextStatus,priority,context.membershipId]
      );
    });
  }

  async publicList(token:string):Promise<Array<Record<string,unknown>>>{
    const access=await this.resolve(token);
    return this.database.withTenantTransaction(
      this.publicContext(access.tenantId),
      async client=>{
        const result=await client.query(
          "SELECT id,request_number,request_type,priority,status,subject,"+
          "sla_due_at,first_response_at,resolved_at,created_at "+
          "FROM wms_3pl_client_request "+
          "WHERE tenant_id=$1 AND owner_id=$2 ORDER BY created_at DESC LIMIT 500",
          [access.tenantId,access.ownerId]
        );
        return result.rows;
      }
    );
  }

  async publicDetail(
    token:string,
    requestId:string
  ):Promise<Record<string,unknown>>{
    const access=await this.resolve(token);
    return this.database.withTenantTransaction(
      this.publicContext(access.tenantId),
      async client=>{
        const head=await client.query(
          "SELECT id,request_number,request_type,priority,status,subject,"+
          "sla_due_at,first_response_at,resolved_at,created_at "+
          "FROM wms_3pl_client_request "+
          "WHERE tenant_id=$1 AND owner_id=$2 AND id=$3",
          [access.tenantId,access.ownerId,requestId]
        );
        if(!head.rows[0]) throw new NotFoundException("Обращение не найдено");

        const messages=await client.query(
          "SELECT id,author_type,body,created_at "+
          "FROM wms_3pl_client_request_message "+
          "WHERE tenant_id=$1 AND request_id=$2 ORDER BY created_at,id",
          [access.tenantId,requestId]
        );
        return {request:head.rows[0],messages:messages.rows};
      }
    );
  }

  async publicCreate(
    token:string,
    input:{
      requestType:RequestType;
      subject:string;
      body:string;
      warehouseId?:string;
      priority?: "P2"|"P3"|"P4";
    }
  ):Promise<{id:string;number:string}>{
    const access=await this.resolve(token);
    const subject=String(input.subject??"").trim();
    if(subject.length<3||subject.length>240){
      throw new BadRequestException("Тема от 3 до 240 символов");
    }
    const body=this.body(input.body);
    const priority=this.clientPriority(input.requestType,input.priority);

    return this.database.withTenantTransaction(
      this.publicContext(access.tenantId),
      async client=>{
        if(input.warehouseId){
          const contract=await client.query(
            "SELECT 1 FROM warehouse_3pl_contract "+
            "WHERE tenant_id=$1 AND warehouse_id=$2 AND owner_id=$3 AND status<>'CLOSED'",
            [access.tenantId,input.warehouseId,access.ownerId]
          );
          if(!contract.rowCount){
            throw new ForbiddenException("Склад не относится к владельцу");
          }
        }

        const counter=await client.query<{value:string}>(
          "INSERT INTO tenant_counter(tenant_id,counter_key,value) "+
          "VALUES ($1,'3pl_client_request',1) "+
          "ON CONFLICT (tenant_id,counter_key) DO UPDATE SET "+
          "value=tenant_counter.value+1,updated_at=now() RETURNING value::text",
          [access.tenantId]
        );
        const number="3PL-"+new Date().getUTCFullYear()+"-"+
          BigInt(counter.rows[0]?.value??"0").toString().padStart(6,"0");

        const due=new Date(Date.now()+this.slaHours(priority)*3600000);
        const request=await client.query<{id:string}>(
          "INSERT INTO wms_3pl_client_request("+
          "tenant_id,owner_id,warehouse_id,request_number,request_type,priority,"+
          "subject,sla_due_at,created_by_access_id"+
          ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
          [
            access.tenantId,access.ownerId,input.warehouseId??null,
            number,input.requestType,priority,subject,due,access.accessId
          ]
        );
        const id=request.rows[0]!.id;

        await client.query(
          "INSERT INTO wms_3pl_client_request_message("+
          "tenant_id,request_id,author_type,author_access_id,body"+
          ") VALUES ($1,$2,'CLIENT',$3,$4)",
          [access.tenantId,id,access.accessId,body]
        );

        return {id,number};
      }
    );
  }

  async publicReply(
    token:string,
    requestId:string,
    bodyInput:string
  ):Promise<void>{
    const access=await this.resolve(token);
    const body=this.body(bodyInput);

    await this.database.withTenantTransaction(
      this.publicContext(access.tenantId),
      async client=>{
        const request=await client.query<{status:string}>(
          "SELECT status FROM wms_3pl_client_request "+
          "WHERE tenant_id=$1 AND owner_id=$2 AND id=$3 FOR UPDATE",
          [access.tenantId,access.ownerId,requestId]
        );
        const row=request.rows[0];
        if(!row) throw new NotFoundException("Обращение не найдено");
        if(["RESOLVED","CLOSED"].includes(row.status)){
          throw new BadRequestException("Обращение завершено");
        }

        await client.query(
          "INSERT INTO wms_3pl_client_request_message("+
          "tenant_id,request_id,author_type,author_access_id,body"+
          ") VALUES ($1,$2,'CLIENT',$3,$4)",
          [access.tenantId,requestId,access.accessId,body]
        );

        await client.query(
          "UPDATE wms_3pl_client_request SET "+
          "status=CASE WHEN status='WAITING_CLIENT' THEN 'IN_PROGRESS' ELSE status END,"+
          "updated_at=now() WHERE tenant_id=$1 AND id=$2",
          [access.tenantId,requestId]
        );
      }
    );
  }

  private async resolve(token:string):Promise<{
    accessId:string;tenantId:string;ownerId:string;
  }>{
    if(!/^3pl_[A-Za-z0-9_-]{30,100}$/.test(token)){
      throw new ForbiddenException("Недействительный portal token");
    }
    const hash=createHash("sha256").update(token).digest("hex");
    const result=await this.database.query<{
      access_id:string;tenant_id:string;owner_id:string;
    }>(
      "SELECT * FROM corebiz_resolve_3pl_portal_access($1)",
      [hash]
    );
    const row=result.rows[0];
    if(!row) throw new ForbiddenException("Доступ истёк или отозван");
    return {
      accessId:row.access_id,
      tenantId:row.tenant_id,
      ownerId:row.owner_id
    };
  }

  private publicContext(tenantId:string):TenantContext{
    return {
      tenantId,
      userId:"00000000-0000-0000-0000-000000000000",
      membershipId:"00000000-0000-0000-0000-000000000000"
    };
  }

  private clientPriority(
    type:RequestType,
    requested?:"P2"|"P3"|"P4"
  ): "P2"|"P3"|"P4" {
    if(requested)return requested;
    return ["DAMAGE","SHORTAGE","DELAY"].includes(type)?"P2":"P3";
  }

  private slaHours(priority:Priority):number{
    if(priority==="P1")return 1;
    if(priority==="P2")return 4;
    if(priority==="P3")return 24;
    return 72;
  }

  private body(value:string):string{
    const body=String(value??"").trim();
    if(body.length<1||body.length>5000){
      throw new BadRequestException("Сообщение от 1 до 5000 символов");
    }
    return body;
  }
}
