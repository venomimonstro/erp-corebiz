import {VERTICAL_OPERATIONAL_RULES} from "../dashboard/vertical-operational-rules";

/**
 * Returns only issue classes that a user may see.
 * null means owner access. Empty array means no operational visibility.
 */
export function visibleOperationalCodes(permissions:ReadonlySet<string>):string[]|null{
  if(permissions.has("*")||permissions.has("dashboard.owner.read"))return null;
  const codes:string[]=[];
  const requirements:ReadonlyArray<[string,string]>=[
    ["BANK_UNMATCHED","finance.read"],
    ["VAT_UNREGISTERED","accounting.compliance.read"],
    ["CLOSE_BLOCKED","accounting.read"],
    ["PAYROLL_DRAFT","accounting.read"]
  ];
  for(const [code,required] of requirements){
    if(permissions.has(required))codes.push(code);
  }
  for(const rule of VERTICAL_OPERATIONAL_RULES){
    if(permissions.has(rule.permission)&&!codes.includes(rule.code))codes.push(rule.code);
  }
  return codes;
}
