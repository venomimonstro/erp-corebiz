export type BusinessProfileCode =
  | "GENERAL"
  | "TRADE"
  | "ECOMMERCE"
  | "SERVICE"
  | "WAREHOUSE_3PL";

export const BUSINESS_CAPABILITIES = [
  "crm",
  "tasks",
  "catalog",
  "sales",
  "procurement",
  "inventory",
  "finance",
  "accounting",
  "service",
  "dance",
  "projects",
  "channels",
  "oms",
  "sites",
  "growth",
  "wms",
  "workflow",
  "support"
] as const;

export type BusinessCapabilityKey = (typeof BUSINESS_CAPABILITIES)[number];

export type BusinessVerticalCode =
  | "GENERAL"
  | "BEAUTY_SALON"
  | "BARBERSHOP"
  | "NAIL_SALON"
  | "AUTO_SERVICE"
  | "AUTO_PARTS_DISMANTLING"
  | "DANCE_FITNESS"
  | "PROFESSIONAL_SERVICES"
  | "WEB_MARKETING_AGENCY"
  | "RETAIL_STORE"
  | "WHOLESALE_B2B"
  | "ECOMMERCE_STORE"
  | "MARKETPLACE_SELLER"
  | "WAREHOUSE_3PL";

export type VerticalField = {
  entityType: "DEAL" | "PARTY" | "PRODUCT" | "SALES_ORDER" | "PURCHASE_ORDER";
  fieldKey: string;
  label: string;
  dataType: "TEXT" | "NUMBER" | "DATE" | "BOOLEAN" | "SELECT" | "MULTISELECT";
  options?: string[];
};

export type BusinessVerticalTemplate = {
  code: BusinessVerticalCode;
  title: string;
  summary: string;
  profileCode: BusinessProfileCode;
  version: number;
  enabledCapabilities: BusinessCapabilityKey[];
  customFields: VerticalField[];
  ownerQuestions: string[];
  primaryWorkspaces: string[];
  operatingFlows: string[];
  attentionSignals: string[];
};

export const BUSINESS_VERTICALS: Record<
  BusinessVerticalCode,
  BusinessVerticalTemplate
> = {
  GENERAL: {
    code: "GENERAL",
    title: "Универсальный бизнес",
    summary: "Смешанные процессы без отраслевой преднастройки.",
    profileCode: "GENERAL",
    version: 3,
    enabledCapabilities: [...BUSINESS_CAPABILITIES],
    customFields: [],
    ownerQuestions: [
      "Сколько денег доступно сейчас?",
      "Что требует моего внимания?",
      "Где компания теряет деньги?"
    ],
    primaryWorkspaces: ["owner", "crm", "finance"],
    operatingFlows: [
      "Лид → сделка → заказ → оплата",
      "Закупка → приёмка → остаток → продажа",
      "План-факт денег и обязательств"
    ],
    attentionSignals: [
      "Просроченные задачи и дебиторка",
      "Отрицательный или нулевой доступный остаток",
      "Сделки без следующего действия"
    ]
  },
  BEAUTY_SALON: {
    code: "BEAUTY_SALON",
    title: "Салон красоты",
    summary: "Запись, мастера, кабинеты, персональные цены, техкарты, расходники, зарплата и повторные визиты.",
    profileCode: "SERVICE",
    version: 4,
    enabledCapabilities: [
      "crm","tasks","catalog","sales","procurement","inventory","finance","accounting",
      "service","sites","growth","workflow","support"
    ],
    customFields: [
      { entityType: "PARTY", fieldKey: "birthday", label: "Дата рождения", dataType: "DATE" },
      { entityType: "PARTY", fieldKey: "beauty_preferences", label: "Предпочтения клиента", dataType: "TEXT" },
      { entityType: "PARTY", fieldKey: "service_notes", label: "Важные примечания к сервису", dataType: "TEXT" }
    ],
    ownerQuestions: [
      "Какая загрузка мастеров и кабинетов сегодня и на неделю?",
      "Какие услуги, мастера и категории дают больше маржи после материалов?",
      "Сколько начислено команде и что нужно выплатить по итогам месяца?",
      "Кто из клиентов не вернулся в ожидаемый срок?"
    ],
    primaryWorkspaces: ["service", "crm", "inventory", "finance", "growth"],
    operatingFlows: [
      "Клиент → запись → мастер + кабинет → услуга → оплата",
      "Услуга × мастер → персональная цена и длительность",
      "Техкарта → фактические расходники → склад → себестоимость визита",
      "Завершённый визит → начисление мастеру → маржа",
      "История клиента → повторная запись → удержание"
    ],
    attentionSignals: [
      "Свободные окна при высоком спросе",
      "No-show и поздние отмены",
      "Визит завершён без рассчитанной маржи",
      "Расход материалов выше нормы",
      "Сотрудник без правила оплаты",
      "Клиент не вернулся в ожидаемый срок"
    ]
  },
  BARBERSHOP: {
    code: "BARBERSHOP",
    title: "Барбершоп",
    summary: "Барберы, кресла, персональные прайсы, стрижки и борода, расходники, товарные продажи и зарплата.",
    profileCode: "SERVICE",
    version: 1,
    enabledCapabilities: [
      "crm","tasks","catalog","sales","procurement","inventory","finance","accounting",
      "service","sites","growth","workflow","support"
    ],
    customFields: [
      { entityType: "PARTY", fieldKey: "preferred_barber", label: "Предпочитаемый барбер", dataType: "TEXT" },
      { entityType: "PARTY", fieldKey: "hair_beard_notes", label: "Стрижка / борода: предпочтения", dataType: "TEXT" },
      { entityType: "PARTY", fieldKey: "next_visit_target", label: "Ожидаемая дата следующего визита", dataType: "DATE" }
    ],
    ownerQuestions: [
      "Какая загрузка кресел и барберов по часам?",
      "Кто приносит маржу после расходников и зарплаты?",
      "Какие клиенты должны вернуться на повторную стрижку?",
      "Сколько зарабатываем на услугах и розничных товарах?"
    ],
    primaryWorkspaces: ["service", "crm", "sales", "inventory", "finance"],
    operatingFlows: [
      "Клиент → барбер → кресло → услуга → оплата",
      "Стрижка/борода → техкарта → расходники → фактическая себестоимость",
      "Визит → фикс/процент/комбинация → зарплата барбера",
      "Визит → рекомендация товара → продажа → дополнительная маржа",
      "Дата последней услуги → срок повторения → напоминание"
    ],
    attentionSignals: [
      "Окно барбера простаивает",
      "Барбер перегружен, а другие свободны",
      "Клиент просрочил ожидаемый повторный визит",
      "Расход материалов выше техкарты",
      "Завершённый визит без правила зарплаты"
    ]
  },
  NAIL_SALON: {
    code: "NAIL_SALON",
    title: "Маникюрный салон",
    summary: "Мастера, столы, покрытия и дизайны, нормы материалов, персональная длительность, зарплата и возврат клиентов.",
    profileCode: "SERVICE",
    version: 1,
    enabledCapabilities: [
      "crm","tasks","catalog","sales","procurement","inventory","finance","accounting",
      "service","sites","growth","workflow","support"
    ],
    customFields: [
      { entityType: "PARTY", fieldKey: "nail_preferences", label: "Предпочтения по маникюру", dataType: "TEXT" },
      { entityType: "PARTY", fieldKey: "preferred_nail_master", label: "Предпочитаемый мастер", dataType: "TEXT" },
      { entityType: "PARTY", fieldKey: "next_visit_target", label: "Ожидаемая дата следующего визита", dataType: "DATE" }
    ],
    ownerQuestions: [
      "Как загружены мастера и рабочие места?",
      "Какие услуги и мастера дают маржу после материалов?",
      "Не растёт ли расход базы, покрытия и одноразовых материалов?",
      "Кому пора напомнить о следующем визите?"
    ],
    primaryWorkspaces: ["service", "crm", "inventory", "finance", "growth"],
    operatingFlows: [
      "Клиент → мастер → рабочее место → услуга → оплата",
      "Маникюр + покрытие + дизайн → длительность и цена конкретного мастера",
      "Техкарта → база/цвет/одноразовые материалы → автосписание",
      "Завершённый визит → начисление мастеру → маржа",
      "Период носки → целевая дата следующего визита → возврат"
    ],
    attentionSignals: [
      "Перерасход материалов относительно техкарты",
      "Длинные свободные окна в расписании",
      "Клиент не записался повторно в целевой срок",
      "Сотрудник без зарплатного правила",
      "Визит закрыт без расхода материалов"
    ]
  },
  AUTO_SERVICE: {
    code: "AUTO_SERVICE",
    title: "Автосервис",
    summary: "VIN, автомобили клиентов, заказ-наряды, диагностика, работы, запчасти, посты, механики, склад и прибыль.",
    profileCode: "SERVICE",
    version: 5,
    enabledCapabilities: [
      "crm","tasks","catalog","sales","procurement","inventory","finance","accounting",
      "service","sites","growth","workflow","support"
    ],
    customFields: [
      { entityType: "DEAL", fieldKey: "customer_complaint", label: "Жалоба / запрос клиента", dataType: "TEXT" },
      { entityType: "DEAL", fieldKey: "authorization_limit", label: "Лимит согласования", dataType: "NUMBER" }
    ],
    ownerQuestions: [
      "Какие посты и механики загружены?",
      "Сколько заработано на работах и сколько на запчастях?",
      "Какие заказ-наряды зависли и почему?"
    ],
    primaryWorkspaces: ["service", "crm", "inventory", "procurement", "finance"],
    operatingFlows: [
      "Клиент → автомобиль → история → диагностика → согласование → работы → выдача",
      "Потребность в запчастях → резерв → закупка → расход",
      "Работы + запчасти → фактическая маржа заказ-наряда"
    ],
    attentionSignals: [
      "Автомобиль завис в статусе без следующего действия",
      "Запчасть не зарезервирована или не пришла",
      "Пост простаивает или перегружен"
    ]
  },
  AUTO_PARTS_DISMANTLING: {
    code: "AUTO_PARTS_DISMANTLING",
    title: "Автозапчасти / авторазбор",
    summary: "Доноры, снятые детали, OEM и аналоги, совместимость, состояние, склад, продажи и маржа каждой детали.",
    profileCode: "TRADE",
    version: 1,
    enabledCapabilities: [
      "crm","tasks","catalog","sales","procurement","inventory","finance","accounting",
      "service","oms","sites","growth","workflow","support"
    ],
    customFields: [
      { entityType: "PRODUCT", fieldKey: "oem_number", label: "OEM номер", dataType: "TEXT" },
      { entityType: "PRODUCT", fieldKey: "part_condition", label: "Состояние детали", dataType: "SELECT", options: ["NEW","USED_A","USED_B","USED_C","FOR_REPAIR"] },
      { entityType: "PRODUCT", fieldKey: "donor_stock_number", label: "Номер донора", dataType: "TEXT" },
      { entityType: "SALES_ORDER", fieldKey: "customer_vin", label: "VIN автомобиля клиента", dataType: "TEXT" }
    ],
    ownerQuestions: [
      "Сколько денег заморожено в донорах и снятых деталях?",
      "Какие детали продаются быстро, а какие залежались?",
      "Какие OEM и аналоги чаще всего ищут и не находят?",
      "Какая фактическая прибыль по каждому донору после разборки и списаний?"
    ],
    primaryWorkspaces: ["service", "catalog", "inventory", "sales", "procurement", "finance"],
    operatingFlows: [
      "Покупка донора → приёмка → разбор → оценка состояния → создание деталей → склад",
      "OEM/VIN клиента → подбор совместимости → резерв детали → продажа/установка",
      "Деталь → фото/состояние/OEM/аналоги → публикация → заказ → отгрузка",
      "Стоимость донора + разборка → распределение себестоимости → маржа проданных деталей"
    ],
    attentionSignals: [
      "Донор долго не разобран",
      "Снятая деталь без OEM или совместимости",
      "Деталь зарезервирована, но заказ не завершён",
      "Залежавшиеся детали и низкая оборачиваемость",
      "Продажа ниже распределённой себестоимости"
    ]
  },
  DANCE_FITNESS: {
    code: "DANCE_FITNESS",
    title: "Студия танцев / фитнес",
    summary: "Дети и плательщики, группы, индивидуальные уроки, залы, абонементы, посещения, долги, зарплата тренеров и прибыльность.",
    profileCode: "SERVICE",
    version: 5,
    enabledCapabilities: [
      "crm","tasks","sales","finance","accounting","service","dance","sites","growth","workflow","support"
    ],
    customFields: [
      { entityType: "PARTY", fieldKey: "training_level", label: "Уровень подготовки", dataType: "SELECT", options: ["Новичок", "Средний", "Продвинутый"] },
      { entityType: "PARTY", fieldKey: "training_notes", label: "Примечания по занятиям", dataType: "TEXT" },
      { entityType: "PARTY", fieldKey: "student_status", label: "Статус ученика", dataType: "SELECT", options: ["Пробное", "Активный", "Пауза", "Ушёл"] }
    ],
    ownerQuestions: [
      "Кто из учеников или семей должен оплатить и за что именно?",
      "Какие группы находятся выше и ниже точки безубыточности?",
      "Сколько заработал каждый тренер по фактическим правилам оплаты?",
      "Какая выручка и маржа на час каждого зала?",
      "Кто перестал посещать и у кого скоро закончится абонемент?"
    ],
    primaryWorkspaces: ["service", "crm", "finance", "growth"],
    operatingFlows: [
      "Родитель/плательщик → ребёнок → пробное занятие → группа → абонемент",
      "Абонемент → резерв посещения → attendance/no-show → списание, возврат или отработка",
      "Группа → серия уроков → тренер + зал → участники → закрытие посещаемости",
      "Оплата → распределение по ребёнку/обязательству → долг семьи → погашение",
      "Завершённый урок → реализация → зарплата тренера → стоимость зала → маржа",
      "Расписание → capacity/waitlist → загрузка → решение открыть, объединить или закрыть группу"
    ],
    attentionSignals: [
      "Урок завершён, но посещаемость не закрыта",
      "Ученик посещает без действующего источника оплаты",
      "Семья или ученик имеет просроченный долг",
      "Группа ниже точки безубыточности",
      "Абонемент заканчивается, исчерпан или требует продления",
      "Клиент перестал посещать занятия",
      "Конфликт расписания тренера или зала",
      "Переполнена группа или растёт лист ожидания",
      "Зарплата тренера или стоимость зала не рассчитана по завершённому уроку"
    ]
  },
  PROFESSIONAL_SERVICES: {
    code: "PROFESSIONAL_SERVICES",
    title: "Профессиональные услуги / IT / агентство",
    summary: "Лиды, сделки, проекты, этапы, трудозатраты, счета и дебиторка.",
    profileCode: "SERVICE",
    version: 4,
    enabledCapabilities: [
      "crm","tasks","sales","finance","accounting","service","projects","sites","growth","workflow","support"
    ],
    customFields: [
      { entityType: "DEAL", fieldKey: "project_type", label: "Тип проекта", dataType: "TEXT" },
      { entityType: "DEAL", fieldKey: "client_deadline", label: "Срок клиента", dataType: "DATE" },
      { entityType: "DEAL", fieldKey: "project_budget", label: "Бюджет проекта", dataType: "NUMBER" }
    ],
    ownerQuestions: [
      "Какие сделки и проекты принесут деньги в ближайшие 30 дней?",
      "Какая дебиторка просрочена?",
      "У кого из сотрудников перегруз?"
    ],
    primaryWorkspaces: ["crm", "projects", "tasks", "finance"],
    operatingFlows: [
      "Лид → оценка → сделка → проект → этапы → сдача → оплата",
      "Проект → задачи → трудозатраты → фактическая себестоимость",
      "Этап → срок → результат → клиентское согласование",
      "Счёт → дебиторка → поступление денег"
    ],
    attentionSignals: [
      "Проект без следующей задачи",
      "Просроченный этап проекта",
      "Фактические трудозатраты выше оценки",
      "Просроченная дебиторка"
    ]
  },
  WEB_MARKETING_AGENCY: {
    code: "WEB_MARKETING_AGENCY",
    title: "Веб-студия / маркетинговое агентство",
    summary: "CRM, продажи, проекты, ретейнеры, дедлайны, согласования, рекламные бюджеты, часы команды, маржинальность и бухгалтерия.",
    profileCode: "SERVICE",
    version: 1,
    enabledCapabilities: [
      "crm","tasks","sales","finance","accounting","projects",
      "sites","growth","workflow","support"
    ],
    customFields: [
      { entityType: "DEAL", fieldKey: "service_mix", label: "Услуги / scope", dataType: "TEXT" },
      { entityType: "DEAL", fieldKey: "decision_maker", label: "ЛПР", dataType: "TEXT" },
      { entityType: "DEAL", fieldKey: "monthly_budget", label: "Месячный бюджет", dataType: "NUMBER" },
      { entityType: "DEAL", fieldKey: "target_cpa_roas", label: "Целевой CPA / ROAS", dataType: "TEXT" }
    ],
    ownerQuestions: [
      "Какие сделки имеют следующий шаг и когда?",
      "Какие проекты ждут клиента и какие дедлайны под риском?",
      "Какова маржа по каждому клиенту после часов команды и рекламного бюджета?",
      "Сколько ретейнерной выручки защищено на следующий месяц?",
      "Какая дебиторка и какие налоги требуют действия?"
    ],
    primaryWorkspaces: ["crm","agency","projects","tasks","finance","accounting","growth"],
    operatingFlows: [
      "Лид → квалификация → оценка → КП → переговоры → договор → проект",
      "Проект → scope → deliverables → внутренняя проверка → согласование клиента → сдача",
      "Ретейнер → месячный план → трудозатраты → рекламный бюджет → отчёт → счёт → оплата",
      "Маркетинг клиента → кампании → расходы → лиды/сделки → ROMI/маржа",
      "Доходы и выплаты → бухгалтерский контур → налоговый календарь"
    ],
    attentionSignals: [
      "Сделка без следующего действия",
      "КП отправлено, но follow-up не назначен",
      "Deliverable просрочен или завис на согласовании",
      "Фактические часы превышают оценку или съедают целевую маржу",
      "Рекламный бюджет вырос без ожидаемой отдачи",
      "Клиентская дебиторка просрочена",
      "Налоговое обязательство приближается к сроку"
    ]
  },

  RETAIL_STORE: {
    code: "RETAIL_STORE",
    title: "Розничная торговля",
    summary: "Товары, цены, остатки, закупки, продажи и деньги по точкам.",
    profileCode: "TRADE",
    version: 3,
    enabledCapabilities: [
      "crm","tasks","catalog","sales","procurement","inventory","finance","accounting",
      "growth","workflow","support"
    ],
    customFields: [
      { entityType: "PRODUCT", fieldKey: "brand", label: "Бренд", dataType: "TEXT" },
      { entityType: "PRODUCT", fieldKey: "season", label: "Сезон", dataType: "TEXT" }
    ],
    ownerQuestions: [
      "Что продаётся и что зависло?",
      "Где заканчивается товар?",
      "Какая валовая прибыль по магазину и категории?"
    ],
    primaryWorkspaces: ["sales", "inventory", "procurement", "finance"],
    operatingFlows: [
      "Закупка → приёмка → остаток → продажа",
      "Продажа → списание → валовая прибыль",
      "Остаток → риск дефицита → пополнение"
    ],
    attentionSignals: [
      "Out-of-stock и отрицательный доступный остаток",
      "Медленно оборачиваемый товар",
      "Просроченная поставка"
    ]
  },
  WHOLESALE_B2B: {
    code: "WHOLESALE_B2B",
    title: "Оптовая B2B торговля",
    summary: "CRM, договорные цены, кредитные лимиты, заказы, склад и дебиторка.",
    profileCode: "TRADE",
    version: 4,
    enabledCapabilities: [
      "crm","tasks","catalog","sales","procurement","inventory","finance","accounting",
      "growth","workflow","support"
    ],
    customFields: [
      { entityType: "PARTY", fieldKey: "client_segment", label: "Сегмент клиента", dataType: "SELECT", options: ["A", "B", "C"] },
      { entityType: "SALES_ORDER", fieldKey: "delivery_terms", label: "Условия поставки", dataType: "TEXT" },
      { entityType: "SALES_ORDER", fieldKey: "client_po_number", label: "Номер заказа клиента", dataType: "TEXT" }
    ],
    ownerQuestions: [
      "Кто должен нам деньги и когда?",
      "Какие заказы под риском из-за остатка или закупки?",
      "Какие клиенты дают прибыль, а не только оборот?"
    ],
    primaryWorkspaces: ["crm", "sales", "procurement", "inventory", "finance"],
    operatingFlows: [
      "Клиент → коммерческие условия → договорная цена → заказ",
      "Лид → КП → заказ клиента → резерв → отгрузка",
      "Подтверждение заказа → кредитный лимит → дебиторка → оплата",
      "Дефицит → закупка → приход → обеспечение заказа"
    ],
    attentionSignals: [
      "Заказ не обеспечен остатком",
      "Кредитный лимит клиента исчерпан",
      "Поставка опаздывает к заказу клиента",
      "Просроченная дебиторка"
    ]
  },
  ECOMMERCE_STORE: {
    code: "ECOMMERCE_STORE",
    title: "Интернет-магазин",
    summary: "Каталог, сайт, корзина, заказы, OMS, склад, маркетинг и прибыль.",
    profileCode: "ECOMMERCE",
    version: 3,
    enabledCapabilities: [
      "crm","tasks","catalog","sales","procurement","inventory","finance","accounting",
      "channels","oms","sites","growth","workflow","support"
    ],
    customFields: [
      { entityType: "PRODUCT", fieldKey: "seo_group", label: "SEO-группа", dataType: "TEXT" },
      { entityType: "SALES_ORDER", fieldKey: "delivery_comment", label: "Комментарий к доставке", dataType: "TEXT" }
    ],
    ownerQuestions: [
      "Сколько потрачено на рекламу и сколько валовой прибыли она принесла?",
      "Какие заказы зависли между оплатой и отгрузкой?",
      "Где риск out-of-stock?"
    ],
    primaryWorkspaces: ["sites", "growth", "oms", "inventory", "finance"],
    operatingFlows: [
      "Сессия → корзина → checkout → заказ → оплата → отгрузка",
      "Заказ → ATP/резерв → склад → доставка",
      "Реклама → заказ → валовая прибыль → ROMI"
    ],
    attentionSignals: [
      "Checkout без созданного заказа",
      "Оплаченный заказ без отгрузки",
      "Рекламный канал с отрицательной прибыльностью"
    ]
  },
  MARKETPLACE_SELLER: {
    code: "MARKETPLACE_SELLER",
    title: "Продавец на маркетплейсах",
    summary: "Ozon/WB, единые SKU, заказы, остатки, закупки и прибыль по каналам.",
    profileCode: "ECOMMERCE",
    version: 3,
    enabledCapabilities: [
      "crm","tasks","catalog","sales","procurement","inventory","finance","accounting",
      "channels","oms","growth","workflow","support"
    ],
    customFields: [
      { entityType: "PRODUCT", fieldKey: "marketplace_category", label: "Категория маркетплейса", dataType: "TEXT" },
      { entityType: "PRODUCT", fieldKey: "supplier_article", label: "Артикул поставщика", dataType: "TEXT" }
    ],
    ownerQuestions: [
      "Какой канал и SKU реально приносит прибыль?",
      "Какие карточки не сопоставлены с внутренними SKU?",
      "Что нужно закупить до дефицита?"
    ],
    primaryWorkspaces: ["channels", "oms", "inventory", "procurement", "finance"],
    operatingFlows: [
      "Маркетплейс → inbox → SKU mapping → OMS → заказ",
      "Остаток → ATP → канал → резерв",
      "Продажи канала → комиссии/затраты → прибыльность"
    ],
    attentionSignals: [
      "Не сопоставлен SKU",
      "Канал DEGRADED или отстаёт синхронизация",
      "Дефицит по продаваемому SKU"
    ]
  },
  WAREHOUSE_3PL: {
    code: "WAREHOUSE_3PL",
    title: "Склад / 3PL оператор",
    summary: "Приёмка, адресное хранение, задания, владельцы товара, SLA и биллинг.",
    profileCode: "WAREHOUSE_3PL",
    version: 3,
    enabledCapabilities: [
      "tasks","catalog","sales","procurement","inventory","finance","accounting",
      "oms","wms","workflow","support"
    ],
    customFields: [
      { entityType: "PARTY", fieldKey: "sla_class", label: "Класс SLA", dataType: "SELECT", options: ["STANDARD", "PRIORITY", "CUSTOM"] }
    ],
    ownerQuestions: [
      "Где узкое место склада прямо сейчас?",
      "Какие SLA под риском?",
      "Сколько заработано на каждом клиенте 3PL?"
    ],
    primaryWorkspaces: ["wms", "inventory", "finance", "support"],
    operatingFlows: [
      "ASN → док → приёмка → размещение",
      "Заказ → волна → отбор → упаковка → отгрузка",
      "Операции клиента → тарификация → биллинг"
    ],
    attentionSignals: [
      "SLA под риском",
      "Задание FAILED или просрочено",
      "Расхождение location/owner/aggregate balance"
    ]
  }
};

export const BUSINESS_VERTICAL_LIST = Object.values(BUSINESS_VERTICALS);
