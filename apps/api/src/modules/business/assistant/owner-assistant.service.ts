import { Injectable } from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DashboardService } from "../dashboard/dashboard.service";
import { FinanceService } from "../finance/finance.service";
import { ProfitabilityService } from "../growth/profitability.service";

type Insight = {
  severity: "INFO" | "WARNING" | "CRITICAL";
  code: string;
  title: string;
  detail: string;
  href: string;
};

@Injectable()
export class OwnerAssistantService {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly finance: FinanceService,
    private readonly profitability: ProfitabilityService
  ) {}

  async brief(
    context: TenantContext
  ): Promise<Record<string, unknown>> {
    const now = new Date();
    const from = new Date(now.getTime() - 30 * 86400000);

    const [
      owner,
      operational,
      forecast,
      profitability
    ] = await Promise.all([
      this.dashboard.owner(context),
      this.dashboard.operational(context),
      this.finance.cashForecast(context, { days: 30 }),
      this.profitability.dashboard(context, {
        model: "LAST_PAID_TOUCH",
        from: from.toISOString(),
        to: now.toISOString()
      })
    ]);

    const insights: Insight[] = [];
    const cash = forecast as any;
    const profit = profitability as any;
    const ops = operational as any;

    if (cash.firstCashGapDate) {
      insights.push({
        severity: "CRITICAL",
        code: "CASH_GAP",
        title: "Ожидается кассовый разрыв",
        detail:
          "Первая отрицательная дата: " +
          new Date(cash.firstCashGapDate + "T00:00:00Z")
            .toLocaleDateString("ru-RU") +
          ". Минимальный остаток: " +
          this.money(cash.minimumBalanceMinor),
        href: "/app/finance/forecast"
      });
    }

    if (BigInt(cash.overdueReceivableMinor ?? "0") > 0n) {
      insights.push({
        severity: "CRITICAL",
        code: "OVERDUE_RECEIVABLE",
        title: "Есть просроченная дебиторка",
        detail:
          "К получению просрочено " +
          this.money(cash.overdueReceivableMinor) +
          ". Это прямой рычаг для снижения кассового риска.",
        href: "/app/finance"
      });
    }

    if (BigInt(cash.undatedPayableMinor ?? "0") > 0n) {
      insights.push({
        severity: "WARNING",
        code: "UNDATED_PAYABLE",
        title: "У части платежей нет даты",
        detail:
          "Без due date: " +
          this.money(cash.undatedPayableMinor) +
          ". Они не попадают в дневной прогноз.",
        href: "/app/finance/forecast"
      });
    }

    const contribution = BigInt(
      profit?.totals?.contributionProfitMinor ?? "0"
    );
    const marketingSpend = BigInt(
      profit?.totals?.spendMinor ?? "0"
    );

    if (marketingSpend > 0n && contribution < 0n) {
      insights.push({
        severity: "CRITICAL",
        code: "MARKETING_NEGATIVE_CONTRIBUTION",
        title: "Реклама съедает валовую прибыль",
        detail:
          "Contribution profit за 30 дней: " +
          this.money(contribution.toString()) +
          " при рекламных расходах " +
          this.money(marketingSpend.toString()) +
          ".",
        href: "/app/analytics/profitability"
      });
    }

    const unmapped = Number(
      profit?.dataQuality?.unmappedConversions ?? 0
    );
    if (unmapped > 0) {
      insights.push({
        severity: "WARNING",
        code: "ATTRIBUTION_GAPS",
        title: "Не все продажи сопоставлены с рекламой",
        detail:
          "Не сопоставлено конверсий: " +
          unmapped +
          ". Прибыльность каналов может быть неполной.",
        href: "/app/analytics/profitability"
      });
    }

    for (const issue of (ops.issues ?? []).slice(0, 20)) {
      const labels: Record<string,string> = {
        BANK_UNMATCHED: "Есть несопоставленные банковские операции",
        VAT_UNREGISTERED: "Есть документы НДС без регистрации",
        CLOSE_BLOCKED: "Закрытие месяца заблокировано",
        PAYROLL_DRAFT: "Расчёт зарплаты остаётся в черновике"
      };

      insights.push({
        severity:
          issue.code === "CLOSE_BLOCKED" ||
          issue.code === "VAT_UNREGISTERED"
            ? "CRITICAL"
            : "WARNING",
        code: issue.code,
        title: labels[issue.code] ?? issue.code,
        detail:
          "Проблема открыта с " +
          new Date(issue.firstSeenAt).toLocaleString("ru-RU"),
        href: issue.href
      });
    }

    const severityRank = {
      CRITICAL: 0,
      WARNING: 1,
      INFO: 2
    } as const;

    insights.sort(
      (a,b) =>
        severityRank[a.severity] - severityRank[b.severity]
    );

    if (!insights.length) {
      insights.push({
        severity: "INFO",
        code: "NO_CRITICAL_EXCEPTIONS",
        title: "Критичных исключений не найдено",
        detail:
          "По доступным данным деньги, операционные исключения и рекламная прибыльность не требуют срочного вмешательства.",
        href: "/app/operations"
      });
    }

    return {
      generatedAt: now.toISOString(),
      mode: "READ_ONLY_DETERMINISTIC",
      executionAllowed: false,
      dataSources: [
        "OWNER_DASHBOARD",
        "OPERATIONAL_ISSUES",
        "CASH_FORECAST",
        "MARKETING_PROFITABILITY"
      ],
      headline: insights[0],
      insights: insights.slice(0, 20),
      snapshot: {
        owner: owner.kpis,
        cashForecast: {
          openingBalanceMinor: cash.openingBalanceMinor,
          endingBalanceMinor: cash.endingBalanceMinor,
          firstCashGapDate: cash.firstCashGapDate
        },
        marketing: {
          spendMinor: profit?.totals?.spendMinor ?? "0",
          contributionProfitMinor:
            profit?.totals?.contributionProfitMinor ?? "0",
          romiPercent: profit?.totals?.romiPercent ?? null
        },
        operationalIssueCount: (ops.issues ?? []).length
      }
    };
  }

  private money(value: string): string {
    return new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency: "RUB",
      maximumFractionDigits: 0
    }).format(Number(value) / 100);
  }
}
