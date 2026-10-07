import { Injectable } from "@nestjs/common";
import { AsyncLocalStorage } from "node:async_hooks";
import type { TenantContext } from "@corebiz/contracts";

@Injectable()
export class TenantContextService {
  private readonly storage = new AsyncLocalStorage<TenantContext>();

  run<T>(context: TenantContext, callback: () => T): T {
    return this.storage.run(context, callback);
  }

  get(): TenantContext {
    const context = this.storage.getStore();

    if (!context) {
      throw new Error("TENANT_CONTEXT_MISSING");
    }

    return context;
  }

  getOptional(): TenantContext | undefined {
    return this.storage.getStore();
  }
}
