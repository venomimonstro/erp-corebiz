import {BadGatewayException,ServiceUnavailableException} from "@nestjs/common";
import {validRussianPostCredentials,type RussianPostCredentials} from "./russian-post.gateway";

const BASE="https://otpravka-api.pochta.ru/1.0";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digits6=/^\d{6}$/;
export type PostalAddress={
  index:string;region:string;place:string;street:string;house:string;
};
export type PostalConsignment={
  orderNumber:string;recipientName:string;recipientPhone:string;
  destination:PostalAddress;massGrams:number;
};
export type PostalBacklog={
  providerId:string;orderNumber:string;barcode:string|null
};
function safeText(value:unknown,max:number){
  return typeof value==="string"&&value.trim().length>0&&
    value.trim().length<=max&&!/[\x00-\x1f]/.test(value);
}
export function validPostalConsignment(input:unknown):input is PostalConsignment{
  if(!input||typeof input!=="object"||Array.isArray(input))return false;
  const x=input as Record<string,unknown>;
  const a=x.destination as Record<string,unknown>|undefined;
  return uuid.test(String(x.orderNumber))&&
    safeText(x.recipientName,160)&&
    typeof x.recipientPhone==="string"&&/^\+?[0-9]{10,15}$/.test(x.recipientPhone)&&
    Number.isSafeInteger(x.massGrams)&&Number(x.massGrams)>=1&&
    Number(x.massGrams)<=20000&&!!a&&typeof a==="object"&&!Array.isArray(a)&&
    digits6.test(String(a.index))&&safeText(a.region,160)&&
    safeText(a.place,160)&&safeText(a.street,200)&&safeText(a.house,50);
}
function parseOrder(value:unknown):PostalBacklog|null{
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const obj=value as Record<string,unknown>;
  const id=obj.id??obj["internal-id"];
  const number=obj["order-num"];
  const barcode=obj["barcode"]??obj["rpo-barcode"];
  if(!(typeof id==="number"&&Number.isSafeInteger(id)&&id>0||
       typeof id==="string"&&/^[0-9]{1,18}$/.test(id))||
     typeof number!=="string"||!uuid.test(number))return null;
  return {providerId:String(id),orderNumber:number,
    barcode:typeof barcode==="string"&&/^[0-9A-Z]{10,20}$/.test(barcode)
      ?barcode:null};
}
/**
 * "Отправка" returns an internal backlog ID, NOT a shipping barcode.
 * Caller must reserve a unique local claim BEFORE invoking create.
 */
export class RussianPostShipmentGateway{
  private async request(
    credentials:RussianPostCredentials,path:string,method:"GET"|"PUT",
    payload?:unknown
  ):Promise<unknown>{
    if(!validRussianPostCredentials(credentials))
      throw new ServiceUnavailableException("Некорректные ключи Почты России");
    const abort=new AbortController();
    const timer=setTimeout(()=>abort.abort(),10000);
    try{
      const response=await fetch(BASE+path,{
        method,signal:abort.signal,redirect:"error",
        headers:{
          Authorization:"AccessToken "+credentials.accessToken,
          "X-User-Authorization":"Basic "+credentials.userAuthorizationKey,
          Accept:"application/json",
          ...(method==="PUT"?{"Content-Type":"application/json;charset=UTF-8"}:{})
        },
        ...(payload===undefined?{}:{body:JSON.stringify(payload)})
      });
      if(!response.ok||
        Number(response.headers.get("content-length")??0)>65536)
        throw new BadGatewayException("Почта России не подтвердила запрос");
      const body=await response.text();
      if(body.length>65536)
        throw new BadGatewayException("Слишком большой ответ Почты России");
      try{return JSON.parse(body) as unknown;}
      catch{throw new BadGatewayException("Неверный JSON от Почты России");}
    }catch(error){
      if(error instanceof BadGatewayException)throw error;
      throw new ServiceUnavailableException(
        "Почта России не ответила; результат операции требуется сверить"
      );
    }finally{clearTimeout(timer);}
  }
  async create(credentials:RussianPostCredentials,input:PostalConsignment):
    Promise<{providerId:string}>{
    if(!validPostalConsignment(input))
      throw new BadGatewayException("Некорректная почтовая посылка");
    const name=input.recipientName.trim();
    const result=await this.request(credentials,"/user/backlog","PUT",[{
      "order-num":input.orderNumber,
      "address-type-to":"DEFAULT",
      "mail-category":"ORDINARY",
      "mail-type":"POSTAL_PARCEL",
      "mail-direct":643,
      "payment-method":"CASHLESS",
      "index-to":Number(input.destination.index),
      "region-to":input.destination.region.trim(),
      "place-to":input.destination.place.trim(),
      "street-to":input.destination.street.trim(),
      "house-to":input.destination.house.trim(),
      "recipient-name":name,
      "tel-address":input.recipientPhone,
      "mass":input.massGrams
    }]);
    if(!result||typeof result!=="object"||Array.isArray(result))
      throw new BadGatewayException("Почта России не выдала ID заказа");
    const obj=result as Record<string,unknown>;
    // A 200 response can contain validation errors and NO order.
    if(Array.isArray(obj.errors)&&obj.errors.length)
      throw new BadGatewayException("Почта России отклонила поля отправления");
    const ids=obj["result-ids"];
    if(!Array.isArray(ids)||ids.length!==1||
      !(typeof ids[0]==="number"&&Number.isSafeInteger(ids[0])&&ids[0]>0))
      throw new BadGatewayException("Почта России не подтвердила создание");
    return {providerId:String(ids[0])};
  }
  async findByOrderNumber(credentials:RussianPostCredentials,
    orderNumber:string):Promise<PostalBacklog|null>{
    if(!uuid.test(orderNumber))
      throw new BadGatewayException("Некорректный номер заказа");
    const json=await this.request(credentials,
      "/backlog/search?query="+encodeURIComponent(orderNumber),"GET");
    if(!Array.isArray(json))
      throw new BadGatewayException("Почта России не подтвердила поиск");
    const exact=json.map(parseOrder).filter((x):x is PostalBacklog=>
      x!==null&&x.orderNumber===orderNumber);
    if(exact.length>1)
      throw new BadGatewayException("Найдено несколько отправлений: требуется ручная сверка");
    return exact[0]??null;
  }
  async read(credentials:RussianPostCredentials,id:string):
    Promise<PostalBacklog>{
    if(!/^[0-9]{1,18}$/.test(id))
      throw new BadGatewayException("Некорректный ID почтового заказа");
    const data=await this.request(credentials,"/backlog/"+id,"GET");
    const parsed=parseOrder(data);
    if(!parsed||parsed.providerId!==id)
      throw new BadGatewayException("Почта России не подтвердила ID заказа");
    return parsed;
  }
}
