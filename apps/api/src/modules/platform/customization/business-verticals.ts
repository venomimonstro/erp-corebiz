export type BusinessProfileCode =
  | "GENERAL"
  | "TRADE"
  | "ECOMMERCE"
  | "SERVICE"
  | "WAREHOUSE_3PL";

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
  customFields: VerticalField[];
  ownerQuestions: string[];
  primaryWorkspaces: string[];
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
    version: 1,
    customFields: [],
    ownerQuestions: [
      "Сколько денег доступно сейчас?",
      "Что требует моего внимания?",
      "Где компания теряет деньги?"
    ],
    primaryWorkspaces: ["owner", "crm", "finance"]
  },
  BEAUTY_SALON: {
    code: "BEAUTY_SALON",
    title: "Салон красоты / барбершоп",
    summary: "Онлайн-запись, мастера, услуги, материалы, повторные визиты и деньги.",
    profileCode: "SERVICE",
    version: 1,
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
    primaryWorkspaces: ["service", "crm", "finance", "growth"]
  },
  AUTO_SERVICE: {
    code: "AUTO_SERVICE",
    title: "Автосервис",
    summary: "CRM, запись, автомобиль в заказе, работы, запчасти, склад и прибыль.",
    profileCode: "SERVICE",
    version: 1,
    customFields: [
      { entityType: "DEAL", fieldKey: "vehicle_plate", label: "Госномер", dataType: "TEXT" },
      { entityType: "DEAL", fieldKey: "vehicle_vin", label: "VIN", dataType: "TEXT" },
      { entityType: "DEAL", fieldKey: "vehicle_model", label: "Автомобиль", dataType: "TEXT" },
      { entityType: "DEAL", fieldKey: "vehicle_mileage", label: "Пробег", dataType: "NUMBER" }
    ],
    ownerQuestions: [
      "Какие посты и механики загружены?",
      "Сколько заработано на работах и сколько на запчастях?",
      "Какие заказ-наряды зависли и почему?"
    ],
    primaryWorkspaces: ["service", "crm", "inventory", "procurement", "finance"]
  },
  DANCE_FITNESS: {
    code: "DANCE_FITNESS",
    title: "Студия танцев / фитнес",
    summary: "Расписание, тренеры, залы, клиенты и финансовая загрузка.",
    profileCode: "SERVICE",
    version: 1,
    customFields: [
      { entityType: "PARTY", fieldKey: "training_level", label: "Уровень подготовки", dataType: "SELECT", options: ["Новичок", "Средний", "Продвинутый"] },
      { entityType: "PARTY", fieldKey: "training_notes", label: "Примечания по занятиям", dataType: "TEXT" }
    ],
    ownerQuestions: [
      "Какие группы и тренеры реально загружены?",
      "Какова выручка на час зала?",
      "Кто перестал посещать занятия?"
    ],
    primaryWorkspaces: ["service", "crm", "finance", "growth"]
  },
  PROFESSIONAL_SERVICES: {
    code: "PROFESSIONAL_SERVICES",
    title: "Профессиональные услуги",
    summary: "Лиды, сделки, задачи, проекты, встречи, счета и дебиторка.",
    profileCode: "SERVICE",
    version: 1,
    customFields: [
      { entityType: "DEAL", fieldKey: "project_type", label: "Тип проекта", dataType: "TEXT" },
      { entityType: "DEAL", fieldKey: "client_deadline", label: "Срок клиента", dataType: "DATE" }
    ],
    ownerQuestions: [
      "Какие сделки и проекты принесут деньги в ближайшие 30 дней?",
      "Какая дебиторка просрочена?",
      "У кого из сотрудников перегруз?"
    ],
    primaryWorkspaces: ["crm", "tasks", "service", "finance"]
  },
  RETAIL_STORE: {
    code: "RETAIL_STORE",
    title: "Розничная торговля",
    summary: "Товары, цены, остатки, закупки, продажи и деньги по точкам.",
    profileCode: "TRADE",
    version: 1,
    customFields: [
      { entityType: "PRODUCT", fieldKey: "brand", label: "Бренд", dataType: "TEXT" },
      { entityType: "PRODUCT", fieldKey: "season", label: "Сезон", dataType: "TEXT" }
    ],
    ownerQuestions: [
      "Что продаётся и что зависло?",
      "Где заканчивается товар?",
      "Какая валовая прибыль по магазину и категории?"
    ],
    primaryWorkspaces: ["sales", "inventory", "procurement", "finance"]
  },
  WHOLESALE_B2B: {
    code: "WHOLESALE_B2B",
    title: "Оптовая B2B торговля",
    summary: "CRM, коммерческие предложения, заказы, закупки, склад и дебиторка.",
    profileCode: "TRADE",
    version: 1,
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
    primaryWorkspaces: ["crm", "sales", "procurement", "inventory", "finance"]
  },
  ECOMMERCE_STORE: {
    code: "ECOMMERCE_STORE",
    title: "Интернет-магазин",
    summary: "Каталог, сайт, корзина, заказы, OMS, склад, маркетинг и прибыль.",
    profileCode: "ECOMMERCE",
    version: 1,
    customFields: [
      { entityType: "PRODUCT", fieldKey: "seo_group", label: "SEO-группа", dataType: "TEXT" },
      { entityType: "SALES_ORDER", fieldKey: "delivery_comment", label: "Комментарий к доставке", dataType: "TEXT" }
    ],
    ownerQuestions: [
      "Сколько потрачено на рекламу и сколько валовой прибыли она принесла?",
      "Какие заказы зависли между оплатой и отгрузкой?",
      "Где риск out-of-stock?"
    ],
    primaryWorkspaces: ["sites", "growth", "oms", "inventory", "finance"]
  },
  MARKETPLACE_SELLER: {
    code: "MARKETPLACE_SELLER",
    title: "Продавец на маркетплейсах",
    summary: "Ozon/WB, единые SKU, заказы, остатки, закупки и прибыль по каналам.",
    profileCode: "ECOMMERCE",
    version: 1,
    customFields: [
      { entityType: "PRODUCT", fieldKey: "marketplace_category", label: "Категория маркетплейса", dataType: "TEXT" },
      { entityType: "PRODUCT", fieldKey: "supplier_article", label: "Артикул поставщика", dataType: "TEXT" }
    ],
    ownerQuestions: [
      "Какой канал и SKU реально приносит прибыль?",
      "Какие карточки не сопоставлены с внутренними SKU?",
      "Что нужно закупить до дефицита?"
    ],
    primaryWorkspaces: ["channels", "oms", "inventory", "procurement", "finance"]
  },
  WAREHOUSE_3PL: {
    code: "WAREHOUSE_3PL",
    title: "Склад / 3PL оператор",
    summary: "Приёмка, адресное хранение, задания, владельцы товара, SLA и биллинг.",
    profileCode: "WAREHOUSE_3PL",
    version: 1,
    customFields: [
      { entityType: "PARTY", fieldKey: "sla_class", label: "Класс SLA", dataType: "SELECT", options: ["STANDARD", "PRIORITY", "CUSTOM"] }
    ],
    ownerQuestions: [
      "Где узкое место склада прямо сейчас?",
      "Какие SLA под риском?",
      "Сколько заработано на каждом клиенте 3PL?"
    ],
    primaryWorkspaces: ["wms", "inventory", "finance", "support"]
  }
};

export const BUSINESS_VERTICAL_LIST = Object.values(BUSINESS_VERTICALS);
