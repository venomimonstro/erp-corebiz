import {DatabaseService} from "./database.service";

// The pool must NOT connect to a real database in these unit tests.
jest.mock("../config/env",()=>({
  getEnv:()=>({databaseUrl:"postgres://unit:unit@127.0.0.1:5432/unit"})
}));

describe("PostgreSQL pool reliability",()=>{
  let service:DatabaseService;
  let pool:any;
  beforeEach(()=>{
    service=new DatabaseService();
    pool=(service as any).pool;
  });
  afterEach(async()=>{
    jest.restoreAllMocks();
    await service.onModuleDestroy();
  });

  it("does not terminate the API on idle-client error events",()=>{
    const log=jest.spyOn(console,"error").mockImplementation(()=>{});
    expect(()=>pool.emit("error",new Error("socket disconnected")))
      .not.toThrow();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("pool recovering"));
  });

  it("commits and returns a reusable transaction client on success",async()=>{
    const client={
      query:jest.fn().mockResolvedValue({rows:[],rowCount:0}),
      release:jest.fn()
    };
    jest.spyOn(pool,"connect").mockResolvedValue(client as any);
    await expect(service.withTransaction(async()=>42)).resolves.toBe(42);
    expect(client.query.mock.calls.map(([sql])=>sql)).toEqual([
      "BEGIN","SET LOCAL lock_timeout = '5s'",
      "SET LOCAL idle_in_transaction_session_timeout = '60s'","COMMIT"
    ]);
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it("keeps the original SQL exception if ROLLBACK also fails",async()=>{
    const initial=new Error("writer lost connection");
    const client={
      query:jest.fn(async(sql:string)=>{
        if(sql==="ROLLBACK")throw new Error("rollback connection terminated");
        return {rows:[],rowCount:0};
      }),
      release:jest.fn()
    };
    jest.spyOn(pool,"connect").mockResolvedValue(client as any);
    await expect(service.withTransaction(async()=>{throw initial;}))
      .rejects.toBe(initial);
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it("evicts a connection on fatal PostgreSQL transport errors",async()=>{
    const fatal=Object.assign(new Error("server shutdown"),{code:"57P01"});
    const client={
      query:jest.fn().mockResolvedValue({rows:[],rowCount:0}),
      release:jest.fn()
    };
    jest.spyOn(pool,"connect").mockResolvedValue(client as any);
    await expect(service.withTransaction(async()=>{throw fatal;}))
      .rejects.toBe(fatal);
    expect(client.release).toHaveBeenCalledWith(true);
  });
});
