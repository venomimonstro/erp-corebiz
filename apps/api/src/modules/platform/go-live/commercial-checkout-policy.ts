/**
 * Commercial checkout is a separate acceptance gate from generic tenant
 * activation. Configuration flags and source presence are NOT provider E2E
 * evidence. This policy deliberately fails closed for incomplete commerce.
 */
export type CommercialCheck = {
  code:string;title:string;ok:boolean;blocking:boolean;detail:string;href:string
};
type Evidence = (component:string,kind:string)=>boolean;
export type CommerceReadinessFacts={
  verticalCode:string|null;
  storefrontPublished:boolean;
  merchantConfigured:boolean;
  fiscalConfigured:boolean;
  deliveryMethodConfigured:boolean;
  activeRetailLocations:number;
  /** Verified test evidence, not a boolean setting or a success toast. */
  evidence:Evidence;
};
export function commercialCheckoutChecks(f:CommerceReadinessFacts):CommercialCheck[]{
  const checks:CommercialCheck[]=[];
  const append=(code:string,title:string,ok:boolean,detail:string,href:string)=>{
    checks.push({code,title,ok,blocking:true,detail,href});
  };
  const web=["ECOMMERCE_STORE","OMNICHANNEL_RETAIL"].includes(f.verticalCode??"");
  const shop=["RETAIL_STORE","OMNICHANNEL_RETAIL"].includes(f.verticalCode??"");
  const marketplace=f.verticalCode==="MARKETPLACE_SELLER";

  if(web){
    append("WEB_SHOP_PUBLISHED","Публичная витрина",f.storefrontPublished,
      "Нужна опубликованная активная витрина, доступная покупателю.","/app/sites");
    append("WEB_ACQUIRING_CONFIG","Эквайринг своего магазина",
      f.merchantConfigured&&f.fiscalConfigured,
      "Реквизиты продавца, провайдер платежей и фискализация должны быть настроены. Галочки не доказывают выполнение чека.","/app/sites/payments");
    append("WEB_DELIVERY_CONFIG","Способ выдачи и доставки",f.deliveryMethodConfigured,
      "Покупателю нужен хотя бы один действительный способ получения заказа, подтверждённый сервером.","/app/sites/payments");
    append("WEB_PAYMENT_E2E","Реальная сверка онлайн-оплаты",
      f.evidence("COMMERCE","PAYMENT_E2E"),
      "Нужен свежий тест: банк подтвердил платёж, ledger отражает деньги один раз, webhook повторён без двойного списания.","/app/settings/release");
    append("WEB_FISCAL_E2E","Фискальный чек онлайн-покупателя",
      f.evidence("COMMERCE","FISCAL_E2E"),
      "Нужен подтверждённый чек ККТ с реквизитами ФН/ФД/ФП, включая сценарии предоплаты и зачёта при выдаче.","/app/settings/release");
    append("WEB_FULFILLMENT_E2E","Выдача и возврат заказа",
      f.evidence("COMMERCE","FULFILLMENT_E2E"),
      "Нужна сквозная проверка резерв → отгрузка/самовывоз → возврат → деньги/склад, без ошибочного автоматического списания.","/app/settings/release");
  }
  if(shop){
    append("POS_LOCATION","Реальная торговая точка",f.activeRetailLocations>0,
      "Добавьте физическую точку со своим складом и настройте права кассиров.","/app/retail");
    append("POS_BANK_E2E","Эквайринг на терминале",
      f.evidence("RETAIL","TERMINAL_E2E"),
      "Необходимо тестировать реальный SDK/протокол банка: оплата, отмена, возврат, TID/MID и сверка с Finance.","/app/settings/integrations");
    append("POS_FISCAL_E2E","ККТ и кассовые смены",
      f.evidence("RETAIL","FISCAL_E2E"),
      "Подтвердите приход, возврат, закрытие смены и сверку ФН/ОФД; внутренняя смена CoreBiz не является чеком.","/app/settings/integrations");
  }
  if(f.verticalCode==="OMNICHANNEL_RETAIL"){
    append("OMNI_WAREHOUSE_PICKUP","Самовывоз онлайн из конкретного филиала",
      f.evidence("RETAIL","WAREHOUSE_LOCKED_PICKUP_E2E"),
      "OMS пока не гарантирует выбор конкретного склада из онлайн-корзины. Нужен тест выбранной точки и последнего SKU.","/app/retail");
    append("ELECTRONICS_MARKING_REVIEW","Маркировка отдельных товаров электроники",
      f.evidence("MARKING","ELECTRONICS_APPLICABILITY"),
      "Проверьте товарные группы по Постановлению №1954, сроки, GTIN/Data Matrix и ЭДО. IMEI не заменяет код маркировки.","/app/settings/integrations");
  }
  if(marketplace){
    append("MARKETPLACE_ORDER_E2E","Настоящий заказ из маркетплейса",
      f.evidence("CHANNELS","ORDER_IMPORT_E2E"),
      "Протестируйте импорт Ozon/WB и повтор статуса, возвраты, комиссию и корректный остаток без ложной успешной синхронизации.","/app/channels");
  }
  return checks;
}
