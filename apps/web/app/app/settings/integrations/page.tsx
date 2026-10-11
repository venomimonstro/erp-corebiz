"use client";
import {AppSidebar} from "../../../../components/app-sidebar";

type Connector={
  name:string;kind:string;state:"CONFIGURATION_AVAILABLE"|"ADAPTER_REQUIRED";
  description:string;needed:string;deliverable:string;docs:string;
  href?:string;
};
const connectors:Connector[]=[
  {name:"ЮKassa",kind:"Оплата покупателей онлайн",
    state:"CONFIGURATION_AVAILABLE",
    description:"Для каждого интернет-магазина используются реквизиты самого продавца; HTTP-уведомления перепроверяются через API провайдера.",
    needed:"Shop ID, секретный ключ, договор эквайринга, HTTPS webhook и выбранная схема чека.",
    deliverable:"Проверить реальные статусы, возвраты, чека предоплаты и полного расчёта.",
    docs:"https://yookassa.ru/developers/payment-acceptance/getting-started/quick-start",
    href:"/app/sites/payments"},
  {name:"АТОЛ Онлайн",kind:"Облачная фискализация",
    state:"ADAPTER_REQUIRED",
    description:"Касса регистрирует чек по ФФД. Она не заменяет банк-эквайер и не подтверждает поступление денег.",
    needed:"Договор, логин, пароль, идентификатор группы ККТ; проверка ФФД 1.2 и чека маркированного товара.",
    deliverable:"Чек прихода/возврата/зачёта аванса; idempotency, callback, фискальные признаки, ошибки ФН/ОФД.",
    docs:"https://help.atol.online/article/11244"},
  {name:"Эвотор",kind:"Физические кассы / облачная фискализация",
    state:"ADAPTER_REQUIRED",
    description:"Два разных контура: смарт-терминал и документы из Облака Эвотор либо Цифровая касса для удалённых чеков.",
    needed:"Приложение разработчика, доступ к магазинам, идентификаторы касс; для цифровой кассы отдельные фискальные реквизиты.",
    deliverable:"Подтверждённые чеки и смены по точке; двусторонняя сверка продаж и возвратов.",
    docs:"https://developer.evotor.ru/docs/"},
  {name:"Банковские POS-терминалы",kind:"Оплата на торговой точке",
    state:"ADAPTER_REQUIRED",
    description:"Эквайринг терминала Сбер/Т-Банк/другого банка интегрируется отдельно от ККТ. Нельзя отмечать заказ оплаченным по нажатию кнопки.",
    needed:"Модель терминала, провайдер и протокол банка; TID/MID, тестовый контур и подтверждение захвата.",
    deliverable:"Sale/cancel/refund, reconciliation с банком, защита от повторного списания.",
    docs:"https://yookassa.ru/developers/offline-payments/getting-started/connection"},
  {name:"Честный ЗНАК",kind:"Маркировка",
    state:"ADAPTER_REQUIRED",
    description:"Нужны коды Data Matrix по каждой единице маркируемого товара, документы движения и проверка разрешительного режима для применимых групп.",
    needed:"Регистрация участника оборота, УКЭП/сертификаты, API-доступ, категории товаров и поддержка ТС ПИоТ/ФФД по применимости.",
    deliverable:"Приём/выбытие конкретного кода, проверка состояния, ошибка или повтор операции, события в журнале.",
    docs:"https://markirovka.ru/knowledge/tovarnye-gruppy/radioelektronnaya-produktsiya-noutbuki-i-smartfony/integratsiya-sistemy-markirovki-s-tovarouchetnoy-sistemoy-uchastnika-ikra"},
  {name:"СДЭК",kind:"Доставка и ПВЗ",
    state:"ADAPTER_REQUIRED",
    description:"Отдельный договор продавца; расчёт тарифа, ПВЗ, создание накладной, ярлык, статусы и возвраты.",
    needed:"Client ID/Secret API v2, договор, адрес склада, габариты и вес SKU, плательщик доставки.",
    deliverable:"Проверенная стоимость до оформления, идемпотентное создание отправления, печать и отслеживание.",
    docs:"https://developer.cdek.ru/"},
  {name:"Почта России",kind:"Доставка и постаматы",
    state:"ADAPTER_REQUIRED",
    description:"Сервис «Отправка»: договор, подготовка отправлений, списки/партии, печатные ярлыки и трекинг.",
    needed:"Токен приложения, ключ авторизации пользователя, доступ к сервису «Отправка».",
    deliverable:"Нормализация адреса, тарификация, заказ/партия, ШПИ, ярлык, статусы, отмена.",
    docs:"https://otpravka.pochta.ru/specification"}
];

export default function IntegrationsPage(){
  return <main className="app-shell">
    <AppSidebar active="settings"/>
    <section className="workspace workspace-wide studio-premium">
      <header className="studio-hero compact">
        <div><span className="studio-eyebrow">Commerce integrations</span>
          <h1>Кассы, оплата, маркировка и доставка</h1>
          <p>Каждый магазин и филиал подключает собственные договоры и реквизиты.
            Показаны только реально доступные способы настройки.
            Неподключённые провайдеры не принимают оплаты и не создают отправления.</p>
        </div>
      </header>
      <section className="studio-section">
        <h2>Подключить СДЭК или АТОЛ Онлайн</h2>
        <p>Можно сохранить реквизиты отдельного продавца, проверить
          авторизацию у провайдера и рассчитать тариф доставки СДЭК.</p>
        <a className="secondary-button"
          href="/app/settings/integrations/connect">
          Открыть подключения продавца →
        </a>
      </section>
      <section className="studio-section">
        <h2>Один заказ — несколько независимых подтверждений</h2>
        <div className="first-day-steps">
          {[
            ["1","Заказ и склад","Sales/OMS резервируют товар конкретного владельца и склада."],
            ["2","Платёж","Эквайер подтверждает захват денег; только затем запись в Finance."],
            ["3","ККТ","Фискализатор подтверждает чек с идентификаторами ФН/ФД/ФП."],
            ["4","Маркировка","Только для соответствующей группы товаров — проверка и вывод кода."],
            ["5","Доставка","Служба подтверждает накладную, трек, вручение или возврат."]
          ].map(([n,title,desc])=>(
            <article key={n} className="first-day-step">
              <span>{n}</span><div><strong>{title}</strong><p>{desc}</p></div>
            </article>
          ))}
        </div>
      </section>
      <section className="studio-section">
        <h2>Доступность интеграций</h2>
        <div className="first-day-options">
          {connectors.map(p=>(
            <article key={p.name} className="first-day-summary">
              <small className="muted">{p.kind}</small>
              <h3>{p.name}</h3>
              <p><strong>{p.state==="CONFIGURATION_AVAILABLE"?
                "Настройка доступна; готовность проверяется отдельно":
                "Коннектор ещё требуется разработать и проверить"}</strong></p>
              <p>{p.description}</p>
              <p><strong>Что потребуется:</strong> {p.needed}</p>
              <p><strong>Условия готовности:</strong> {p.deliverable}</p>
              <div className="studio-hero-actions">
                {p.href?<a href={p.href} className="secondary-button">
                  Настройки магазина →</a>:null}
                <a href={p.docs} target="_blank" rel="noreferrer"
                  className="secondary-button">Документация ↗</a>
              </div>
            </article>
          ))}
        </div>
      </section>
      <section className="studio-section">
        <h2>Прежде чем активировать реальные продажи</h2>
        <p>Для АТОЛ, Эвотор, Честного ЗНАКа, СДЭК и Почты России ещё необходимы
          выделенные адаптеры, настройка ключей в зашифрованном хранилище,
          тестовые кабинеты, фоновые очереди, повторы по ключу идемпотентности,
          сверка внешних статусов и интеграционные тесты.
          До этого система не показывает ложный статус «Подключено».</p>
        <p>Для сети офлайн-магазинов также нужны роли кассиров по точке,
          фактическая интеграция с банковским терминалом и фискальный
          регистратор. Онлайн-эквайринг ЮKassa настраивается для каждой
          витрины отдельно.</p>
      </section>
    </section>
  </main>;
}
