import {BUSINESS_VERTICAL_LIST} from "../../platform/customization/business-verticals";
import {
  isCompleteOperationalScan,OPERATIONAL_SCAN_LIMIT,
  VERTICAL_OPERATIONAL_RULES,VERTICAL_OPERATIONAL_RULE_BY_CODE
} from "./vertical-operational-rules";

describe("cross-vertical operational scenarios",()=>{
  it("covers all deployed verticals, not just the owner dashboard's finance widgets",()=>{
    const permissions=new Set(VERTICAL_OPERATIONAL_RULES.map(rule=>rule.permission));
    const linked:Record<string,string>={
      crm:"crm.read",sales:"sales.read",procurement:"procurement.read",
      service:"service.read",dance:"dance.read",projects:"projects.read",
      inventory:"sales.read",finance:"finance.read",
      channels:"channels.read",oms:"channels.read",wms:"wms.read",
      support:"support.read"
    };
    for(const vertical of BUSINESS_VERTICAL_LIST){
      const processCoverage=vertical.enabledCapabilities.some(capability=>
        linked[capability]!==undefined&&permissions.has(linked[capability]!)
      );
      expect(processCoverage).toBe(true);
      expect(vertical.operatingFlows.length).toBeGreaterThan(0);
    }
  });

  it("enforces bounded tenant isolation and stable issue identities",()=>{
    expect(VERTICAL_OPERATIONAL_RULE_BY_CODE.size)
      .toBe(VERTICAL_OPERATIONAL_RULES.length);
    for(const rule of VERTICAL_OPERATIONAL_RULES){
      expect(rule.code).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(rule.label.length).toBeGreaterThan(9);
      expect(rule.sql).toMatch(/\btenant_id\s*=\s*\$1\b/);
      expect(rule.sql).toMatch(/LIMIT 201\s*$/);
      expect(rule.sql).not.toMatch(/\bDELETE\b|\bUPDATE\b|\bINSERT\b/i);
      expect(rule.href.startsWith("/app/")).toBe(true);
      expect(rule.permission).toMatch(/^[a-z]+\.[a-z]+$/);
      expect(["CRITICAL","WARNING"]).toContain(rule.severity);
    }
  });

  it("must not erase unresolved results beyond a truncated source scan",()=>{
    expect(OPERATIONAL_SCAN_LIMIT).toBe(200);
    expect(isCompleteOperationalScan(0)).toBe(true);
    expect(isCompleteOperationalScan(200)).toBe(true);
    expect(isCompleteOperationalScan(201)).toBe(false);
    expect(isCompleteOperationalScan(10000)).toBe(false);
  });

  it.each([
    ["SALES_UNFULFILLED","CONFIRMED","SHIPPED"],
    ["PROCUREMENT_OVERDUE","PARTIALLY_RECEIVED","expected_at"],
    ["SERVICE_UNCLOSED","IN_SERVICE","dance_lesson"],
    ["DANCE_UNCLOSED","OPEN_FOR_BOOKING","ends_at"],
    ["MARKETPLACE_UNMAPPED","NEEDS_MAPPING","FAILED"],
    ["MARKETPLACE_STOCK_BLOCKED","BLOCKED","publish_enabled"],
    ["AUTOMOTIVE_OVERDUE","promised_at","DELIVERED"],
    ["PROJECT_DELIVERABLE_OVERDUE","due_at","APPROVED"],
    ["WMS_TASK_FAILED","FAILED","CLAIMED"],
    ["CRM_ACTION_OVERDUE","next_action_at","NORMAL"],
    ["FINANCE_OVERDUE","settled_minor","due_at"],
    ["SUPPORT_ESCALATED","URGENT","WAITING_SUPPORT"]
  ])("%s distinguishes actionable and completed/false-positive cases",(
    code,condition,exclusion
  )=>{
    const rule=VERTICAL_OPERATIONAL_RULE_BY_CODE.get(code)!;
    expect(rule.sql).toContain(condition);
    expect(rule.sql).toContain(exclusion);
  });
});
