import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req
} from "@nestjs/common";
import type { ApiSuccess, TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../../platform/auth/auth.types";
import { RequirePermission } from "../../platform/authorization/require-permission.decorator";
import { SupportService } from "./support.service";

@Controller("support")
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get("tickets")
  @RequirePermission("support.read")
  async tickets(@Req() request: AuthenticatedRequest): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.support.listTickets(this.context(request))
    };
  }

  @Post("tickets")
  @RequirePermission("support.write")
  async createTicket(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      subject: string;
      body: string;
      priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT";
      category?: string;
      contextUrl?: string;
      knowledgeSearchId?: string;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.support.createTicket(this.context(request), body)
    };
  }

  @Get("tickets/:id")
  @RequirePermission("support.read")
  async ticket(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.support.ticket(this.context(request), id)
    };
  }

  @Post("tickets/:id/reply")
  @RequirePermission("support.write")
  async reply(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: { body: string }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.support.reply(this.context(request), id, body.body)
    };
  }

  @Patch("tickets/:id/close")
  @RequirePermission("support.write")
  async close(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<{ closed: true }>> {
    await this.support.close(this.context(request), id);
    return { ok: true, data: { closed: true } };
  }

  @Post("attachments")
  @RequirePermission("support.write")
  async attachment(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      ticketId: string;
      messageId?: string;
      objectKey: string;
      filename: string;
      mimeType?: string;
      sizeBytes: string;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.support.registerAttachment(this.context(request), body)
    };
  }

  @Post("knowledge/search")
  @RequirePermission("support.read")
  async trackedKnowledge(
    @Req() request: AuthenticatedRequest,
    @Body() body: { query: string; contextUrl?: string }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.support.trackedKnowledgeSearch(
        this.context(request),
        body
      )
    };
  }

  @Post("knowledge/search/:id/select")
  @RequirePermission("support.read")
  async knowledgeSelect(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: { articleId: string }
  ): Promise<ApiSuccess<{ updated: true }>> {
    await this.support.markKnowledgeSelection(
      this.context(request),
      id,
      body.articleId
    );
    return { ok: true, data: { updated: true } };
  }

  @Post("knowledge/search/:id/feedback")
  @RequirePermission("support.read")
  async knowledgeFeedback(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: { helpful: boolean }
  ): Promise<ApiSuccess<{ updated: true }>> {
    await this.support.knowledgeFeedback(
      this.context(request),
      id,
      body.helpful === true
    );
    return { ok: true, data: { updated: true } };
  }

  @Get("knowledge/telemetry")
  @RequirePermission("support.telemetry.read")
  async knowledgeTelemetry(
    @Req() request: AuthenticatedRequest
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.support.knowledgeTelemetry(
        this.context(request)
      )
    };
  }

  @Get("knowledge")
  @RequirePermission("support.read")
  async knowledge(
    @Query("q") query = ""
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.support.searchKnowledge(query)
    };
  }

  @Post("grants")
  @RequirePermission("users.manage")
  async createGrant(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      hours?: number;
      scopes?: string[];
      reason?: string;
    }
  ): Promise<ApiSuccess<unknown>> {
    return {
      ok: true,
      data: await this.support.createTemporaryGrant(this.context(request), body)
    };
  }

  @Patch("grants/:id/revoke")
  @RequirePermission("users.manage")
  async revokeGrant(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string
  ): Promise<ApiSuccess<{ revoked: true }>> {
    await this.support.revokeGrant(this.context(request), id);
    return { ok: true, data: { revoked: true } };
  }

  private context(request: AuthenticatedRequest): TenantContext {
    const auth = request.auth!;
    return {
      tenantId: auth.tenantId,
      userId: auth.userId,
      membershipId: auth.membershipId
    };
  }
}
