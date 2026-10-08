import { Injectable } from "@nestjs/common";

type RouteMetric = {
  count: number;
  errors: number;
  durationsMs: number[];
};

@Injectable()
export class ApiMetricsService {
  private readonly routes = new Map<string, RouteMetric>();

  record(route: string, durationMs: number, statusCode: number): void {
    const metric = this.routes.get(route) ?? {
      count: 0,
      errors: 0,
      durationsMs: []
    };

    metric.count += 1;
    if (statusCode >= 500) metric.errors += 1;
    metric.durationsMs.push(durationMs);

    if (metric.durationsMs.length > 500) {
      metric.durationsMs.splice(0, metric.durationsMs.length - 500);
    }

    this.routes.set(route, metric);
  }

  snapshot(): Array<{
    route: string;
    count: number;
    errors: number;
    errorRate: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  }> {
    return Array.from(this.routes.entries())
      .map(([route, metric]) => {
        const sorted = [...metric.durationsMs].sort((a, b) => a - b);
        const percentile = (p: number): number => {
          if (!sorted.length) return 0;
          const index = Math.min(
            sorted.length - 1,
            Math.max(0, Math.ceil(sorted.length * p) - 1)
          );
          return Math.round(sorted[index] ?? 0);
        };

        return {
          route,
          count: metric.count,
          errors: metric.errors,
          errorRate:
            metric.count === 0
              ? 0
              : Math.round((metric.errors / metric.count) * 10000) / 100,
          p50Ms: percentile(0.5),
          p95Ms: percentile(0.95),
          p99Ms: percentile(0.99)
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 200);
  }
}
