"use client";

import { useState } from "react";

type Entry = readonly [href: string, label: string, key: string];
type Section = { title: string; items: Entry[] };

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
    ["/app/finance", "Деньги", "finance"]
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
    ["/app/settings", "Настройки", "settings"],
    ["/app/settings/customization", "Адаптация системы", "customization"],
    ["/app/workflows", "Автоматизации", "workflows"],
    ["/app/settings/billing", "Тариф и оплата", "billing"],
    ["/app/support", "Поддержка", "support"]
  ] }
];

export function AppSidebar({ active }: { active: string }) {
  const [mobileOpen, setMobileOpen] = useState(false);
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
        <a className={active === "dashboard" ? "active sidebar-home" : "sidebar-home"}
          aria-current={active === "dashboard" ? "page" : undefined}
          href="/app" onClick={() => setMobileOpen(false)}>Сегодня</a>
        {sections.map((section) => (
          <details key={section.title}
            className="sidebar-group"
            open={undefined}
            // Native details: keyboard accessible, keeps inactive modules out of the way.
            defaultOpen={section.items.some((entry) => entry[2] === active)}>
            <summary>{section.title}</summary>
            <div className="sidebar-links">{section.items.map(link)}</div>
          </details>
        ))}
      </nav>
    </aside>
  );
}
