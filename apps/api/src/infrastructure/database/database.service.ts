import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import type { TenantContext } from "@corebiz/contracts";
import { getEnv } from "../config/env";

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool = new Pool({
    connectionString: getEnv().databaseUrl
  });

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, [...values]);
  }

  async withTransaction<T>(
    callback: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async withTenantTransaction<T>(
    context: TenantContext,
    callback: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    return this.withTransaction(async (client) => {
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true)",
        [context.tenantId]
      );
      return callback(client);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
