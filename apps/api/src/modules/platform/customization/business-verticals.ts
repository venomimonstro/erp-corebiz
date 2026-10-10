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
  "service",
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
  | "AUTO_SERVICE"
  | "DANCE_FITNESS"
  | "PROFESSIONAL_SERVICES"
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
    version: 2,
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
    title: "Салон красоты / барбершоп",
    summary: "Онлайн-запись, мастера, услуги, материалы, повторные визиты и деньги.",
    profileCode: "SERVICE",
    version: 2,
    enabledCapabilities: [
      "crm","tasks","catalog","sales","procurement","inventory","finance",
      "service","sites","growth","workflow","support"
    ],
    customFields: [
      { entityType: "PARTY", fieldKey: "birthday", label: "Дата рождения", dataType: "DATE" },
      { entityType: "PARTY", fieldKey: "preferences", label: "Предпочтения клиента", dataType: "TEXT" },
      { entityType: "PARTY", fieldKey: "contraindications", label: "Важные ограничения", dataType: "TEXT" }
    ],
    ownerQuestions: [
      "Какая загрузка мастеров сегодня и на неделю?",
      "Какие услуги и мастера дают больше валовой прибыли?",
      "Кто из клиентов давно не возвращался?"
    ],
    primaryWorkspaces: ["service", "crm", "finance", "growth"],
    operatingFlows: [
      "Клиент → запись → визит → услуга → оплата",
      "Расход материалов → себестоимость услуги",
      "Повторный визит → удержание клиента"
    ],
    attentionSignals: [
      "Свободные окна при высоком спросе",
      "No-show и отмены",
      "Клиенты без повторного визита"
    ]
  },
  AUTO_SERVICE: {
    code: "AUTO_SERVICE",
    title: "Автосервис",
    summary: "CRM, карточки автомобилей, история обслуживания, работы, запчасти, склад и прибыль.",
    profileCode: "SERVICE",
    version: 3,
    enabledCapabilities: [
      "crm","tasks","catalog","sales","procurement","inventory","finance",
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
  DANCE_FITNESS: {
    code: "DANCE_FITNESS",
    title: "Студия танцев / фитнес",
    summary: "Расписание, тренеры, залы, абонементы, посещения и финансовая загрузка.",
    profileCode: "SERVICE",
    version: 3,
    enabledCapabilities: [
      "crm","tasks","sales","finance","service","sites","growth","workflow","support"
    ],
    customFields: [
      { entityType: "PARTY", fieldKey: "training_level", label: "Уровень подготовки", dataType: "SELECT", options: ["Новичок", "Средний", "Продвинутый"] },
      { entityType: "PARTY", fieldKey: "training_notes", label: "Примечания по занятиям", dataType: "TEXT" }
    ],
    ownerQuestions: [
      "Какие группы и тренеры реально загружены?",
      "Какова выручка на час зала?",
      "Кто перестал посещать занятия?"
    ],
    primaryWorkspaces: ["service", "crm", "finance", "growth"],
    operatingFlows: [
      "Лид → пробное занятие → клиент → абонемент",
      "Абонемент → резерв посещения → занятие/no-show → списание или возврат",
      "Расписание → зал/тренер → запись → посещение",
      "Загрузка ресурсов → выручка на час"
    ],
    attentionSignals: [
      "Группа с низкой загрузкой",
      "Абонемент заканчивается или исчерпан",
      "Клиент перестал посещать",
      "Конфликт расписания тренера или зала"
    ]
  },
  PROFESSIONAL_SERVICES: {
    code: "PROFESSIONAL_SERVICES",
    title: "Профессиональные услуги / IT / агентство",
    summary: "Лиды, сделки, задачи, проекты, встречи, счета и дебиторка.",
    profileCode: "SERVICE",
    version: 2,
    enabledCapabilities: [
      "crm","tasks","sales","finance","service","sites","growth","workflow","support"
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
    primaryWorkspaces: ["crm", "tasks", "finance"],
    operatingFlows: [
      "Лид → оценка → сделка → договорённость → выполнение → оплата",
      "Сделка → задачи → контроль срока → сдача",
      "Счёт → дебиторка → поступление денег"
    ],
    attentionSignals: [
      "Сделка или проект без следующей задачи",
      "Просроченный клиентский срок",
      "Просроченная дебиторка"
    ]
  },
  RETAIL_STORE: {
    code: "RETAIL_STORE",
    title: "Розничная торговля",
    summary: "Товары, цены, остатки, закупки, продажи и деньги по точкам.",
    profileCode: "TRADE",
    version: 2,
    enabledCapabilities: [
      "crm","tasks","catalog","sales","procurement","inventory","finance",
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
    version: 3,
    enabledCapabilities: [
      "crm","tasks","catalog","sales","procurement","inventory","finance",
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
    version: 2,
    enabledCapabilities: [
      "crm","tasks","catalog","sales","procurement","inventory","finance",
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
    version: 2,
    enabledCapabilities: [
      "crm","tasks","catalog","sales","procurement","inventory","finance",
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
    version: 2,
    enabledCapabilities: [
      "tasks","catalog","sales","procurement","inventory","finance",
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
