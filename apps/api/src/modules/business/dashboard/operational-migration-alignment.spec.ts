import {existsSync,readFileSync} from "node:fs";
import {resolve} from "node:path";
import {VERTICAL_OPERATIONAL_RULES} from "./vertical-operational-rules";

describe("operational events stay compatible with PostgreSQL constraints",()=>{
  const root=process.cwd();
  const file=([
    resolve(root,"../../infrastructure/postgres/223_operational_issue_code_alignment.sql"),
    resolve(root,"infrastructure/postgres/223_operational_issue_code_alignment.sql")
  ]).find(existsSync);

  it("publishes a migration defining every live vertical incident code",()=>{
    expect(file).toBeDefined();
    const migration=readFileSync(file!,"utf8");
    const allowable=new Set(
      Array.from(migration.matchAll(/'([A-Z][A-Z0-9_]+)'/g),match=>match[1])
    );
    const rules=VERTICAL_OPERATIONAL_RULES.map(rule=>rule.code);
    expect(new Set(rules).size).toBe(rules.length);
    for(const code of rules){
      expect(allowable.has(code)).toBe(true);
    }
    for(const code of ["BANK_UNMATCHED","VAT_UNREGISTERED",
      "CLOSE_BLOCKED","PAYROLL_DRAFT"]){
      expect(allowable.has(code)).toBe(true);
    }
  });
});
