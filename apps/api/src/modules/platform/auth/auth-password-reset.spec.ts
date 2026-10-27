import { BadRequestException } from "@nestjs/common";
import { AuthService } from "./auth.service";

describe("password reset security", () => {
  it("does not reveal unknown accounts or enqueue mail", async () => {
    const db = {
      query: jest.fn(async () => ({rows:[]})),
      withTransaction: jest.fn()
    };
    const service = new AuthService(db as any);

    await expect(service.requestPasswordReset("missing@example.com"))
      .resolves.toBeUndefined();

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0]?.[0]).toContain("FROM app_user");
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  it("queues recovery without creating a plaintext token in the API process", async () => {
    const db = {
      query: jest.fn(async (sql:string) => {
        if(sql.includes("FROM app_user")) {
          return {rows:[{id:"11111111-1111-4111-8111-111111111111"}]};
        }
        if(sql.includes("corebiz_enqueue_auth_mail")) {
          return {rows:[{corebiz_enqueue_auth_mail:true}]};
        }
        return {rows:[]};
      }),
      withTransaction: jest.fn()
    };
    const service = new AuthService(db as any);

    await expect(service.requestPasswordReset("person@example.com"))
      .resolves.toBeUndefined();

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("corebiz_enqueue_auth_mail"),
      ["11111111-1111-4111-8111-111111111111"]
    );
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  it("rejects well-formed but unknown tokens before opening a write transaction", async () => {
    const db = {
      query:jest.fn(async () => ({rows:[]})),
      withTransaction:jest.fn()
    };
    const service = new AuthService(db as any);
    await expect(service.completePasswordReset(
      "A".repeat(43), "a valid replacement password"
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM password_reset_token"),
      [expect.stringMatching(/^[0-9a-f]{64}$/)]
    );
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  it("rejects malformed tokens without updating credentials", async () => {
    const db = {
      query:jest.fn(),
      withTransaction: jest.fn()
    };
    const service = new AuthService(db as any);
    await expect(service.completePasswordReset("short", "new long password"))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(db.withTransaction).not.toHaveBeenCalled();
  });
});
