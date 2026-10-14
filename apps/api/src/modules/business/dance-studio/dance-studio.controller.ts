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
import {DanceOperationsService} from "./dance-operations.service";
import {DanceCustomerPortalService} from "./dance-customer-portal.service";
import {DanceTrainerPortalService} from "./dance-trainer-portal.service";
import {DanceBudgetService} from "./dance-budget.service";

@Controller("dance")
export class DanceStudioController {
  constructor(
    private readonly studio:DanceStudioService,
    private readonly economics:DanceEconomicsService,
    private readonly operations:DanceOperationsService,
    private readonly portal:DanceCustomerPortalService,
    private readonly trainerPortal:DanceTrainerPortalService,
    private readonly budget:DanceBudgetService
  ) {}

  @Get("access")
  @RequirePermission("dance.read")
  async access(@Req() req:AuthenticatedRequest):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.studio.access(this.ctx(req))};
  }

  @Get("setup-doctor")
  @RequirePermission("dance.read")
  async setupDoctor(
    @Req() req:AuthenticatedRequest,
    @Query("scenario") scenario?:string
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.studio.setupDoctor(
      this.ctx(req),scenario??"two_branch_52"
    )};
  }

  @Get("readiness")
  @RequirePermission("dance.read")
  async readiness(@Req() req:AuthenticatedRequest):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.studio.readiness(this.ctx(req))};
  }

  @Get("operations/health")
  @RequirePermission("dance.read")
  async operationsHealth(@Req() req:AuthenticatedRequest):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.operations.health(this.ctx(req))};
  }

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

  @Get("makeup-credits")
  @RequirePermission("dance.read")
  async makeupCredits(
    @Req() req:AuthenticatedRequest,
    @Query("studentId") studentId?:string
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.studio.makeupCredits(this.ctx(req),studentId)
    };
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
  async programs(
    @Req() req:AuthenticatedRequest,
    @Query("includeArchived") includeArchived?:string
  ):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.studio.programs(
      this.ctx(req),includeArchived==="true"
    )};
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

  @Patch("programs/:programId")
  @RequirePermission("dance.write")
  async updateProgram(
    @Req() req:AuthenticatedRequest,
    @Param("programId") programId:string,
    @Body() body:{
      expectedRevision:string;name?:string;serviceId?:string;
      branchId?:string|null;minAge?:number|null;maxAge?:number|null;
      defaultDurationMinutes?:number
    }
  ):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.studio.changeProgram(
      this.ctx(req),programId,{...body,action:"UPDATE"}
    )};
  }

  @Post("programs/:programId/archive")
  @RequirePermission("dance.write")
  async archiveProgram(@Req() req:AuthenticatedRequest,
    @Param("programId") programId:string,
    @Body() body:{expectedRevision:string}
  ):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.studio.changeProgram(
      this.ctx(req),programId,{...body,action:"ARCHIVE"}
    )};
  }

  @Post("programs/:programId/restore")
  @RequirePermission("dance.write")
  async restoreProgram(@Req() req:AuthenticatedRequest,
    @Param("programId") programId:string,
    @Body() body:{expectedRevision:string}
  ):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.studio.changeProgram(
      this.ctx(req),programId,{...body,action:"RESTORE"}
    )};
  }

  @Get("groups")
  @RequirePermission("dance.read")
  async groups(@Req() req:AuthenticatedRequest,
    @Query("includeArchived") includeArchived?:string):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.studio.groups(
      this.ctx(req),includeArchived==="true"
    )};
  }

  @Post("groups/:groupId/lifecycle")
  @RequirePermission("dance.write")
  async groupLifecycle(@Req() req:AuthenticatedRequest,
    @Param("groupId") groupId:string,
    @Body() body:{action:"ARCHIVE"|"RESTORE";expectedVersion:number}
  ):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.studio.groupLifecycle(
      this.ctx(req),groupId,body
    )};
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
      roomZoneId?:string;
      roomCapacityUnits?:number;
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

  @Get("groups/:groupId/impact")
  @RequirePermission("dance.read")
  async groupImpact(@Req() req:AuthenticatedRequest,
    @Param("groupId") groupId:string):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.studio.groupChangeImpact(
      this.ctx(req),groupId
    )};
  }

  @Patch("groups/:groupId")
  @RequirePermission("dance.write")
  async updateGroup(
    @Req() req:AuthenticatedRequest,
    @Param("groupId") groupId:string,
    @Body() body:{
      name?:string;
      branchId?:string|null;
      trainerResourceId?:string;
      roomResourceId?:string|null;
      roomZoneId?:string|null;
      roomCapacityUnits?:number;
      capacity?:number;
      breakEvenMembers?:number;
      startsOn?:string;
      endsOn?:string|null;
      schedule?:Array<{
        weekday:number;
        startMinute:number;
        durationMinutes?:number;
      }>;
      version:number;
      acknowledgeFutureLessonsUnchanged?:boolean;
    }
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.studio.updateGroup(this.ctx(req),groupId,body)
    };
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
      lessonType?:"GROUP"|"INDIVIDUAL"|"TRIAL"|"MASTER_CLASS"|"OPEN_CLASS"|"REHEARSAL"|"RENTAL_EVENT"|"SELF_PRACTICE";
      serviceId?:string;
      trainerResourceId?:string;
      roomResourceId?:string;
      roomZoneId?:string;
      roomCapacityUnits?:number;
      startsAt:string;
      durationMinutes?:number;
      capacity?:number;
      idempotencyKey:string;
    }
  ):Promise<ApiSuccess<unknown>> {
    return {ok:true,data:await this.studio.createLesson(this.ctx(req),body)};
  }

  @Patch("lessons/:lessonId")
  @RequirePermission("dance.write")
  async updateLesson(
    @Req() req:AuthenticatedRequest,
    @Param("lessonId") lessonId:string,
    @Body() body:{
      startsAt?:string;
      durationMinutes?:number;
      trainerResourceId?:string|null;
      roomResourceId?:string|null;
      roomZoneId?:string|null;
      roomCapacityUnits?:number;
      capacity?:number;
      version:number;
    }
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.studio.updateLesson(this.ctx(req),lessonId,body)
    };
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
      makeupCreditId?:string;
      chargeMinor?:string;
      priceSource?:"DIRECT"|"TRIAL"|"FREE"|"MAKEUP";
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
    @Body() body:{startsOn:string;endsOn:string;reason?:string;cancelFutureReservations?:boolean}
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
  @RequirePermission("finance.write")
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
      requestKey?:string;
    }
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.economics.createCharge(this.ctx(req),studentId,body)
    };
  }

  @Get("payroll-profiles")
  @RequirePermission("dance.read")
  async payrollProfiles(
    @Req() req:AuthenticatedRequest
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.economics.payrollProfiles(this.ctx(req))
    };
  }

  @Post("payroll-profiles")
  @RequirePermission("finance.write")
  async upsertPayrollProfile(
    @Req() req:AuthenticatedRequest,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.economics.upsertPayrollProfile(this.ctx(req),body)
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

  @Post("compensation-plans/:planId/archive")
  @RequirePermission("finance.write")
  async archiveCompensationPlan(
    @Req() req:AuthenticatedRequest,
    @Param("planId") planId:string
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.economics.archiveCompensationPlan(
        this.ctx(req),planId
      )
    };
  }

  @Post("compensation-plans")
  @RequirePermission("finance.write")
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

  @Get("payroll-statements")
  @RequirePermission("dance.read")
  async payrollStatements(
    @Req() req:AuthenticatedRequest,
    @Query("from") from?:string,
    @Query("to") to?:string
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.economics.payrollStatements(
        this.ctx(req),{from,to}
      )
    };
  }

  @Get("payroll-statements/:statementId")
  @RequirePermission("dance.read")
  async payrollStatementDetails(
    @Req() req:AuthenticatedRequest,
    @Param("statementId") statementId:string
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.economics.payrollStatementDetails(
        this.ctx(req),statementId
      )
    };
  }

  @Post("payroll-statements/:statementId/review")
  @RequirePermission("dance.read")
  async reviewPayrollStatement(
    @Req() req:AuthenticatedRequest,
    @Param("statementId") statementId:string,
    @Body() body:{
      status:"ACKNOWLEDGED"|"DISPUTED";
      comment?:string;
    }
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.economics.reviewPayrollStatement(
        this.ctx(req),statementId,body
      )
    };
  }

  @Post("payroll-reviews/:reviewId/resolve")
  @RequirePermission("finance.write")
  async resolvePayrollReview(
    @Req() req:AuthenticatedRequest,
    @Param("reviewId") reviewId:string,
    @Body() body:{
      status:"RESOLVED"|"WAIVED";
      comment:string;
    }
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.economics.resolvePayrollReview(
        this.ctx(req),reviewId,body
      )
    };
  }

  @Post("payroll-statements/:statementId/adjustments")
  @RequirePermission("finance.write")
  async addPayrollAdjustment(
    @Req() req:AuthenticatedRequest,
    @Param("statementId") statementId:string,
    @Body() body:{
      type:"BONUS"|"DEDUCTION"|"CORRECTION"|"OTHER";
      amountMinor:string;
      reason:string;
    }
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.economics.addPayrollAdjustment(
        this.ctx(req),statementId,body
      )
    };
  }

  @Post("compensation/approve")
  @RequirePermission("finance.write")
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

  @Get("room-statements")
  @RequirePermission("dance.read")
  async roomStatements(
    @Req() req:AuthenticatedRequest,
    @Query("month") month?:string
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.economics.roomStatements(this.ctx(req),month)
    };
  }

  @Post("room-statements/finalize")
  @RequirePermission("finance.write")
  async finalizeRoomStatements(
    @Req() req:AuthenticatedRequest,
    @Body() body:{month:string}
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.economics.finalizeRoomStatements(
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
  @RequirePermission("finance.write")
  async createRoomContract(
    @Req() req:AuthenticatedRequest,
    @Body() body:any
  ):Promise<ApiSuccess<unknown>> {
    return {
      ok:true,
      data:await this.economics.createRoomContract(this.ctx(req),body)
    };
  }

  @Get("rental-income")
  @RequirePermission("finance.read")
  async rentalIncome(@Req() req:AuthenticatedRequest,
    @Query("month") month:string):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.budget.rentalIncome(this.ctx(req),month)};
  }

  @Get("budget")
  @RequirePermission("finance.read")
  async budgetPlan(@Req() req:AuthenticatedRequest,
    @Query("month") month:string):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.budget.read(this.ctx(req),month)};
  }

  @Patch("budget")
  @RequirePermission("finance.write")
  async saveBudget(@Req() req:AuthenticatedRequest,
    @Body() body:{
      month:string;expectedVersion:number;
      values:Record<
        "revenueMinor"|"rentBranchAMinor"|"rentBranchBMinor"|
        "managersMinor"|"trainersMinor"|"taxesMinor"|"otherMinor"|"subleaseMinor",
        string|null
      >;
    }):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.budget.save(this.ctx(req),body)};
  }

  @Post("trainer/link")
  @RequirePermission("users.manage")
  async linkTrainer(@Req() req:AuthenticatedRequest,
    @Body() body:{membershipId:string;resourceId:string}):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.trainerPortal.link(this.ctx(req),body)};
  }

  @Get("trainer/me")
  @RequirePermission("dance.trainer.read")
  async myTrainerCalendar(@Req() req:AuthenticatedRequest,
    @Query("from") from:string,@Query("to") to:string):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.trainerPortal.self(this.ctx(req),from,to)};
  }

  @Get("portal/accounts")
  @RequirePermission("users.manage")
  async customerAccounts(@Req() req:AuthenticatedRequest):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.portal.accounts(this.ctx(req))};
  }

  @Post("portal/accounts/:membershipId/revoke")
  @RequirePermission("users.manage")
  async revokeCustomer(@Req() req:AuthenticatedRequest,
    @Param("membershipId") membershipId:string):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.portal.revoke(this.ctx(req),membershipId)};
  }

  @Post("portal/link")
  @RequirePermission("users.manage")
  async linkCustomer(
    @Req() req:AuthenticatedRequest,
    @Body() body:{membershipId:string;partyId:string}
  ):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.portal.link(this.ctx(req),body)};
  }

  @Get("portal/me")
  @RequirePermission("dance.portal.read")
  async customerPortal(@Req() req:AuthenticatedRequest):Promise<ApiSuccess<unknown>>{
    return {ok:true,data:await this.portal.self(this.ctx(req))};
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
