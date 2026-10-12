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

  constructor() {
    // node-postgres emits "error" for disconnected IDLE pool clients.
    // Without a listener EventEmitter would crash the entire API process.
    // The pool evicts that connection; never log credentials/connection strings.
    this.pool.on("error", () => {
      console.error("[corebiz-postgres] idle client disconnected; pool recovering");
    });
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

    let discardConnection = false;
    try {
      await client.query("BEGIN");
      // Bound waiting and abandoned transactions under concurrent tenant load.
      // SET LOCAL is scoped to this transaction, never leaks to the next
      // tenant when PgBouncer reuses a pooled connection.
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      // A broken connection must not return to the idle pool. ROLLBACK may
      // also fail, but must never conceal the original database exception.
      try {
        await client.query("ROLLBACK");
      } catch {
        discardConnection = true;
      }
      if(error && typeof error === "object" && "code" in error) {
        const code = String(error.code);
        if(code.startsWith("08") || code === "57P01" ||
           code === "ECONNRESET" || code === "EPIPE")
          discardConnection = true;
      }
      throw error;
    } finally {
      client.release(discardConnection);
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
