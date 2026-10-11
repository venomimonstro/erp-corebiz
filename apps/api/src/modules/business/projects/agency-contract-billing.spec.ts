import { calculateAgencyContractCharge, type AgencyBillingContract } from "./agency-contract-billing";

const base:AgencyBillingContract={
  id:"contract-1",contract_number:"A-1",billing_cycle:"MONTHLY",
  service_fee_minor:"8000000",client_media_budget_minor:"20000000",
  starts_on:"2026-01-01",ends_on:null,status:"ACTIVE",signed_on:"2025-12-20"
};

describe("contract-driven agency billing",()=>{
  it("charges each active monthly retainer and excludes client media budget",()=>{
    const result=calculateAgencyContractCharge("2026-06",[base]);
    expect(result.serviceRevenueMinor).toBe("8000000");
    expect(result.mediaBudgetMinor).toBe("20000000");
    expect(result.needsReview).toBe(false);
  });
  it("charges quarterly contracts only on their contractual billing months",()=>{
    const item={...base,billing_cycle:"QUARTERLY" as const};
    expect(calculateAgencyContractCharge("2026-04",[item]).serviceRevenueMinor).toBe("8000000");
    expect(calculateAgencyContractCharge("2026-05",[item]).serviceRevenueMinor).toBe("0");
  });
  it("never charges unapproved contracts and requires human review",()=>{
    const result=calculateAgencyContractCharge("2026-06",[{...base,status:"DRAFT"}]);
    expect(result.serviceRevenueMinor).toBe("0");
    expect(result.needsReview).toBe(true);
  });
  it("requires explicit review for partial service months",()=>{
    const result=calculateAgencyContractCharge("2026-06",[
      {...base,starts_on:"2026-06-15"}
    ]);
    expect(result.needsReview).toBe(true);
    expect(result.serviceRevenueMinor).toBe("8000000");
  });
  it("does not issue backdated revenue against a contract signed later",()=>{
    const result=calculateAgencyContractCharge("2026-06",[
      {...base,signed_on:"2026-07-02"}
    ]);
    expect(result.needsReview).toBe(true);
    expect(result.serviceRevenueMinor).toBe("0");
  });
  it("separates two concurrent signed contracts and still excludes both ad budgets",()=>{
    const result=calculateAgencyContractCharge("2026-06",[
      base,{...base,id:"seo-2",contract_number:"SEO-2",
        service_fee_minor:"4000000",client_media_budget_minor:"5000000"}
    ]);
    expect(result.serviceRevenueMinor).toBe("12000000");
    expect(result.mediaBudgetMinor).toBe("25000000");
    expect(result.chargedContractIds).toEqual(["contract-1","seo-2"]);
  });
  it("prevents repeat monthly charges on an inactive contract",()=>{
    const result=calculateAgencyContractCharge("2026-06",[
      {...base,status:"TERMINATED"}
    ]);
    expect(result.serviceRevenueMinor).toBe("0");
    expect(result.needsReview).toBe(true);
  });
  it("does not automatically invent revenue without a contract",()=>{
    const result=calculateAgencyContractCharge("2026-06",[]);
    expect(result.serviceRevenueMinor).toBe("0");
    expect(result.needsReview).toBe(true);
  });
  it("never bills a contract before its signature even if active now",()=>{
    const result=calculateAgencyContractCharge("2026-06",[
      {...base,signed_on:"2026-07-12"}
    ]);
    expect(result.serviceRevenueMinor).toBe("0");
    expect(result.needsReview).toBe(true);
    expect(result.warnings.join(" ")).toContain("подписан позднее");
  });

  it("blocks expired and paused contracts rather than silently charging",()=>{
    for(const status of ["PAUSED","TERMINATED","EXPIRED"]){
      const result=calculateAgencyContractCharge("2026-06",[{...base,status}]);
      expect(result.serviceRevenueMinor).toBe("0");
      expect(result.needsReview).toBe(true);
    }
  });

  it("charges a one-time web build only once",()=>{
    const c={...base,billing_cycle:"ONE_TIME" as const};
    expect(calculateAgencyContractCharge("2026-01",[c]).serviceRevenueMinor).toBe("8000000");
    expect(calculateAgencyContractCharge("2026-02",[c]).serviceRevenueMinor).toBe("0");
  });

  it("needs finance review for signed but partial termination month",()=>{
    const c={...base,ends_on:"2026-06-12"};
    const result=calculateAgencyContractCharge("2026-06",[c]);
    expect(result.needsReview).toBe(true);
    expect(result.serviceRevenueMinor).toBe("8000000");
  });

});
