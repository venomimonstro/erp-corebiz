import { BadRequestException } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { hashToken } from "./auth.utils";

describe("password reset security", () => {
  it("does not reveal unknown accounts", async () => {
    const mail = {sendReset: jest.fn()};
    const db = {
      query: jest.fn(async () => ({rows:[]})),
      withTransaction: jest.fn()
    };
    const service = new AuthService(db as any,mail as any);
    await expect(service.requestPasswordReset("missing@example.com"))
      .resolves.toBeUndefined();
    expect(mail.sendReset).not.toHaveBeenCalled();
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  it("stores only a hashed token and accepts a single active link", async () => {
    const writes: Array<{sql:string;values:unknown[]}> = [];
    const mail = {sendReset: jest.fn(async (_email: string, _token: string) => undefined)};
    const db = {
      query: jest.fn(async () => ({rows:[{id:"user-uuid"}]})),
      withTransaction: jest.fn(async (work: any) =>
        work({query: jest.fn(async (sql:string,values:unknown[]=[])=>{
          writes.push({sql,values}); return {rows:[],rowCount:1};
        })}))
    };
    const service = new AuthService(db as any,mail as any);
    await service.requestPasswordReset("person@example.com");
    const token = mail.sendReset.mock.calls[0]?.[1];
    const insert = writes.find(w=>w.sql.includes("INSERT INTO password_reset_token"));
    expect(typeof token).toBe("string");
    expect(insert).toBeDefined();
    expect(insert?.values[1]).toBe(hashToken(token as string));
    expect(insert?.values[1]).not.toBe(token);
    expect(writes.some(w=>w.sql.includes("FOR UPDATE"))).toBe(true);
  });

  it("rejects well-formed but unknown tokens before opening a write transaction", async () => {
    const db = {
      query:jest.fn(async () => ({rows:[]})),
      withTransaction:jest.fn()
    };
    const service = new AuthService(db as any,{} as any);
    await expect(service.completePasswordReset(
      "A".repeat(43), "a valid replacement password"
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM password_reset_token"),
      [expect.stringMatching(/^[0-9a-f]{64}$/)]
    );
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  it("rejects missing and invalid tokens without updating credentials", async () => {
    const db = {withTransaction: jest.fn()};
    const service = new AuthService(db as any, {} as any);
    await expect(service.completePasswordReset("short", "new long password"))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(db.withTransaction).not.toHaveBeenCalled();
  });
});
