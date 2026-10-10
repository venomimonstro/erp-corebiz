"use client";

import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../lib/api";
import { GlobalCommandPalette } from "./global-command-palette";
import { ActionQueueCenter } from "./action-queue-center";

type Entry = readonly [href: string, label: string, key: string];
type Section = { title: string; items: Entry[] };
type MenuProfile = "all" | "commerce" | "service" | "warehouse";
type Capability = { key: string; enabled: boolean };
type WorkspaceContext = {
  roles: string[];
  permissions: Array<{ code: string; scope: string }>;
  profileCode: string;
  workspace: string;
};

const permissionByKey: Record<string,string> = {
  deals: "crm.read",
  tasks: "tasks.read",
  orders: "sales.read",
  products: "catalog.read",
  purchases: "procurement.read",
  stock: "inventory.read",
  finance: "finance.read",
  "finance-forecast": "finance.read",
  "finance-budget": "finance.read",
  "service-home": "service.read",
  bookings: "service.read",
  resources: "service.read",
  channels: "channels.read",
  oms: "oms.read",
  returns: "returns.read",
  sites: "sites.read",
  analytics: "analytics.read",
  profitability: "analytics.read",
  marketing: "analytics.read",
  growth: "analytics.read",
  conversions: "analytics.read",
  "analytics-settings": "analytics.read",
  wms: "wms.read",
  "wms-inbound": "wms.read",
  "wms-mobile": "wms.read",
  "wms-owners": "wms.read",
  "wms-billing": "wms.read",
  "wms-portal": "wms.read",
  workflows: "workflow.read",
  "owner-assistant": "dashboard.owner.read",
  operations: "dashboard.owner.read",
  customization: "customization.manage",
  "release-readiness": "release.read",
  "go-live": "go_live.read",
  support: "support.read"
};

const capabilityByKey: Record<string,string> = {
  deals: "crm",
  tasks: "tasks",
  orders: "sales",
  products: "catalog",
  purchases: "procurement",
  stock: "inventory",
  finance: "finance",
  "finance-forecast": "finance",
  "finance-budget": "finance",
  "service-home": "service",
  bookings: "service",
  resources: "service",
  channels: "channels",
  oms: "oms",
  returns: "oms",
  sites: "sites",
  analytics: "growth",
  profitability: "growth",
  marketing: "growth",
  growth: "growth",
  conversions: "growth",
  "analytics-settings": "growth",
  wms: "wms",
  "wms-inbound": "wms",
  "wms-mobile": "wms",
  "wms-owners": "wms",
  "wms-billing": "wms",
  "wms-portal": "wms",
  workflows: "workflow",
  support: "support"
};

const profileSections: Record<MenuProfile, readonly string[]> = {
  all: [],
  commerce: ["Клиенты и задачи", "Продажи и товары", "Онлайн-торговля", "Аналитика", "Управление"],
  service: ["Клиенты и задачи", "Запись и услуги", "Продажи и товары", "Аналитика", "Управление"],
  warehouse: ["Клиенты и задачи", "Продажи и товары", "Склад и 3PL", "Управление"]
};

const sections: Section[] = [
  { title: "Клиенты и задачи", items: [
    ["/app/crm/deals", "Сделки", "deals"],
    ["/app/tasks", "Задачи", "tasks"]
  ] },
  { title: "Продажи и товары", items: [
    ["/app/sales/orders", "Заказы", "orders"],
    ["/app/catalog/products", "Товары и услуги", "products"],
    ["/app/purchases", "Закупки", "purchases"],
    ["/app/inventory/stock", "Остатки", "stock"],
    ["/app/finance", "Деньги", "finance"],
    ["/app/finance/forecast", "Платёжный календарь", "finance-forecast"],
    ["/app/finance/budget", "Бюджет план / факт", "finance-budget"]
  ] },
  { title: "Запись и услуги", items: [
    ["/app/service", "Сегодня", "service-home"],
    ["/app/service/bookings", "Записи клиентов", "bookings"],
    ["/app/service/resources", "Сотрудники и ресурсы", "resources"]
  ] },
  { title: "Онлайн-торговля", items: [
    ["/app/channels", "Каналы продаж", "channels"],
    ["/app/oms", "Управление заказами", "oms"],
    ["/app/returns", "Возвраты", "returns"],
    ["/app/sites", "Сайты и магазин", "sites"]
  ] },
  { title: "Аналитика", items: [
    ["/app/analytics", "Обзор", "analytics"],
    ["/app/analytics/profitability", "Прибыль", "profitability"],
    ["/app/analytics/marketing", "Реклама", "marketing"],
    ["/app/analytics/growth", "Трафик", "growth"],
    ["/app/analytics/conversions", "Конверсии", "conversions"],
    ["/app/analytics/settings", "Настройки аналитики", "analytics-settings"]
  ] },
  { title: "Склад и 3PL", items: [
    ["/app/wms", "Складские задания", "wms"],
    ["/app/wms/inbound", "Приёмка", "wms-inbound"],
    ["/app/wms/mobile", "Рабочее место ТСД", "wms-mobile"],
    ["/app/wms/owners", "Владельцы товара", "wms-owners"],
    ["/app/wms/billing", "3PL расчёты", "wms-billing"],
    ["/app/wms/portal", "Портал 3PL", "wms-portal"]
  ] },
  { title: "Управление", items: [
    ["/app/assistant", "Помощник владельца", "owner-assistant"],
    ["/app/operations", "Что требует внимания", "operations"],
    ["/app/settings", "Настройки", "settings"],
    ["/app/settings/customization", "Адаптация системы", "customization"],
    ["/app/workflows", "Автоматизации", "workflows"],
    ["/app/settings/billing", "Тариф и оплата", "billing"],
    ["/app/settings/release", "Готовность релиза", "release-readiness"],
    ["/app/settings/go-live", "Go-Live Center", "go-live"],
    ["/app/support", "Поддержка", "support"]
  ] }
];

export function AppSidebar({ active }: { active: string }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [profile, setProfile] = useState<MenuProfile>("all");
  const [capabilities, setCapabilities] = useState<Record<string,boolean> | null>(null);
  const [workspaceContext, setWorkspaceContext] = useState<WorkspaceContext | null>(null);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("corebiz.menu.profile");
      if (stored === "commerce" || stored === "service" || stored === "warehouse" || stored === "all") {
        setProfile(stored);
      }
    } catch { /* Private browsing: use a full navigation menu. */ }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadCapabilities() {
      try {
        const [rows, context] = await Promise.all([
          apiRequest<Capability[]>("/customization/capabilities"),
          apiRequest<WorkspaceContext>("/workspace/context")
        ]);
        if (!cancelled) {
          setCapabilities(
            Object.fromEntries(rows.map((item) => [item.key,item.enabled]))
          );
          setWorkspaceContext(context);
        }
      } catch {
        // Fail open for navigation only. Backend guards remain authoritative.
        if (!cancelled) {
          setCapabilities(null);
          setWorkspaceContext(null);
        }
      }
    }

    void loadCapabilities();
    const refresh = () => void loadCapabilities();
    window.addEventListener("corebiz-capabilities-changed", refresh);

    return () => {
      cancelled = true;
      window.removeEventListener("corebiz-capabilities-changed", refresh);
    };
  }, []);

  function updateProfile(value: MenuProfile) {
    setProfile(value);
    try { window.localStorage.setItem("corebiz.menu.profile", value); } catch { /* no persistence */ }
  }
  const capabilityFilteredSections = useMemo(
    () =>
      sections
        .map((section) => ({
          ...section,
          items: section.items.filter((entry) => {
            if (entry[2] === active) return true;

            const capability = capabilityByKey[entry[2]];
            if (
              capability &&
              capabilities !== null &&
              capabilities[capability] === false
            ) {
              return false;
            }

            const requiredPermission = permissionByKey[entry[2]];
            if (!requiredPermission || workspaceContext === null) {
              return true;
            }

            const permissions = workspaceContext.permissions;
            return permissions.some(
              (permission) =>
                permission.code === "*" ||
                permission.code === requiredPermission
            );
          })
        }))
        .filter((section) => section.items.length > 0),
    [active, capabilities, workspaceContext]
  );

  const visibleSections = capabilityFilteredSections.filter((section) =>
    profile === "all" || profileSections[profile].includes(section.title) ||
    section.items.some((entry) => entry[2] === active)
  );
  const link = ([href, label, key]: Entry) => (
    <a key={key} className={active === key ? "active" : ""}
      aria-current={active === key ? "page" : undefined}
      href={href} onClick={() => setMobileOpen(false)}>{label}</a>
  );

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <a href="/app" onClick={() => setMobileOpen(false)}>Business OS</a>
        <button className="sidebar-mobile-toggle" type="button"
          aria-controls="corebiz-navigation" aria-expanded={mobileOpen}
          aria-label={mobileOpen ? "Закрыть меню" : "Открыть меню"}
          onClick={() => setMobileOpen((current) => !current)}>
          {mobileOpen ? "Закрыть" : "Меню"}
        </button>
      </div>
      <nav id="corebiz-navigation" aria-label="Разделы системы"
        className={mobileOpen ? "sidebar-nav is-open" : "sidebar-nav"}>
        <label className="sidebar-profile">
          <span>Показывать разделы для</span>
          <select value={profile} onChange={(event) => updateProfile(event.target.value as MenuProfile)}>
            <option value="all">Все направления</option>
            <option value="commerce">Торговля и интернет-магазин</option>
            <option value="service">Услуги и запись клиентов</option>
            <option value="warehouse">Склад и логистика</option>
          </select>
        </label>
        <GlobalCommandPalette />
        <a className={active === "dashboard" ? "active sidebar-home" : "sidebar-home"
          aria-current={active === "dashboard" ? "page" : undefined}
          href="/app" onClick={() => setMobileOpen(false)}>Сегодня</a>
        {visibleSections.map((section) => (
          <details key={section.title}
            className="sidebar-group"
            open={expanded[section.title] ?? section.items.some((entry) => entry[2] === active)}
            onToggle={(event) => {
              const isOpen = event.currentTarget.open;
              setExpanded((previous) =>
                previous[section.title] === isOpen
                  ? previous
                  : { ...previous, [section.title]: isOpen }
              );
            }}>
            <summary>{section.title}</summary>
            <div className="sidebar-links">{section.items.map(link)}</div>
          </details>
        ))}
      </nav>
    </aside>
  );
}
