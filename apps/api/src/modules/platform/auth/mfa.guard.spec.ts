import { ForbiddenException } from "@nestjs/common";
import { MfaGuard } from "./mfa.guard";

function context(path:string,auth:Record<string,unknown>|undefined){
  return {
    getHandler:()=>({}),
    getClass:()=>({}),
    switchToHttp:()=>({
      getRequest:()=>({
        auth,originalUrl:path,method:"GET",headers:{}
      })
    })
  } as any;
}

describe("global MFA privilege guard",()=>{
  const reflector={getAllAndOverride:jest.fn(()=>false)};
  const guard=new MfaGuard(reflector as any);
  const base={
    sessionId:"s",userId:"u",tenantId:"t",membershipId:"m",
    email:"x@example.test",tenantName:"X",isOwner:true,
    mfaRequired:true,mfaEnabled:false,mfaVerified:false
  };

  it("blocks business APIs before privileged MFA setup",()=>{
    expect(()=>guard.canActivate(context("/api/v1/catalog/products",base)))
      .toThrow(ForbiddenException);
  });

  it("allows only the explicit MFA bootstrap surface",()=>{
    expect(guard.canActivate(context("/api/v1/auth/mfa/status",base))).toBe(true);
    expect(guard.canActivate(context("/api/v1/auth/mfa/begin",base))).toBe(true);
    expect(()=>guard.canActivate(context("/api/v1/support/tickets",base)))
      .toThrow(ForbiddenException);
  });

  it("allows normal workspace traffic only after MFA verification",()=>{
    expect(guard.canActivate(context("/api/v1/catalog/products",{
      ...base,mfaEnabled:true,mfaVerified:true
    }))).toBe(true);
  });
});
