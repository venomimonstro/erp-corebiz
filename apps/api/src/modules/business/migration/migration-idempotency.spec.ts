import { ConflictException } from "@nestjs/common";
import { MigrationService } from "./migration.service";

const context = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  membershipId: "33333333-3333-4333-8333-333333333333"
};

describe("CSV / Excel import idempotency", () => {
  it("rejects a reused key for a different file before any import writes", async () => {
    const calls: string[] = [];
    const client = {
      query: jest.fn(async (sql: string) => {
        calls.push(sql);
        if (sql.includes("FROM migration_batch WHERE tenant_id")) {
          return { rows: [{
            id: "44444444-4444-4444-8444-444444444444",
            status: "VALIDATED", row_count: 1, valid_count: 1,
            error_count: 0, mapping: {},
            entity_type: "PRODUCTS",
            checksum: "this-is-not-the-request-file-checksum"
          }] };
        }
        throw new Error("No subsequent SQL should execute for mismatched idempotency");
      })
    };
    const db = {
      withTenantTransaction: jest.fn(async (_context: unknown, fn: any) => fn(client))
    };
    const service = new MigrationService(db as any);
    const file = Buffer.from("name,price\nProduct A,100\n", "utf8").toString("base64");
    await expect(service.ingest(context, {
      entityType: "PRODUCTS",
      filename: "catalog.csv",
      contentBase64: file,
      idempotencyKey: "batch-one"
    })).rejects.toBeInstanceOf(ConflictException);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("checksum");
  });
});
