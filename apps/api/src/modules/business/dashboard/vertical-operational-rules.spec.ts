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
    ["MARKETPLACE_EXCESS_PUBLICATION","published_units","safety_stock_milli"],
    ["MARKETPLACE_ORDER_FEED_STALE","last_synced_at","publish_enabled"],
    ["AUTOMOTIVE_OVERDUE","promised_at","DELIVERED"],
    ["PROJECT_DELIVERABLE_OVERDUE","due_at","APPROVED"],
    ["WMS_TASK_FAILED","FAILED","CLAIMED"],
    ["CRM_ACTION_OVERDUE","next_action_at","NORMAL"],
    ["FINANCE_OVERDUE","settled_minor","due_at"],
    ["SUPPORT_ESCALATED","URGENT","WAITING_SUPPORT"],
    ["OMS_BACKORDER_OVERDUE","PARTIALLY_ALLOCATED","expected_at"],
    ["DANCE_STRANDED_VISIT","RESERVED","CANCELLED_BY_STUDIO"],
    ["PAYROLL_REVIEW_DISPUTED","DISPUTED","review_status"],
    ["PROJECT_CLIENT_APPROVAL_OVERDUE","PENDING","due_at"]
  ])("%s distinguishes actionable and completed/false-positive cases",(
    code,condition,exclusion
  )=>{
    const rule=VERTICAL_OPERATIONAL_RULE_BY_CODE.get(code)!;
    expect(rule.sql).toContain(condition);
    expect(rule.sql).toContain(exclusion);
  });
  it("marketplace risk checks partition exposures by tenant, SKU and warehouse",()=>{
    const rule=VERTICAL_OPERATIONAL_RULE_BY_CODE.get("MARKETPLACE_EXCESS_PUBLICATION")!;
    expect(rule.severity).toBe("CRITICAL");
    expect(rule.sql).toContain("sum(coalesce(t.published_units,0))");
    expect(rule.sql).toContain("GROUP BY l.tenant_id,l.warehouse_id,l.sku_id");
    expect(rule.sql).toContain("p.enabled=false");
    expect(rule.sql).toContain("coalesce(b.reserved_milli,0)");
    expect(rule.sql).toContain("coalesce(p.safety_stock_milli,0)");
    expect(rule.sql).toContain("l.publish_enabled");
  });
  it("only escalates stale order feeds of actively publishing listings",()=>{
    const rule=VERTICAL_OPERATIONAL_RULE_BY_CODE.get("MARKETPLACE_ORDER_FEED_STALE")!;
    expect(rule.sql).toContain("l.enabled AND l.publish_enabled");
    expect(rule.sql).toContain("c.status='ACTIVE'");
    expect(rule.sql).toContain("c.last_synced_at IS NULL");
    expect(rule.sql).toContain("interval '10 minutes'");
  });

});
