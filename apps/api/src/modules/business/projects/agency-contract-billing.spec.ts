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
  it("does not automatically invent revenue without a contract",()=>{
    const result=calculateAgencyContractCharge("2026-06",[]);
    expect(result.serviceRevenueMinor).toBe("0");
    expect(result.needsReview).toBe(true);
  });
});
