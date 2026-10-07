const kpis = [
  ["Деньги", "—"],
  ["Продажи", "—"],
  ["Валовая прибыль", "—"],
  ["Заказы", "—"],
  ["Дебиторка", "—"],
  ["Запасы", "—"]
];

export default function AppHomePage() {
  return (
    <main className="app-shell">
      <aside className="sidebar">
        <strong>Business OS</strong>
        <a className="active" href="/app">Сегодня</a>
        <a href="/app/work">Моя работа</a>
        <span>CRM</span>
        <a href="/app/crm/deals">Сделки</a>
        <a href="/app/tasks">Задачи</a>
        <span>Бизнес</span>
        <a href="/app/sales/orders">Заказы</a>
        <a href="/app/catalog/products">Товары</a>
        <a href="/app/purchases">Закупки</a>
        <a href="/app/inventory/stock">Склад</a>
        <a href="/app/finance">Деньги</a>
      </aside>

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Среда владельца</p>
            <h1>Сегодня</h1>
          </div>
          <button type="button">+ Создать</button>
        </header>

        <div className="kpi-grid">
          {kpis.map(([label, value]) => (
            <article className="kpi" key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </article>
          ))}
        </div>

        <section className="attention">
          <div>
            <p className="muted">Action & Exception Engine</p>
            <h2>Требует решения</h2>
          </div>
          <p>После подключения данных здесь появятся только ситуации, в которых требуется действие человека.</p>
        </section>
      </section>
    </main>
  );
}
