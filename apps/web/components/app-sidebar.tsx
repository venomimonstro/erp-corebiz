"use client";

import { useEffect, useState } from "react";

type Entry = readonly [href: string, label: string, key: string];
type Section = { title: string; items: Entry[] };
type MenuProfile = "all" | "commerce" | "service" | "warehouse";

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
    ["/app/operations", "Что требует внимания", "operations"],
    ["/app/settings", "Настройки", "settings"],
    ["/app/settings/customization", "Адаптация системы", "customization"],
    ["/app/workflows", "Автоматизации", "workflows"],
    ["/app/settings/billing", "Тариф и оплата", "billing"],
    ["/app/settings/release", "Готовность релиза", "release-readiness"],
    ["/app/support", "Поддержка", "support"]
  ] }
];

export function AppSidebar({ active }: { active: string }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [profile, setProfile] = useState<MenuProfile>("all");
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("corebiz.menu.profile");
      if (stored === "commerce" || stored === "service" || stored === "warehouse" || stored === "all") {
        setProfile(stored);
      }
    } catch { /* Private browsing: use a full navigation menu. */ }
  }, []);
  function updateProfile(value: MenuProfile) {
    setProfile(value);
    try { window.localStorage.setItem("corebiz.menu.profile", value); } catch { /* no persistence */ }
  }
  const visibleSections = sections.filter((section) =>
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
        <a className={active === "dashboard" ? "active sidebar-home" : "sidebar-home"}
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
