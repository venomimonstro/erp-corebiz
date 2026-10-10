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
import { DanceEconomicsService } from "./dance-economics.service";
import { DanceStudioService } from "./dance-studio.service";

@Controller("dance")
export class DanceStudioController {
  constructor(
    private readonly studio:DanceStudioService,
    private readonly economics:DanceEconomicsService
  ) {}

  @Get("dashboard")
  @RequirePermission("dance.read")
  async dashboard(@Req() req:AuthenticatedRequest):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.studio.dashboard(this.ctx(req))};
  }

  @Get("students")
  @RequirePermission("dance.read")
  async students(@Req() req:AuthenticatedRequest):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.studio.students(this.ctx(req))};
  }

  @Post("students")
  @RequirePermission("dance.write")
  async createStudent(
    @Req() req:AuthenticatedRequest,
    @Body() body:{
      partyId:string;
      birthDate?:string;
      trainingLevel?:"BEGINNER"|"INTERMEDIATE"|"ADVANCED";
      status?:"LEAD"|"TRIAL"|"ACTIVE"|"PAUSED";
      preferredBranchId?:string;
      payerPartyId?:string;
      payerRelation?:"PARENT"|"GUARDIAN"|"PAYER";
    }
  ):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.studio.createStudent(this.ctx(req),body)};
  }

  @Post("students/:studentId/relationships")
  @RequirePermission("dance.write")
  async addRelationship(
    @Req() req:AuthenticatedRequest,
    @Param("studentId") studentId:string,
    @Body() body:{
      partyId:string;
      relationType:"PARENT"|"GUARDIAN"|"PAYER"|"FAMILY_MEMBER"|"EMERGENCY_CONTACT";
      isPrimary?:boolean;
    }
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.studio.addRelationship(this.ctx(req),studentId,body)
    };
  }

  @Get("programs")
  @RequirePermission("dance.read")
  async programs(@Req() req:AuthenticatedRequest):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.studio.programs(this.ctx(req))};
  }

  @Post("programs")
  @RequirePermission("dance.write")
  async createProgram(
    @Req() req:AuthenticatedRequest,
    @Body() body:{
      name:string;
      code?:string;
      serviceId:string;
      branchId?:string;
      minAge?:number;
      maxAge?:number;
      defaultDurationMinutes?:number;
    }
  ):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.studio.createProgram(this.ctx(req),body)};
  }

  @Get("groups")
  @RequirePermission("dance.read")
  async groups(@Req() req:AuthenticatedRequest):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.studio.groups(this.ctx(req))};
  }

  @Post("groups")
  @RequirePermission("dance.write")
  async createGroup(
    @Req() req:AuthenticatedRequest,
    @Body() body:{
      programId:string;
      name:string;
      branchId?:string;
      trainerResourceId:string;
      roomResourceId?:string;
      capacity:number;
      breakEvenMembers?:number;
      startsOn?:string;
      endsOn?:string;
      schedule?:Array<{
        weekday:number;
        startMinute:number;
        durationMinutes?:number;
      }>;
    }
  ):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.studio.createGroup(this.ctx(req),body)};
  }

  @Get("groups/:groupId/members")
  @RequirePermission("dance.read")
  async groupMembers(
    @Req() req:AuthenticatedRequest,
    @Param("groupId") groupId:string
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.studio.groupMembers(this.ctx(req),groupId)
    };
  }

  @Post("groups/:groupId/sync-roster")
  @RequirePermission("dance.write")
  async syncRoster(
    @Req() req:AuthenticatedRequest,
    @Param("groupId") groupId:string
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.studio.syncGroupRoster(this.ctx(req),groupId)
    };
  }

  @Patch("groups/:groupId/members/:memberId")
  @RequirePermission("dance.write")
  async groupMemberStatus(
    @Req() req:AuthenticatedRequest,
    @Param("groupId") groupId:string,
    @Param("memberId") memberId:string,
    @Body() body:{
      status:"ACTIVE"|"PAUSED"|"LEFT";
      keepPlace?:boolean;
    }
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.studio.changeGroupMemberStatus(
        this.ctx(req),groupId,memberId,body
      )
    };
  }

  @Post("groups/:groupId/members")
  @RequirePermission("dance.write")
  async addGroupMember(
    @Req() req:AuthenticatedRequest,
    @Param("groupId") groupId:string,
    @Body() body:{
      studentId:string;
      status?:"TRIAL"|"ACTIVE";
      discountBps?:number;
      allowWaitlist?:boolean;
      overrideEligibility?:boolean;
      overrideReason?:string;
    }
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.studio.addGroupMember(this.ctx(req),groupId,body)
    };
  }

  @Post("groups/:groupId/lessons/generate")
  @RequirePermission("dance.write")
  async generateLessons(
    @Req() req:AuthenticatedRequest,
    @Param("groupId") groupId:string,
    @Body() body:{from:string;to:string}
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.studio.generateGroupLessons(this.ctx(req),groupId,body)
    };
  }

  @Get("lessons")
  @RequirePermission("dance.read")
  async lessons(
    @Req() req:AuthenticatedRequest,
    @Query("from") from?:string,
    @Query("to") to?:string
  ):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.studio.lessons(this.ctx(req),{from,to})};
  }

  @Post("lessons")
  @RequirePermission("dance.write")
  async createLesson(
    @Req() req:AuthenticatedRequest,
    @Body() body:{
      groupId?:string;
      lessonType?:"GROUP"|"INDIVIDUAL"|"TRIAL"|"MASTER_CLASS"|"OPEN_CLASS"|"REHEARSAL"|"RENTAL_EVENT";
      serviceId?:string;
      trainerResourceId?:string;
      roomResourceId?:string;
      startsAt:string;
      durationMinutes?:number;
      capacity?:number;
      idempotencyKey:string;
    }
  ):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.studio.createLesson(this.ctx(req),body)};
  }

  @Get("lessons/:lessonId/participants")
  @RequirePermission("dance.read")
  async participants(
    @Req() req:AuthenticatedRequest,
    @Param("lessonId") lessonId:string
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.studio.participants(this.ctx(req),lessonId)
    };
  }

  @Post("lessons/:lessonId/participants")
  @RequirePermission("dance.write")
  async addParticipant(
    @Req() req:AuthenticatedRequest,
    @Param("lessonId") lessonId:string,
    @Body() body:{
      studentId:string;
      packageId?:string;
      chargeMinor?:string;
      allowWaitlist?:boolean;
    }
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.studio.addParticipant(this.ctx(req),lessonId,body)
    };
  }

  @Patch("lessons/:lessonId/participants/:participantId/attendance")
  @RequirePermission("dance.write")
  async attendance(
    @Req() req:AuthenticatedRequest,
    @Param("lessonId") lessonId:string,
    @Param("participantId") participantId:string,
    @Body() body:{
      status:"BOOKED"|"ATTENDED"|"LATE"|"NO_SHOW"|"EXCUSED_ABSENCE"|"CANCELLED_IN_TIME"|"CANCELLED_LATE";
      version:number;
    }
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.studio.markAttendance(
        this.ctx(req),lessonId,participantId,body
      )
    };
  }

  @Post("lessons/:lessonId/complete")
  @RequirePermission("dance.write")
  async complete(
    @Req() req:AuthenticatedRequest,
    @Param("lessonId") lessonId:string
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.economics.completeLesson(this.ctx(req),lessonId)
    };
  }

  @Post("lessons/:lessonId/cancel")
  @RequirePermission("dance.write")
  async cancel(
    @Req() req:AuthenticatedRequest,
    @Param("lessonId") lessonId:string,
    @Body() body:{byTrainer?:boolean;reason:string}
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.economics.cancelLesson(this.ctx(req),lessonId,body)
    };
  }

  @Post("packages/:packageId/beneficiaries")
  @RequirePermission("dance.write")
  async packageBeneficiary(
    @Req() req:AuthenticatedRequest,
    @Param("packageId") packageId:string,
    @Body() body:{studentId:string}
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.studio.addPackageBeneficiary(
        this.ctx(req),packageId,body
      )
    };
  }

  @Post("packages/:packageId/freeze")
  @RequirePermission("dance.write")
  async freeze(
    @Req() req:AuthenticatedRequest,
    @Param("packageId") packageId:string,
    @Body() body:{startsOn:string;endsOn:string;reason?:string}
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.studio.freezePackage(this.ctx(req),packageId,body)
    };
  }

  @Get("charges")
  @RequirePermission("dance.read")
  async charges(
    @Req() req:AuthenticatedRequest,
    @Query("studentId") studentId?:string
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.economics.charges(this.ctx(req),studentId)
    };
  }

  @Post("students/:studentId/charges")
  @RequirePermission("dance.write")
  async createCharge(
    @Req() req:AuthenticatedRequest,
    @Param("studentId") studentId:string,
    @Body() body:{
      payerPartyId?:string;
      sourceType?:"PACKAGE"|"LESSON"|"INSTALLMENT"|"OTHER";
      sourceId?:string;
      amountMinor:string;
      dueAt?:string;
      note?:string;
    }
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.economics.createCharge(this.ctx(req),studentId,body)
    };
  }

  @Get("compensation-plans")
  @RequirePermission("dance.read")
  async compensationPlans(
    @Req() req:AuthenticatedRequest
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.economics.compensationPlans(this.ctx(req))
    };
  }

  @Post("compensation-plans")
  @RequirePermission("dance.write")
  async createCompensationPlan(
    @Req() req:AuthenticatedRequest,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.economics.createCompensationPlan(this.ctx(req),body)
    };
  }

  @Get("compensation-accruals")
  @RequirePermission("dance.read")
  async compensationAccruals(
    @Req() req:AuthenticatedRequest,
    @Query("from") from?:string,
    @Query("to") to?:string
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.economics.compensationAccruals(
        this.ctx(req),{from,to}
      )
    };
  }

  @Post("compensation/approve")
  @RequirePermission("dance.write")
  async approveCompensation(
    @Req() req:AuthenticatedRequest,
    @Body() body:{from:string;to:string}
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.economics.approveCompensation(this.ctx(req),body)
    };
  }

  @Post("compensation/export-payroll")
  @RequirePermission("accounting.policy.manage")
  async exportPayroll(
    @Req() req:AuthenticatedRequest,
    @Body() body:{batchId:string;from:string;to:string}
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.economics.exportCompensationToPayroll(
        this.ctx(req),body
      )
    };
  }

  @Get("room-contracts")
  @RequirePermission("dance.read")
  async roomContracts(
    @Req() req:AuthenticatedRequest
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.economics.roomContracts(this.ctx(req))
    };
  }

  @Post("room-contracts")
  @RequirePermission("dance.write")
  async createRoomContract(
    @Req() req:AuthenticatedRequest,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.economics.createRoomContract(this.ctx(req),body)
    };
  }

  private ctx(req:AuthenticatedRequest):TenantContext {
    const a=req.auth!;
    return {
      tenantId:a.tenantId,
      userId:a.userId,
      membershipId:a.membershipId
    };
  }
}
