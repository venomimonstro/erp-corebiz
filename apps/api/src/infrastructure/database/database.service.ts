import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import type { TenantContext } from "@corebiz/contracts";
import { getEnv } from "../config/env";

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  // Per-process pool. Total connections = application replicas × poolMax.
  // PgBouncer transaction pooling is recommended for larger deployments.
  private readonly pool = new Pool({
    connectionString: getEnv().databaseUrl,
    max: DatabaseService.integerEnv("COREBIZ_DB_POOL_MAX",10,2,40),
    connectionTimeoutMillis: DatabaseService.integerEnv(
      "COREBIZ_DB_CONNECT_TIMEOUT_MS",3000,250,30000
    ),
    idleTimeoutMillis: DatabaseService.integerEnv(
      "COREBIZ_DB_IDLE_TIMEOUT_MS",15000,1000,120000
    ),
    statement_timeout: DatabaseService.integerEnv(
      "COREBIZ_DB_STATEMENT_TIMEOUT_MS",30000,5000,120000
    ),
    application_name:"corebiz-api"
  });

  private static integerEnv(
    name:string,fallback:number,min:number,max:number
  ):number{
    const raw=process.env[name];
    if(raw===undefined||raw==="")return fallback;
    const value=Number(raw);
    if(!Number.isSafeInteger(value)||value<min||value>max)
      throw new Error("INVALID_"+name);
    return value;
  }

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
