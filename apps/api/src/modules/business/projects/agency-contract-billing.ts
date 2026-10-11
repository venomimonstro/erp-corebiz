export type ContractCycle = "MONTHLY"|"QUARTERLY"|"ONE_TIME";
export type AgencyBillingContract = {
  id:string;contract_number:string;billing_cycle:ContractCycle;
  service_fee_minor:string;client_media_budget_minor:string;
  starts_on:string;ends_on:string|null;status:string;signed_on:string|null;
};
export type AgencyContractCharge={
  serviceRevenueMinor:string;
  mediaBudgetMinor:string;
  chargedContractIds:string[];
  needsReview:boolean;
  warnings:string[];
};

export function calculateAgencyContractCharge(
  period:string,contracts:AgencyBillingContract[]
):AgencyContractCharge{
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))
    throw new Error("Invalid contract billing period");
  const [year,month]=period.split("-").map(Number);
  const start=period+"-01";
  const last=new Date(Date.UTC(year,month,0)).toISOString().slice(0,10);
  const monthIndex=year*12+month-1;
  let service=0n;
  let media=0n;
  let needsReview=false;
  const chargedContractIds:string[]=[];
  const warnings:string[]=[];
  const applicable=contracts.filter(c=>c.starts_on<=last&&(!c.ends_on||c.ends_on>=start));
  if(!applicable.length){
    needsReview=true;
    warnings.push("Нет действующего подписанного договора на этот период; нужна проверка финансового менеджера");
  }
  for(const c of applicable){
    if(c.status!=="ACTIVE"||!c.signed_on){
      needsReview=true;
      warnings.push("Договор "+c.contract_number+" не активирован или не подписан: автоматическое начисление запрещено");
      continue;
    }
    const contractMonth=Number(c.starts_on.slice(0,4))*12+
      Number(c.starts_on.slice(5,7))-1;
    const index=monthIndex-contractMonth;
    if(index<0)continue;
    let charge=false;
    if(c.billing_cycle==="MONTHLY")charge=true;
    else if(c.billing_cycle==="QUARTERLY")charge=index%3===0;
    else if(c.billing_cycle==="ONE_TIME")charge=index===0;
    else throw new Error("Unknown contract billing cycle");
    if(charge){
      const fee=BigInt(c.service_fee_minor);
      if(fee<0n)throw new Error("Negative contract fee");
      service+=fee;
      chargedContractIds.push(c.id);
      if((c.billing_cycle==="MONTHLY"||c.billing_cycle==="QUARTERLY")&&
         (c.starts_on>start||(c.ends_on!==null&&c.ends_on<last))){
        needsReview=true;
        warnings.push("Неполный период договора "+c.contract_number+
          ": проверьте перерасчёт вручную перед выставлением счёта");
      }
    }
    // The media allocation is a client-managed budget, never agency revenue.
    if(c.billing_cycle!=="ONE_TIME")media+=BigInt(c.client_media_budget_minor);
  }
  return {serviceRevenueMinor:service.toString(),mediaBudgetMinor:media.toString(),
    chargedContractIds,needsReview,warnings};
}
