import {BadGatewayException,ServiceUnavailableException} from "@nestjs/common";

export type RussianPostCredentials={
  accessToken:string;
  userAuthorizationKey:string;
};
export type RussianPostQuoteInput={
  fromPostcode:string;toPostcode:string;massGrams:number
};
export type RussianPostQuote={
  fromPostcode:string;toPostcode:string;
  mailType:"POSTAL_PARCEL";massGrams:number;
  rateMinor:string;vatMinor:string;amountMinor:string;
  periodMin:number|null;periodMax:number|null
};
const postcode=(value:unknown):value is string=>
  typeof value==="string"&&/^[0-9]{6}$/.test(value);
export function validRussianPostCredentials(cred:unknown):
  cred is RussianPostCredentials{
  if(!cred||typeof cred!=="object"||Array.isArray(cred))return false;
  const x=cred as Record<string,unknown>;
  return typeof x.accessToken==="string"&&
    /^[A-Za-z0-9_.-]{16,512}$/.test(x.accessToken)&&
    typeof x.userAuthorizationKey==="string"&&
    /^[A-Za-z0-9+/]{12,1024}={0,2}$/.test(x.userAuthorizationKey);
}
export class RussianPostGateway{
  async tariff(credentials:RussianPostCredentials,input:RussianPostQuoteInput)
    :Promise<RussianPostQuote>{
    if(!validRussianPostCredentials(credentials))
      throw new ServiceUnavailableException("Некорректные ключи API Почты России");
    if(!postcode(input.fromPostcode)||!postcode(input.toPostcode)||
       !Number.isSafeInteger(input.massGrams)||
       input.massGrams<1||input.massGrams>20000)
      throw new ServiceUnavailableException("Некорректные индексы или вес посылки");
    const abort=new AbortController();
    const timeout=setTimeout(()=>abort.abort(),10000);
    try{
      const response=await fetch("https://otpravka-api.pochta.ru/1.0/tariff",{
        method:"POST",redirect:"error",signal:abort.signal,
        headers:{
          Authorization:"AccessToken "+credentials.accessToken,
          "X-User-Authorization":"Basic "+credentials.userAuthorizationKey,
          "Content-Type":"application/json;charset=UTF-8",
          Accept:"application/json"
        },
        body:JSON.stringify({
          "index-from":Number(input.fromPostcode),
          "index-to":Number(input.toPostcode),
          "mail-category":"ORDINARY",
          "mail-type":"POSTAL_PARCEL",
          "mass":input.massGrams,
          "payment-method":"CASHLESS"
        })
      });
      if(!response.ok||
         Number(response.headers.get("content-length")??0)>64000)
        throw new BadGatewayException("Почта России не подтвердила тариф");
      const raw=await response.text();
      if(raw.length>64000)
        throw new BadGatewayException("Слишком большой ответ API Почты России");
      let json:unknown;
      try{json=JSON.parse(raw);}
      catch{throw new BadGatewayException("Некорректный JSON тарифа Почты России");}
      if(!json||typeof json!=="object"||Array.isArray(json))
        throw new BadGatewayException("Тариф не определён");
      const data=json as Record<string,unknown>;
      const rate=data["total-rate"],vat=data["total-vat"];
      if(!Number.isSafeInteger(rate)||Number(rate)<0||
         !Number.isSafeInteger(vat)||Number(vat)<0||
         Number(rate)+Number(vat)<=0||
         Number(rate)+Number(vat)>1000000000)
        throw new BadGatewayException("Почта России вернула неверную сумму тарифа");
      const delivery=data["delivery-time"];
      const period=delivery&&typeof delivery==="object"&&!Array.isArray(delivery)
        ?delivery as Record<string,unknown>:{};
      const days=(key:string)=>{
        const n=period[key];
        return Number.isSafeInteger(n)&&Number(n)>=0&&Number(n)<=365
          ?Number(n):null;
      };
      return {
        fromPostcode:input.fromPostcode,toPostcode:input.toPostcode,
        mailType:"POSTAL_PARCEL",massGrams:input.massGrams,
        rateMinor:String(rate),vatMinor:String(vat),
        amountMinor:String(Number(rate)+Number(vat)),
        periodMin:days("min-days"),periodMax:days("max-days")
      };
    }catch(error){
      if(error instanceof BadGatewayException)throw error;
      throw new ServiceUnavailableException(
        "Тарификатор Почты России недоступен; операция не подтверждена"
      );
    }finally{clearTimeout(timeout);}
  }
}
