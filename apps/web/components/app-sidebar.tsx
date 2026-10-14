"use client";

import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../lib/api";
import { GlobalCommandPalette } from "./global-command-palette";
import { ActionQueueCenter } from "./action-queue-center";

type Entry = readonly [href: string, label: string, key: string];
type Section = { title: string; items: Entry[] };
type MenuProfile = "all" | "commerce" | "service" | "warehouse" | "dance" | "automotive" | "agency";
type Capability = { key: string; enabled: boolean };
type WorkspaceContext = {
  roles: string[];
  permissions: Array<{ code: string; scope: string }>;
  profileCode: string;
  verticalCode: string | null;
  tenantId: string;
  workspace: string;
};

const permissionByKey: Record<string,string> = {
  deals: "crm.read",
  customers: "crm.read",
  tasks: "tasks.read",
  projects: "projects.read",
  agency: "projects.read",
  orders: "sales.read",
  products: "catalog.read",
  purchases: "procurement.read",
  stock: "inventory.read",
  replenishment: "inventory.read",
  retail: "inventory.read",
  finance: "finance.read",
  "finance-forecast": "finance.read",
  "finance-budget": "finance.read",
  accounting: "accounting.read",
  "accounting-taxes": "accounting.compliance.read",
  "service-desk": "service.read",
  "service-home": "service.read",
  "service-setup": "service.read",
  "first-day": "customization.manage",
  "team-settings": "users.manage",
  "integration-settings": "platform.settings.manage",
  "service-team": "service.read",
  dance: "dance.read",
  "dance-students": "dance.read",
  "dance-groups": "dance.read",
  "dance-directions": "dance.read",
  "dance-team": "dance.read",
  "dance-setup": "dance.read",
  bookings: "service.read",
  "service-waitlist": "service.read",
  resources: "service.read",
  "service-assets": "service.read",
  automotive: "service.read",
  "service-packages": "service.read",
  channels: "channels.read",
  ecommerce: "channels.read",
  oms: "oms.read",
  returns: "returns.read",
  sites: "sites.read",
  migration: "migration.manage",
  analytics: "analytics.read",
  profitability: "analytics.read",
  marketing: "analytics.read",
  growth: "analytics.read",
  conversions: "analytics.read",
  "analytics-settings": "analytics.read",
  wms: "wms.read",
  "wms-operations": "wms.read",
  "wms-inbound": "wms.read",
  "wms-mobile": "wms.read",
  "wms-owners": "wms.read",
  "wms-billing": "wms.read",
  "wms-portal": "wms.read",
  workflows: "workflow.read",
  "owner-assistant": "dashboard.owner.read",
  "commerce-decisions": "dashboard.owner.read",
  "commerce-launch": "sites.read",
  operations: "dashboard.owner.read",
  customization: "customization.manage",
  "release-readiness": "release.read",
  "go-live": "go_live.read",
  pilot: "pilot.read",
  support: "support.read",
  "data-management": "data.export",
  "security-center": "audit.read",
  "runtime-pressure": "runtime.pressure.read"
};

const capabilityByKey: Record<string,string> = {
  deals: "crm",
  customers: "crm",
  tasks: "tasks",
  projects: "projects",
  agency: "projects",
  orders: "sales",
  products: "catalog",
  purchases: "procurement",
  stock: "inventory",
  retail: "inventory",
  finance: "finance",
  "finance-forecast": "finance",
  "finance-budget": "finance",
  accounting: "accounting",
  "accounting-taxes": "accounting",
  "service-desk": "service",
  "service-home": "service",
  "service-setup": "service",
  "service-team": "service",
  dance: "dance",
  "dance-students": "dance",
  "dance-groups": "dance",
  "dance-directions": "dance",
  "dance-team": "dance",
  "dance-setup": "dance",
  bookings: "service",
  "service-waitlist": "service",
  resources: "service",
  "service-assets": "service",
  automotive: "service",
  "service-packages": "service",
  channels: "channels",
  ecommerce: "channels",
  oms: "oms",
  returns: "oms",
  sites: "sites",
  "commerce-launch": "sites",
  analytics: "growth",
  profitability: "growth",
  marketing: "growth",
  growth: "growth",
  conversions: "growth",
  "analytics-settings": "growth",
  wms: "wms",
  "wms-operations": "wms",
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
  dance: ["Клиенты и задачи", "Запись и услуги", "Продажи и товары", "Управление"],
  automotive: ["Клиенты и задачи", "Запись и услуги", "Продажи и товары", "Управление"],
  agency: ["Клиенты и задачи", "Продажи и товары", "Аналитика", "Управление"],
  commerce: ["Клиенты и задачи", "Продажи и товары", "Онлайн-торговля", "Аналитика", "Управление"],
  service: ["Клиенты и задачи", "Запись и услуги", "Продажи и товары", "Аналитика", "Управление"],
  warehouse: ["Клиенты и задачи", "Продажи и товары", "Склад и 3PL", "Управление"]
};

// Client-friendly mode keeps the full modules available behind an explicit
// switch. This only reduces navigation noise: backend permissions still apply.
const essentialItems:Record<MenuProfile,readonly string[]>={
  all:["first-day","deals","customers","tasks","products","orders",
    "finance","billing","team-settings","support"],
  service:["first-day","service-desk","customers","service-team",
    "service-packages","finance","team-settings","billing","support"],
  dance:["first-day","dance","dance-students","dance-groups","dance-directions",
    "dance-team","dance-setup","finance","billing","support"],
  automotive:["first-day","automotive","service-assets","bookings",
    "products","stock","orders","finance","billing","support"],
  commerce:["first-day","commerce-launch","orders","products","stock","replenishment","purchases","oms",
    "sites","channels","retail","returns","finance","billing","support"],
  warehouse:["first-day","wms","wms-operations","wms-inbound","wms-mobile","wms-owners",
    "wms-billing","stock","replenishment","products","billing","support"],
  agency:["first-day","deals","customers","agency","projects",
    "tasks","finance","billing","support"]
};

const sections: Section[] = [
  { title: "Клиенты и задачи", items: [
    ["/app/crm/deals", "Сделки", "deals"],
    ["/app/crm/customers", "Клиенты", "customers"],
    ["/app/tasks", "Задачи", "tasks"],
    ["/app/projects", "Проекты", "projects"],
    ["/app/agency", "Агентство", "agency"]
  ] },
  { title: "Продажи и товары", items: [
    ["/app/sales/orders", "Заказы", "orders"],
    ["/app/catalog/products", "Товары и услуги", "products"],
    ["/app/purchases", "Закупки", "purchases"],
    ["/app/inventory/stock", "Остатки", "stock"],
    ["/app/inventory/replenishment", "Пополнить запасы", "replenishment"],
    ["/app/retail", "Сеть магазинов", "retail"],
    ["/app/finance", "Деньги", "finance"],
    ["/app/finance/forecast", "Платёжный календарь", "finance-forecast"],
    ["/app/finance/budget", "Бюджет план / факт", "finance-budget"],
    ["/app/accounting", "Бухгалтерия РФ", "accounting"],
    ["/app/accounting/taxes", "Налоги и ФНС", "accounting-taxes"]
  ] },
  { title: "Запись и услуги", items: [
    ["/app/dance", "Студия: обзор", "dance"],
    ["/app/dance/students", "Студия: ученики и деньги", "dance-students"],
    ["/app/dance/groups", "Студия: группы и уроки", "dance-groups"],
    ["/app/dance/directions", "Студия: направления", "dance-directions"],
    ["/app/dance/team", "Студия: тренеры и залы", "dance-team"],
    ["/app/dance/setup", "Студия: настройка", "dance-setup"],
    ["/app/service/desk", "Рабочее место услуг", "service-desk"],
    ["/app/service", "Операционная сводка", "service-home"],
    ["/app/service/setup", "Настройка услуг", "service-setup"],
    ["/app/service/team", "Команда и зарплата", "service-team"],
    ["/app/service/bookings", "Записи клиентов", "bookings"],
    ["/app/service/waitlist", "Лист ожидания", "service-waitlist"],
    ["/app/service/resources", "Сотрудники и ресурсы", "resources"],
    ["/app/service/assets", "Автомобили и объекты", "service-assets"],
    ["/app/automotive", "Автосервис и авторазбор", "automotive"],
    ["/app/service/packages", "Абонементы", "service-packages"]
  ] },
  { title: "Онлайн-торговля", items: [
    ["/app/commerce", "Магазин сегодня", "commerce-decisions"],
    ["/app/ecommerce", "Хаб маркетплейсов", "ecommerce"],
    ["/app/channels", "Каналы продаж", "channels"],
    ["/app/oms", "Управление заказами", "oms"],
    ["/app/returns", "Возвраты", "returns"],
    ["/app/commerce/launch", "Запуск интернет-магазина", "commerce-launch"],
    ["/app/sites", "Сайты и магазин", "sites"],
    ["/app/migration", "Импорт Excel / CSV", "migration"]
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
    ["/app/wms/operations", "Остатки и сборка", "wms-operations"],
    ["/app/wms/inbound", "Приёмка", "wms-inbound"],
    ["/app/wms/mobile", "Рабочее место ТСД", "wms-mobile"],
    ["/app/wms/owners", "Владельцы товара", "wms-owners"],
    ["/app/wms/billing", "3PL расчёты", "wms-billing"],
    ["/app/wms/portal", "Портал 3PL", "wms-portal"]
  ] },
  { title: "Управление", items: [
    ["/app/assistant", "Помощник владельца", "owner-assistant"],
    ["/app/operations", "Что требует внимания", "operations"],
    ["/app/start", "Первый запуск · выбор ниши", "first-day"],
    ["/app/settings", "Настройки", "settings"],
    ["/app/settings/team", "Команда и приглашения", "team-settings"],
    ["/app/settings/integrations", "Подключение касс и доставки", "integration-settings"],
    ["/app/settings/customization", "Адаптация системы", "customization"],
    ["/app/workflows", "Автоматизации", "workflows"],
    ["/app/settings/billing", "Тариф и оплата", "billing"],
    ["/app/settings/release", "Готовность релиза", "release-readiness"],
    ["/app/settings/go-live", "Go-Live Center", "go-live"],
    ["/app/settings/pilot", "Pilot / Hypercare", "pilot"],
    ["/app/settings/data", "Экспорт данных", "data-management"],
    ["/app/settings/security", "Безопасность и аудит", "security-center"],
    ["/app/settings/runtime-pressure", "Нагрузка системы", "runtime-pressure"],
    ["/app/support", "Поддержка", "support"]
  ] }
];

export function AppSidebar({ active }: { active: string }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [profile, setProfile] = useState<MenuProfile>("all");
  const [showAdvanced,setShowAdvanced]=useState(false);
  const [capabilities, setCapabilities] = useState<Record<string,boolean> | null>(null);
  const [workspaceContext, setWorkspaceContext] = useState<WorkspaceContext | null>(null);

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
          // Navigation preferences belong to a specific tenant; a user may
          // switch from their dance studio to a marketplace business.
          const preset:MenuProfile =
            context.verticalCode==="DANCE_FITNESS" ? "dance" :
            ["AUTO_SERVICE","AUTO_PARTS_DISMANTLING"].includes(context.verticalCode??"")
              ? "automotive" :
            ["PROFESSIONAL_SERVICES","WEB_STUDIO","WEB_MARKETING_AGENCY",
              "MARKETING_AGENCY"].includes(context.verticalCode??"")
              ? "agency" :
            context.profileCode==="ECOMMERCE" || context.profileCode==="TRADE"
              ? "commerce" : context.profileCode==="SERVICE" ? "service" :
            context.profileCode==="WAREHOUSE_3PL" ? "warehouse":"all";
          try {
            const stored=window.localStorage.getItem(
              "corebiz.menu.profile."+context.tenantId);
            const choices:MenuProfile[]=[
              "all","commerce","service","warehouse","dance","automotive","agency"
            ];
            setProfile(choices.includes(stored as MenuProfile)
              ? stored as MenuProfile:preset);
            setShowAdvanced(window.localStorage.getItem(
              "corebiz.menu.mode."+context.tenantId)==="advanced");
          }catch{setProfile(preset);setShowAdvanced(false);}
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
    if(workspaceContext?.tenantId) {
      try {
        window.localStorage.setItem(
          "corebiz.menu.profile."+workspaceContext.tenantId,value
        );
      } catch { /* no persistence */ }
    }
  }
  function updateNavigationMode(advanced:boolean){
    setShowAdvanced(advanced);
    if(workspaceContext?.tenantId){
      try{
        window.localStorage.setItem(
          "corebiz.menu.mode."+workspaceContext.tenantId,
          advanced?"advanced":"basic"
        );
      }catch{ /* browser storage is optional */ }
    }
  }

  const canManageProfile=Boolean(workspaceContext?.permissions.some(
    permission=>permission.code==="*"||
      permission.code==="customization.manage"
  ));
  const capabilityFilteredSections = useMemo(
    () =>
      sections
        .map((section) => ({
          ...section,
          items: section.items.filter((entry) => {
            if (entry[2] === active) return true;

            // An industry sidebar shows only relevant workflows. Users can
            // still choose "all" when they run a mixed business.
            const key=entry[2];
            if(!showAdvanced && !essentialItems[profile].includes(key))
              return false;
            if(profile==="dance" && (
              key==="automotive" || key==="service-assets" ||
              (key.startsWith("service-") &&
               !["service-setup","service-packages"].includes(key)) ||
              ["bookings","service-waitlist"].includes(key)
            ))return false;
            if(profile==="automotive" && (
              key.startsWith("dance") ||
              ["service-team","service-waitlist","service-packages"].includes(key)
            ))return false;
            if(profile==="service" && (key.startsWith("dance") ||
              key==="automotive" || key==="service-assets"))return false;
            if(profile==="agency" && (
              key.startsWith("dance") || key==="automotive" ||
              key.startsWith("service-") || ["bookings","resources"].includes(key)
            ))return false;

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
    [active, capabilities, workspaceContext, profile,showAdvanced]
  );

  const visibleSections = capabilityFilteredSections.filter((section) =>
    profile === "all" || profileSections[profile].includes(section.title) ||
    section.items.some((entry) => entry[2] === active)
  );
  const link = ([href, label, key]: Entry) => {
    const resolvedHref =
      key === "support" && typeof window !== "undefined"
        ? "/app/support?from=" +
          encodeURIComponent(
            window.location.pathname + window.location.search
          )
        : href;

    return (
      <a key={key} className={active === key ? "active" : ""}
        aria-current={active === key ? "page" : undefined}
        href={resolvedHref} onClick={() => setMobileOpen(false)}>{label}</a>
    );
  };

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
            <option value="dance">Студия танцев</option>
            <option value="automotive">Автосервис и авторазбор</option>
            <option value="agency">Агентство и проекты</option>
            <option value="commerce">Торговля и интернет-магазин</option>
            <option value="service">Услуги и запись клиентов</option>
            <option value="warehouse">Склад и логистика</option>
          </select>
        </label>
        <label className="sidebar-profile">
          <span>Режим меню</span>
          <select aria-label="Сложность меню" value={showAdvanced?"advanced":"basic"}
            onChange={event=>updateNavigationMode(event.target.value==="advanced")}>
            <option value="basic">Основные действия</option>
            <option value="advanced">Все инструменты</option>
          </select>
        </label>
        <GlobalCommandPalette />
        <a className={active === "dashboard" ? "active sidebar-home" : "sidebar-home"
          aria-current={active === "dashboard" ? "page" : undefined}
          href="/app" onClick={() => setMobileOpen(false)}>Сегодня</a>
        {canManageProfile?<a href="/app/start"
          className={active==="first-day"?"active sidebar-home":"sidebar-home"}
          aria-current={active==="first-day"?"page":undefined}
          onClick={()=>setMobileOpen(false)}>
          Настроить бизнес
        </a>:null}
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
