export type AgencyTemplateStep = {
  code:string;
  title:string;
  deliverableType:"DESIGN"|"DEVELOPMENT"|"SEO"|"CONTENT"|"ADVERTISING"|"ANALYTICS"|"STRATEGY"|"REPORT"|"OTHER";
  offsetDays:number;
  checklist:string;
};
export type AgencyDeliveryTemplate={
  code:string;title:string;description:string;steps:AgencyTemplateStep[];
};

export const AGENCY_DELIVERY_TEMPLATES:AgencyDeliveryTemplate[]=[
  {
    code:"WEB_BUILD",title:"Разработка сайта",
    description:"От брифа и ТЗ до QA, запуска и передачи клиенту.",
    steps:[
      {code:"BRIEF",title:"Бриф, цели и техническое задание",deliverableType:"STRATEGY",offsetDays:3,checklist:"Уточнить ЦА, цели, интеграции, объём работ и критерии приёмки; согласовать ТЗ."},
      {code:"UX",title:"Прототип и пользовательские сценарии",deliverableType:"DESIGN",offsetDays:7,checklist:"Проверить карту страниц, сценарии, формы, адаптивные экраны."},
      {code:"DESIGN",title:"Дизайн и согласование макетов",deliverableType:"DESIGN",offsetDays:14,checklist:"Подготовить макеты и состояния, получить документированное согласование."},
      {code:"BUILD",title:"Разработка и интеграции",deliverableType:"DEVELOPMENT",offsetDays:25,checklist:"Реализовать страницы, авторизацию, CRM/формы, платежи и необходимые интеграции."},
      {code:"QA",title:"Тестирование и приёмка",deliverableType:"OTHER",offsetDays:32,checklist:"Провести функциональные, мобильные, безопасностные и регрессионные проверки."},
      {code:"GO_LIVE",title:"Публикация, аналитика и передача",deliverableType:"REPORT",offsetDays:35,checklist:"Проверить домен, HTTPS, бэкапы, метрики, инструкции и акт сдачи."}
    ]
  },
  {
    code:"SEO",title:"SEO-продвижение",
    description:"Аудит, семантика, оптимизация, контент и результаты.",
    steps:[
      {code:"AUDIT",title:"SEO-аудит и план работ",deliverableType:"ANALYTICS",offsetDays:5,checklist:"Проверить индексацию, robots, sitemap, скорость, шаблоны, ошибки и конкурентов."},
      {code:"SEMANTICS",title:"Семантика и карта посадочных страниц",deliverableType:"STRATEGY",offsetDays:10,checklist:"Собрать запросы, кластеры, интент, распределение страниц и приоритеты."},
      {code:"TECH",title:"Техническая оптимизация",deliverableType:"SEO",offsetDays:17,checklist:"Внедрить метатеги, структуру, микроразметку, перелинковку и исправления индексации."},
      {code:"CONTENT",title:"Контент-план и публикации",deliverableType:"CONTENT",offsetDays:24,checklist:"Подготовить ТЗ и контент по кластерам; провести редактуру и QA."},
      {code:"REPORT",title:"Отчёт по позициям, трафику и лидам",deliverableType:"REPORT",offsetDays:30,checklist:"Сопоставить цели, органический трафик, конверсии, лиды и задачи следующего месяца."}
    ]
  },
  {
    code:"PPC",title:"Контекстная реклама",
    description:"Аналитика, медиаплан, запуск и оптимизация кампаний.",
    steps:[
      {code:"TRACK",title:"Цели и сквозная аналитика",deliverableType:"ANALYTICS",offsetDays:3,checklist:"Настроить цели, UTM, пиксели, передачу обращений и оплат в CRM."},
      {code:"PLAN",title:"Медиаплан и KPI",deliverableType:"STRATEGY",offsetDays:5,checklist:"Согласовать каналы, лимиты, CPL, CAC, точки окупаемости и ответственность за медиабюджет."},
      {code:"CREATIVE",title:"Семантика, креативы и посадочные",deliverableType:"ADVERTISING",offsetDays:9,checklist:"Проверить тексты, фиды, ставки, релевантность страниц и согласования."},
      {code:"LAUNCH",title:"Запуск и контроль конверсий",deliverableType:"ADVERTISING",offsetDays:12,checklist:"Проверить модерацию, лимиты, UTM, цели, реальные тестовые лиды."},
      {code:"OPTIMIZE",title:"Оптимизация и отчёт",deliverableType:"REPORT",offsetDays:30,checklist:"Сверить фактический расход и выручку, CPL, CAC, ROAS и гипотезы оптимизации."}
    ]
  },
  {
    code:"SMM",title:"SMM и контент",
    description:"Стратегия, контент-план, производство, публикации и аналитика.",
    steps:[
      {code:"RESEARCH",title:"Аудит каналов и целевой аудитории",deliverableType:"STRATEGY",offsetDays:4,checklist:"Сегменты, конкуренты, тональность, рубрики, конверсионные сценарии."},
      {code:"PLAN",title:"Контент-план и согласование",deliverableType:"CONTENT",offsetDays:8,checklist:"Утвердить темы, форматы, частоту публикаций и роли."},
      {code:"CREATE",title:"Производство материалов",deliverableType:"CONTENT",offsetDays:15,checklist:"Тексты, визуалы, короткие видео, ссылки и проверки качества."},
      {code:"POST",title:"Публикации и ответы аудитории",deliverableType:"CONTENT",offsetDays:24,checklist:"Опубликовать контент по графику, обработать обращения и передать лиды в CRM."},
      {code:"REPORT",title:"Аналитика и месячный отчёт",deliverableType:"REPORT",offsetDays:30,checklist:"Проверить обращения, охваты, переходы, конверсию и планы следующего периода."}
    ]
  },
  {
    code:"MARKETING",title:"Комплексное маркетинговое обслуживание",
    description:"Стратегия, производство, performance и управленческий отчёт.",
    steps:[
      {code:"START",title:"Онбординг, доступы и цели",deliverableType:"STRATEGY",offsetDays:3,checklist:"Зафиксировать договор, ЛПР, доступы, KPI, бюджеты и точки ответственности."},
      {code:"AUDIT",title:"Аудит и медиастратегия",deliverableType:"ANALYTICS",offsetDays:7,checklist:"Рынок, SEO, аналитика, реклама, CRM и экономика каналов."},
      {code:"CONTENT",title:"Контент, SEO и коммуникации",deliverableType:"CONTENT",offsetDays:16,checklist:"Опубликовать согласованные материалы и технические доработки."},
      {code:"PERFORMANCE",title:"Кампании и оптимизация воронки",deliverableType:"ADVERTISING",offsetDays:23,checklist:"Проверить бюджет, качество лидов, CPL, CAC и конверсию в продажу."},
      {code:"CLOSE",title:"Результаты, согласование и следующий месяц",deliverableType:"REPORT",offsetDays:30,checklist:"Свести расходы, лиды, оплаченные сделки, маржу и план действий."}
    ]
  }
];
