import {HttpException,HttpStatus} from "@nestjs/common";
import {AuthRateLimitService} from "./auth-rate-limit.service";

describe("Auth login rate limits",()=>{
  const counters=new Map<string,number>();
  const redis={
    incrementWindow:jest.fn(async(key:string)=>{
      const next=(counters.get(key)??0)+1;
      counters.set(key,next);return next;
    }),
    delete:jest.fn(async(key:string)=>{counters.delete(key);})
  };
  const auth=new AuthRateLimitService(redis as any);
  beforeEach(()=>{
    counters.clear();
    jest.clearAllMocks();
  });
  it("blocks brute-force attempts against one account",async()=>{
    for(let i=0;i<10;i++)
      await auth.assertLoginAllowed("198.51.100.1","alice@example.test");
    await expect(auth.assertLoginAllowed(
      "198.51.100.1","alice@example.test"
    )).rejects.toMatchObject({status:HttpStatus.TOO_MANY_REQUESTS});
  });
  it("bounds aggregate Argon2 load even if attacker rotates 100 emails",async()=>{
    for(let i=0;i<100;i++)
      await auth.assertLoginAllowed("198.51.100.2",`user${i}@example.test`);
    await expect(auth.assertLoginAllowed(
      "198.51.100.2","another-user@example.test"
    )).rejects.toBeInstanceOf(HttpException);
  });
  it("a successful login resets only the IP/account key, not aggregate IP",async()=>{
    await auth.assertLoginAllowed("203.0.113.5","alice@example.test");
    await auth.resetLogin("203.0.113.5","alice@example.test");
    const keys=[...counters.keys()];
    expect(keys.some(k=>k.startsWith("auth-rate:login-ip:"))).toBe(true);
    expect(keys.some(k=>k.startsWith("auth-rate:login:"))).toBe(false);
  });
});
