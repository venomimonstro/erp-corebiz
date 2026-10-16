import {AuthService} from "./auth.service";

const session={
  session_id:"11111111-1111-4111-8111-111111111111",
  user_id:"22222222-2222-4222-8222-222222222222",
  email:"user@example.test",
  membership_id:"33333333-3333-4333-8333-333333333333",
  tenant_id:"44444444-4444-4444-8444-444444444444",
  tenant_name:"Example Ltd",is_owner:true
};

describe("DB-backed session validation with throttled telemetry",()=>{
  it("validates each request but writes last_seen only once in a burst",async()=>{
    const queries:string[]=[];
    const db={
      query:jest.fn(async(sql:string)=>{
        queries.push(sql);
        if(sql.includes("corebiz_auth_resolve_session"))
          return {rows:[session],rowCount:1};
        return {rows:[],rowCount:1};
      })
    };
    const service=new AuthService(db as any, {} as any);
    const responses=await Promise.all(
      Array.from({length:50},()=>service.resolveSession("session-token"))
    );
    expect(responses).toHaveLength(50);
    expect(responses.every(r=>r?.tenantId===session.tenant_id)).toBe(true);
    expect(queries.filter(q=>q.includes("corebiz_auth_resolve_session")))
      .toHaveLength(50);
    expect(queries.filter(q=>q.includes("SET last_seen_at")))
      .toHaveLength(1);
  });

  it("does not allow cached last-seen timestamps to bypass revocation",async()=>{
    let active=true;
    const db={
      query:jest.fn(async(sql:string)=>{
        if(sql.includes("corebiz_auth_resolve_session"))
          return {rows:active?[session]:[],rowCount:active?1:0};
        return {rows:[],rowCount:1};
      })
    };
    const service=new AuthService(db as any, {} as any);
    expect(await service.resolveSession("session-token")).not.toBeNull();
    active=false;
    expect(await service.resolveSession("session-token")).toBeNull();
    expect(db.query.mock.calls.filter(([sql])=>sql.includes(
      "corebiz_auth_resolve_session"))).toHaveLength(2);
  });
});
