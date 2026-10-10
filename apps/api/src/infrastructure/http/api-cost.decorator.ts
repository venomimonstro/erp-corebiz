import { SetMetadata } from "@nestjs/common";

export type ApiCostClass =
  | "NORMAL"
  | "SEARCH"
  | "HEAVY"
  | "EXPENSIVE"
  | "WEBHOOK";

export const API_COST_CLASS = "corebiz.api_cost_class";

export const ApiCost = (costClass: ApiCostClass) =>
  SetMetadata(API_COST_CLASS, costClass);
