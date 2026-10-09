import { UnauthorizedException, NotFoundException } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { TenantsService } from "../tenants/tenants.service";

jest.mock("argon2", () => ({
  argon2id: 2,
  hash: jest.fn(async () => "argon-hash"),
  verify: jest.fn(async () => true)
}));

const userId = "11111111-1111-4111-8111-111111111111";
const tenantId = "22222222-2222-4222-8222-222222222222";
const membershipId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";

describe("auth RLS and tenant lifecycle safeguards", () => {
  it("sets a tenant-local transaction context before membership/audit bootstrap", async () => {
    const queries: string[] = [];
    const client = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("INSERT INTO app_user")) return { rows: [{ id: userId, email: "a@example.com" }] };
        if (sql.includes("INSERT INTO tenant(")) return { rows: [{ id: tenantId, name: "Demo" }] };
        if (sql.includes("INSERT INTO tenant_membership")) return { rows: [{ id: membershipId }] };
        if (sql.includes("INSERT INTO user_session")) return { rows: [{ id: sessionId }] };
        return { rows: [], rowCount: 1 };
      })
    };
    const db = { withTransaction: jest.fn(async (fn: any) => fn(client)) };
    const service = new AuthService(db as any);
    await service.register({ email: "a@example.com", password: "correct horse battery", companyName: "Demo" });
    const setCtx = queries.findIndex((sql) => sql.includes("set_config('app.tenant_id'"));
    const insertMembership = queries.findIndex((sql) => sql.includes("INSERT INTO tenant_membership"));
    const insertAudit = queries.findIndex((sql) => sql.includes("INSERT INTO audit_event"));
    expect(setCtx).toBeGreaterThanOrEqual(0);
    expect(insertMembership).toBeGreaterThan(setCtx);
    expect(insertAudit).toBeGreaterThan(setCtx);
  });

  it("uses scoped identity SQL and sets tenant context for the login audit", async () => {
    const clientQueries: string[] = [];
    const database = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes("corebiz_auth_login_identity")) return { rows: [{
          id: userId, email: "a@example.com", password_hash: "argon-hash",
          membership_id: membershipId, tenant_id: tenantId, tenant_name: "Demo", is_owner: true
        }] };
        throw new Error("unexpected unscoped auth SQL");
      }),
      withTransaction: jest.fn(async (fn: any) => fn({
        query: async (sql: string) => {
          clientQueries.push(sql);
          return sql.includes("INSERT INTO user_session")
            ? { rows: [{ id: sessionId }] }
            : { rows: [], rowCount: 1 };
        }
      }))
    };
    const result = await new AuthService(database as any)
      .login({ email: "a@example.com", password: "correct horse battery" });
    expect(result.auth.tenantId).toBe(tenantId);
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("corebiz_auth_login_identity"), ["a@example.com"]);
    expect(clientQueries.findIndex((sql) => sql.includes("set_config('app.tenant_id'")))
      .toBeLessThan(clientQueries.findIndex((sql) => sql.includes("INSERT INTO audit_event")));
  });

  it("rejects a tenant switch when the protected DB function refuses it", async () => {
    const database = { query: jest.fn(async () => ({ rows: [{ switched: false }] })) };
    await expect(new AuthService(database as any)
      .switchTenant(sessionId, userId, membershipId))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("corebiz_auth_switch_tenant"),
      [sessionId, userId, membershipId]);
  });

  it("does not accept an unknown invitation token or rely on the caller's email", async () => {
    const database = { query: jest.fn(async () => ({ rows: [] })) };
    await expect(new TenantsService(database as any)
      .acceptInvitation(userId, "spoof@example.com", "unrecognized-token"))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("corebiz_auth_accept_invitation"),
      [userId, expect.stringMatching(/^[0-9a-f]{64}$/)]);
  });
});
