import {BadGatewayException,ServiceUnavailableException} from "@nestjs/common";

export type ProviderEnvironment="SANDBOX"|"PRODUCTION";
export type CdekCredentials={clientId:string;clientSecret:string};
export type AtolCredentials={login:string;password:string;groupCode:string};

function safeUrl(provider:"CDEK"|"ATOL_ONLINE",env:ProviderEnvironment){
  if(provider==="CDEK")return env==="SANDBOX"
    ?"https://api.edu.cdek.ru":"https://api.cdek.ru";
  return env==="SANDBOX"
    ?"https://testonline.atol.ru":"https://online.atol.ru";
}
async function providerRequest<T>(
  url:string,method:"POST"|"GET",
  headers:Record<string,string>,body?:string
):Promise<T>{
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),10000);
  try{
    const response=await fetch(url,{method,headers,
      ...(body?{body}:{}),signal:controller.signal,redirect:"error"});
    if(!response.ok)throw new BadGatewayException(
      "Провайдер отклонил запрос. Проверьте договор, ключи и разрешения"
    );
    const size=Number(response.headers.get("content-length")??0);
    if(size>256000)throw new BadGatewayException("Ответ провайдера слишком большой");
    const payload=await response.text();
    if(payload.length>256000)throw new BadGatewayException("Ответ провайдера слишком большой");
    try{return JSON.parse(payload) as T;}
    catch{throw new BadGatewayException("Провайдер вернул некорректный JSON");}
  }catch(e){
    if(e instanceof BadGatewayException)throw e;
    throw new ServiceUnavailableException("Сервис провайдера временно недоступен");
  }finally{clearTimeout(timeout);}
}

export class CdekGateway{
  async token(cred:CdekCredentials,env:ProviderEnvironment):Promise<string>{
    if(!cred.clientId||!cred.clientSecret ||
       cred.clientId.length>256||cred.clientSecret.length>256)
      throw new ServiceUnavailableException("Реквизиты СДЭК не настроены");
    const form=new URLSearchParams({
      grant_type:"client_credentials",
      client_id:cred.clientId,
      client_secret:cred.clientSecret
    });
    const result=await providerRequest<{
      access_token?:string;token_type?:string;expires_in?:number
    }>(safeUrl("CDEK",env)+"/v2/oauth/token","POST",{
      "Content-Type":"application/x-www-form-urlencoded"
    },form.toString());
    if(!result.access_token||result.access_token.length>4096)
      throw new BadGatewayException("СДЭК не выдал действительный access token");
    return result.access_token;
  }

  async createOrder(
    cred:CdekCredentials,env:ProviderEnvironment,
    input:{
      orderNumber:string;tariffCode:number;
      fromCityCode:number;toCityCode:number;
      recipientName:string;recipientPhone:string;deliveryAddress:string;
      weightGrams:number;lengthCm:number;widthCm:number;heightCm:number;
      items:Array<{name:string;wareKey:string;cost:string;amount:number}>;
    }
  ):Promise<{uuid:string;requestState:string}>{
    if(!Array.isArray(input.items)||input.items.length===0||
       input.items.length>126||
       !input.items.every(x=>
         typeof x.name==="string"&&x.name.length>0&&x.name.length<=255&&
         typeof x.wareKey==="string"&&x.wareKey.length>0&&x.wareKey.length<=80&&
         Number.isSafeInteger(x.amount)&&x.amount>0&&x.amount<=10000&&
         /^\d{1,10}\.\d{2}$/.test(x.cost)))
      throw new BadGatewayException("СДЭК: отсутствуют действительные позиции товаров");
    if(typeof input.deliveryAddress!=="string" ||
       input.deliveryAddress.trim().length<5 ||
       input.deliveryAddress.length>500)
      throw new BadGatewayException("СДЭК: некорректный адрес получателя");
    const token=await this.token(cred,env);
    const data=await providerRequest<{
      entity?:{uuid?:string};
      requests?:Array<{state?:string;errors?:unknown[]}>;
    }>(safeUrl("CDEK",env)+"/v2/orders","POST",{
      "Authorization":"Bearer "+token,"Content-Type":"application/json"
    },JSON.stringify({
      type:1,number:input.orderNumber,
      tariff_code:input.tariffCode,
      from_location:{code:input.fromCityCode},
      to_location:{code:input.toCityCode,address:input.deliveryAddress},
      recipient:{name:input.recipientName,
        phones:[{number:input.recipientPhone}]},
      packages:[{number:"1",weight:input.weightGrams,
        length:input.lengthCm,width:input.widthCm,height:input.heightCm,
        items:input.items.map(item=>({
          name:item.name,ware_key:item.wareKey,cost:Number(item.cost),
          amount:item.amount,payment:{value:0}
        }))}]
    }));
    const uuid=data.entity?.uuid;
    const request=data.requests?.[0]?.state;
    if(typeof uuid!=="string"||
       !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(uuid) ||
       !["ACCEPTED","SUCCESSFUL"].includes(String(request))){
      // A missing or rejected receipt is ambiguous until a provider GET
      // verifies it. Never automatically replay this POST.
      throw new BadGatewayException(
        "СДЭК не подтвердил создание: нужна ручная сверка по номеру заказа"
      );
    }
    return {uuid,requestState:String(request)};
  }

  async orderStatus(
    cred:CdekCredentials,env:ProviderEnvironment,uuid:string
  ):Promise<{uuid:string;cdekNumber:string|null;clientOrderNumber:string|null;state:string}>{
    if(!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(uuid))
      throw new BadGatewayException("Неверный UUID отправления");
    const token=await this.token(cred,env);
    const data=await providerRequest<{
      entity?:{
        uuid?:string;cdek_number?:string|number|null;number?:string|null;
        statuses?:Array<{code?:string}>;
      };
      requests?:Array<{state?:string}>;
    }>(safeUrl("CDEK",env)+"/v2/orders/"+encodeURIComponent(uuid),"GET",{
      "Authorization":"Bearer "+token
    });
    if(!data.entity || data.entity.uuid!==uuid)
      throw new BadGatewayException("СДЭК не подтвердил идентификатор накладной");
    const request=data.requests?.[0]?.state;
    const state=data.entity.statuses?.at(-1)?.code??
      (request==="INVALID"?"REJECTED":
       request==="ACCEPTED"?"ACCEPTED":"SUBMITTED");
    return {
      uuid,cdekNumber:data.entity.cdek_number==null?
        null:String(data.entity.cdek_number),
      clientOrderNumber:data.entity.number??null,state
    };
  }

  async rates(
    cred:CdekCredentials,env:ProviderEnvironment,
    input:{
      fromCityCode:number;toCityCode:number;weightGrams:number;
      lengthCm:number;widthCm:number;heightCm:number
    }
  ):Promise<Array<{
    tariffCode:number;deliverySumMinor:string;
    periodMin:number|null;periodMax:number|null
  }>>{
    const token=await this.token(cred,env);
    const result=await providerRequest<{
      tariff_codes?:Array<{
        tariff_code?:number;delivery_sum?:number;
        period_min?:number;period_max?:number
      }>;errors?:unknown[]
    }>(
      safeUrl("CDEK",env)+"/v2/calculator/tarifflist","POST",{
        "Authorization":"Bearer "+token,"Content-Type":"application/json"
      },JSON.stringify({
        type:1,currency:1,lang:"rus",
        from_location:{code:input.fromCityCode},
        to_location:{code:input.toCityCode},
        packages:[{weight:input.weightGrams,
          length:input.lengthCm,width:input.widthCm,height:input.heightCm}]
      })
    );
    if(!Array.isArray(result.tariff_codes))
      throw new BadGatewayException("СДЭК не вернул подтверждённые тарифы");
    return result.tariff_codes
      .filter(row=>Number.isInteger(row.tariff_code) &&
        (row.tariff_code??0)>0 &&
        typeof row.delivery_sum==="number" &&
        Number.isFinite(row.delivery_sum)&&row.delivery_sum>=0)
      .slice(0,30).map(row=>({
        tariffCode:row.tariff_code!,
        deliverySumMinor:String(Math.round(row.delivery_sum!*100)),
        periodMin:Number.isInteger(row.period_min)?row.period_min!:null,
        periodMax:Number.isInteger(row.period_max)?row.period_max!:null
      }));
  }
}

export type AtolFiscalResult={
  uuid:string;
  state:"WAIT"|"DONE"|"FAIL";
  externalId?:string;
  fnNumber?:string;
  documentNumber?:number;
  fiscalSign?:string;
  receiptUrl?:string;
  amountMinor?:string;
};

export class AtolOnlineGateway{
  private async token(cred:AtolCredentials,env:ProviderEnvironment):Promise<string>{
    if(!cred.login||!cred.password||!cred.groupCode ||
       !/^[a-zA-Z0-9_-]{2,140}$/.test(cred.groupCode))
      throw new ServiceUnavailableException("Кассовые реквизиты АТОЛ не настроены");
    const result=await providerRequest<{token?:string;error?:unknown}>(
      safeUrl("ATOL_ONLINE",env)+"/possystem/v5/getToken","POST",
      {"Content-Type":"application/json;charset=utf-8"},
      JSON.stringify({login:cred.login,pass:cred.password,source:"CoreBiz"})
    );
    if(result.error || !result.token || result.token.length>1000)
      throw new BadGatewayException("АТОЛ не подтвердил доступ к ФФД 1.2");
    return result.token;
  }
  async verify(cred:AtolCredentials,env:ProviderEnvironment):Promise<{authorized:true}>{
    await this.token(cred,env);
    return {authorized:true};
  }
  async registerSell(
    cred:AtolCredentials,env:ProviderEnvironment,
    payload:Record<string,unknown>
  ):Promise<AtolFiscalResult>{
    const token=await this.token(cred,env);
    // Fixed host, validated group; token in header, NEVER in URL or logs.
    const response=await providerRequest<{
      uuid?:string;status?:string;error?:unknown
    }>(safeUrl("ATOL_ONLINE",env)+"/possystem/v5/"+
        encodeURIComponent(cred.groupCode)+"/sell","POST",
      {"Content-Type":"application/json;charset=utf-8",Token:token},
      JSON.stringify(payload));
    if(response.error||response.status!=="wait"||
       typeof response.uuid!=="string"||
       !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(response.uuid))
      throw new BadGatewayException(
        "АТОЛ не подтвердил приём документа. Повторять чек без сверки запрещено"
      );
    return {uuid:response.uuid,state:"WAIT"};
  }
  async report(
    cred:AtolCredentials,env:ProviderEnvironment,uuid:string
  ):Promise<AtolFiscalResult>{
    if(!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(uuid))
      throw new BadGatewayException("Неверный UUID чека АТОЛ");
    const token=await this.token(cred,env);
    const result=await providerRequest<{
      uuid?:string;status?:string;error?:unknown;external_id?:string;
      payload?:{
        total?:number;fn_number?:string;fiscal_document_number?:number;
        fiscal_document_attribute?:number;ofd_receipt_url?:string;
      }
    }>(safeUrl("ATOL_ONLINE",env)+"/possystem/v5/"+
      encodeURIComponent(cred.groupCode)+"/report/"+encodeURIComponent(uuid),
      "GET",{Token:token});
    if(result.uuid!==uuid)
      throw new BadGatewayException("АТОЛ вернул результат чужого документа");
    if(result.status==="wait")return {uuid,state:"WAIT",...(result.external_id?{externalId:result.external_id}:{})};
    if(result.status==="fail")return {uuid,state:"FAIL",...(result.external_id?{externalId:result.external_id}:{})};
    const p=result.payload;
    if(result.status!=="done"||result.error||!p||
       typeof p.total!=="number"||!Number.isFinite(p.total)||
       p.total<=0||p.total>99999999||
       !/^\d{14,20}$/.test(p.fn_number??"")||
       !Number.isSafeInteger(p.fiscal_document_number)||
       (p.fiscal_document_number??0)<=0||
       !Number.isSafeInteger(p.fiscal_document_attribute)||
       (p.fiscal_document_attribute??0)<=0)
      throw new BadGatewayException("АТОЛ не подтвердил ФН, номер ФД и ФП");
    const url=p.ofd_receipt_url;
    let trusted:string|undefined;
    if(url){
      try{
        const parsed=new URL(url);
        if(parsed.protocol==="https:"&&!parsed.username&&!parsed.password &&
           url.length<=2048)trusted=url;
      }catch{ /* An optional OFD link is untrusted; do not promote it. */ }
    }
    return {
      uuid,state:"DONE",
      ...(result.external_id?{externalId:result.external_id}:{}),
      fnNumber:p.fn_number!,
      documentNumber:p.fiscal_document_number!,
      fiscalSign:String(p.fiscal_document_attribute!),
      amountMinor:String(Math.round(p.total!*100)),
      ...(trusted?{receiptUrl:trusted}:{})
    };
  }
}
