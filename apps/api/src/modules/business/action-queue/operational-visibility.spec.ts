import {visibleOperationalCodes} from "./operational-visibility";

const visible=(...permissions:string[])=>visibleOperationalCodes(new Set(permissions));

describe("cross-vertical personal action queues",()=>{
  it("owners can review every operational exception",()=>{
    expect(visible("dashboard.owner.read")).toBeNull();
    expect(visible("*")).toBeNull();
  });
  it("warehouse operators see warehouse exceptions, not salaries or debts",()=>{
    const result=visible("wms.read");
    expect(result).toContain("WMS_TASK_FAILED");
    expect(result).not.toContain("FINANCE_OVERDUE");
    expect(result).not.toContain("PAYROLL_REVIEW_DISPUTED");
    expect(result).not.toContain("PROJECT_CLIENT_APPROVAL_OVERDUE");
  });
  it("marketplace operators can act on stale feed and failed stock but not on VAT",()=>{
    const result=visible("channels.read");
    expect(result).toEqual(expect.arrayContaining([
      "MARKETPLACE_UNMAPPED","MARKETPLACE_STOCK_BLOCKED","MARKETPLACE_FEED_STALE"
    ]));
    expect(result).not.toContain("VAT_UNREGISTERED");
    expect(result).not.toContain("BANK_UNMATCHED");
  });
  it("dance trainers see the broken reservations but cannot see company payroll disputes",()=>{
    const result=visible("dance.read");
    expect(result).toContain("DANCE_STRANDED_VISIT");
    expect(result).not.toContain("DANCE_MISSING_MARGIN");
    expect(result).not.toContain("PAYROLL_REVIEW_DISPUTED");
  });
  it("finance employees get receivables and payroll disputes, not CRM pipeline access",()=>{
    const result=visible("finance.read");
    expect(result).toContain("BANK_UNMATCHED");
    expect(result).toContain("FINANCE_OVERDUE");
    expect(result).toContain("PAYROLL_REVIEW_DISPUTED");
    expect(result).not.toContain("CRM_ACTION_OVERDUE");
  });
  it("accounting compliance rights reveal only permitted accounting items",()=>{
    expect(visible("accounting.compliance.read")).toEqual(["VAT_UNREGISTERED"]);
    expect(visible("accounting.read")).toEqual(["CLOSE_BLOCKED","PAYROLL_DRAFT"]);
  });
  it("a user with no operations permissions has no access to owner issues",()=>{
    expect(visible("profile.read")).toEqual([]);
  });
  it("specialized operations appear even without finance.read or owner rights",()=>{
    expect(visible("oms.read")).toContain("OMS_BACKORDER_OVERDUE");
    expect(visible("projects.read")).toContain("PROJECT_CLIENT_APPROVAL_OVERDUE");
  });
});
