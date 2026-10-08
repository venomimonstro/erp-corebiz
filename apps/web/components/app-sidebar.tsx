export function AppSidebar({ active }: { active: string }) {
  const link = (href: string, label: string, key: string) => (
    <a className={active === key ? "active" : ""} href={href}>{label}</a>
  );

  return (
    <aside className="sidebar">
      <strong>Business OS</strong>
      {link("/app", "Сегодня", "dashboard")}
      {link("/app/work", "Моя работа", "work")}

      <span>CRM</span>
      {link("/app/crm/deals", "Сделки", "deals")}
      {link("/app/tasks", "Задачи", "tasks")}
      {link("/app/crm/customers", "Клиенты", "customers")}

      <span>Сервис</span>
      {link("/app/service", "Сегодня сервиса", "service-home")}
      {link("/app/service/bookings", "Записи", "bookings")}
      {link("/app/service/resources", "Ресурсы", "resources")}

      <span>Бизнес</span>
      {link("/app/sales/orders", "Заказы", "orders")}
      {link("/app/catalog/products", "Товары", "products")}
      {link("/app/purchases", "Закупки", "purchases")}
      {link("/app/inventory/stock", "Склад", "stock")}
      {link("/app/finance", "Деньги", "finance")}

      <span>Аналитика</span>
      {link("/app/analytics", "Сквозная аналитика", "analytics")}
      {link("/app/analytics/settings", "Трекер", "analytics-settings")}

      <span>Аналитика</span>
      {link("/app/analytics/growth", "Трафик", "growth")}
      {link("/app/analytics/marketing", "Реклама", "marketing")}
      {link("/app/analytics/profitability", "Где деньги", "profitability")}

      <span>Система</span>
      {link("/app/support", "Поддержка", "support")}
      {link("/app/settings", "Настройки", "settings")}
      {link("/app/settings/billing", "Тариф", "billing")}
      {link("/app/settings/customization", "Настройка системы", "customization")}
      {link("/app/workflows", "Автоматизации", "workflows")}
    </aside>
  );
}
