const capabilities = [
  "CRM и задачи",
  "Продажи и заказы",
  "Закупки и склад",
  "Деньги и прибыль",
  "Запись и ресурсы",
  "Сквозная аналитика"
];

export default function HomePage() {
  return (
    <main className="public-page">
      <header className="topbar">
        <strong>BUSINESS OS</strong>
        <nav>
          <a href="#product">Возможности</a>
          <a href="#why">Почему мы</a>
          <a href="/app">Открыть приложение</a>
        </nav>
      </header>

      <section className="hero">
        <span className="eyebrow">SaaS для бизнеса</span>
        <h1>Управляйте бизнесом, а не программой.</h1>
        <p>
          Клиенты, продажи, товары, закупки, склад и деньги в одной системе.
          Начните просто и включайте новые возможности по мере роста.
        </p>
        <div className="actions">
          <a className="primary" href="/app">Начать</a>
          <a className="secondary" href="#product">Посмотреть возможности</a>
        </div>
      </section>

      <section id="product" className="section">
        <h2>Одна платформа вместо набора сервисов</h2>
        <div className="grid">
          {capabilities.map((capability) => (
            <article key={capability} className="card">{capability}</article>
          ))}
        </div>
      </section>

      <section id="why" className="section">
        <h2>Главный результат — понять, где деньги и что делать дальше.</h2>
        <p>
          Владелец видит прибыль и отклонения. Менеджер — следующую задачу.
          Закупщик — потребность. Склад — операцию. Система скрывает лишнюю
          сложность и не требует переписывать Core под каждого клиента.
        </p>
      </section>
    </main>
  );
}
