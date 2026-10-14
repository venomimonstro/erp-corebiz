/**
 * Action guide shared by tenant businesses. Presentation/permission hints
 * only: actual writes are checked again by API + tenant scoped RLS.
 *
 * Never label historical ledger entities "delete"; use archive/cancel/
 * compensate through their owner domain service.
 */
export type BusinessAction={
  label:string;
  href:string;
  permission:string;
  caution?:string;
};
export type BusinessStage={
  id:string;
  title:string;
  origin:"shared"|"dance";
  why:string;
  systemOfRecord:string;
  configure:BusinessAction;
  change?:BusinessAction;
  retire?:BusinessAction;
  recover?:BusinessAction;
  invariant:string;
};
export const danceBusinessStages:BusinessStage[]=[
  {
    id:"organization",title:"Компания и два филиала",origin:"shared",
    why:"Реквизиты, часовой пояс Москвы, юридические лица и точки.",
    systemOfRecord:"Организация → филиал → юридическое лицо",
    configure:{label:"Создать филиал",href:"/app/settings",permission:"platform.settings.manage"},
    change:{label:"Изменить филиал",href:"/app/settings",permission:"platform.settings.manage"},
    invariant:"Платёж и договор должны относиться к правильному юрлицу и филиалу"
  },
  {
    id:"services",title:"Категории, услуги и цены",origin:"shared",
    why:"Группа, индивидуальная тренировка, самостоятельная практика, аренда.",
    systemOfRecord:"Единый service_catalog_item для всех ниш",
    configure:{label:"Создать услугу",href:"/app/dance/setup",permission:"catalog.write"},
    change:{label:"Изменить прайс",href:"/app/dance/services",permission:"catalog.write"},
    retire:{label:"Архивировать",href:"/app/dance/services",permission:"users.manage"},
    recover:{label:"Восстановить",href:"/app/dance/services",permission:"users.manage"},
    invariant:"Изменения цены не пересчитывают уже проданные визиты и абонементы"
  },
  {
    id:"staff",title:"52 тренера и два менеджера",origin:"shared",
    why:"Сотрудник-ресурс, системный логин, филиал, навыки и увольнение.",
    systemOfRecord:"service_resource + membership + role_permission",
    configure:{label:"Добавить тренера",href:"/app/dance/staff",permission:"users.manage"},
    change:{label:"Назначить услуги и график",href:"/app/dance/staff",permission:"users.manage"},
    retire:{label:"Архивировать сотрудника",href:"/app/dance/staff",permission:"users.manage"},
    recover:{label:"Восстановить ресурс",href:"/app/dance/staff",permission:"users.manage"},
    invariant:"Нельзя уволить сотрудника с будущими занятиями или оставить ему действующие права без проверки"
  },
  {
    id:"rooms",title:"Залы, вместимость и аренда",origin:"shared",
    why:"Большой зал для групп; два малых — для арендаторов. Расход аренды отделён от выручки.",
    systemOfRecord:"service_resource + расписание + договор и финансовый учёт",
    configure:{label:"Создать зал",href:"/app/dance/team",permission:"users.manage"},
    change:{label:"Изменить ресурсы",href:"/app/service/resources",permission:"users.manage"},
    retire:{label:"Освободить/архивировать",href:"/app/dance/staff",permission:"users.manage",
      caution:"Сначала закончите договоры и перенесите будущие события"},
    invariant:"Аренда собственных помещений — расход, сдача часа арендатору — отдельный доход"
  },
  {
    id:"directions",title:"12 направлений, группы и тренеры",origin:"dance",
    why:"Направление, возраст/уровень, вместимость и преподаватель.",
    systemOfRecord:"dance_program + dance_group",
    configure:{label:"Создать направление/группу",href:"/app/dance/groups",permission:"dance.write"},
    change:{label:"Изменить расписание и тренера",href:"/app/dance/groups",permission:"dance.write"},
    invariant:"Изменение группы не отменяет и не переносит созданные уроки автоматически"
  },
  {
    id:"calendar",title:"Записи и посещаемость",origin:"dance",
    why:"Бронирование времени, проверка вместимости, списание занятия.",
    systemOfRecord:"service_booking + dance_lesson + dance_lesson_participant",
    configure:{label:"Создать событие",href:"/app/dance/groups",permission:"dance.write"},
    change:{label:"Изменить будущий урок",href:"/app/dance/groups",permission:"dance.write"},
    retire:{label:"Отменить урок с причиной",href:"/app/dance/groups",permission:"dance.write"},
    invariant:"Завершение занятия и отметка оплаты — разные события"
  },
  {
    id:"clients",title:"Ученики, родители и плательщики",origin:"shared",
    why:"Семья, контакты, согласия, отношения ребёнок-плательщик.",
    systemOfRecord:"Party/CRM + party_relationship + dance_student",
    configure:{label:"Добавить клиента",href:"/app/dance/students",permission:"crm.write"},
    change:{label:"Изменить семью/группу",href:"/app/dance/students",permission:"dance.write"},
    invariant:"История семьи не исчезает после отчисления; чужие дети не видны в кабинете"
  },
  {
    id:"packages",title:"Абонементы и индивидуальные занятия",origin:"shared",
    why:"10 групповых — 7 000 ₽; разовое 2 400 ₽; индивидуальное 3 500 ₽.",
    systemOfRecord:"service_package_plan + service_package + финансовое обязательство",
    configure:{label:"Создать тариф абонемента",href:"/app/service/packages",permission:"service.write"},
    change:{label:"Продать/заморозить/проверить",href:"/app/dance/students",permission:"dance.write"},
    invariant:"Деньги, долг, доступные посещения и выручка по факту оказания услуги не взаимозаменяемы"
  },
  {
    id:"finance",title:"Расходы, налоги, зарплаты и сезонность",origin:"shared",
    why:"3 млн ₽ выручки — не чистая прибыль; известные 800 тыс. ₽ — только часть расходов.",
    systemOfRecord:"Финансовые обязательства и проводки + плановые сценарии",
    configure:{label:"Составить бюджет",href:"/app/dance/budget",permission:"finance.read"},
    change:{label:"Сверить выплаты и начисления",href:"/app/finance",permission:"finance.read"},
    invariant:"Операции не удаляются из журнала задним числом — используются корректировки с аудитом"
  },
  {
    id:"portal",title:"Кабинет ученика, родителя и тренера",origin:"dance",
    why:"Даты, посещения, тренеры, свои абонементы, подтверждённая задолженность.",
    systemOfRecord:"Membership + привязка Party/CRM + строгий контур portal",
    configure:{label:"Пригласить клиента",href:"/app/dance/clients",permission:"users.manage"},
    change:{label:"Связать логин с клиентом",href:"/app/dance/clients",permission:"users.manage"},
    retire:{label:"Отозвать доступ",href:"/app/dance/clients",permission:"users.manage"},
    invariant:"Клиент не получает права персонала, а тренер не видит бухгалтерию компании"
  },
  {
    id:"go-live",title:"Реальный запуск и восстановление",origin:"shared",
    why:"Права, двойная запись, оплата, касса, архивирование, ошибки внешнего API.",
    systemOfRecord:"Readiness и журнал событий, не флаги в браузере",
    configure:{label:"Проверить бизнес",href:"/app/dance/diagnostics",permission:"dance.read"},
    change:{label:"Посмотреть блокеры запуска",href:"/app/settings/go-live",permission:"go_live.manage"},
    invariant:"Запуск не считается подтверждённым при неизвестном платеже или недоступной проверке"
  }
];
