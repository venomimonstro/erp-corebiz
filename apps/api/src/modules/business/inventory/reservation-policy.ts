import {BadRequestException,ConflictException} from "@nestjs/common";

/** Common ATP gate for sales, OMS and channel-backed stock flows. */
export function assertReservableStock(input:{
  physicalMilli:bigint;reservedMilli:bigint;requestedMilli:bigint;
  configuredSafetyMilli:bigint;inheritedSafetyMilli?:bigint;enabled:boolean;
}):void{
  if(!input.enabled)
    throw new ConflictException("Складская политика запрещает продажи этого товара");
  const inherited=input.inheritedSafetyMilli??0n;
  if(input.requestedMilli<=0n||input.configuredSafetyMilli<0n||
    inherited<0n||input.physicalMilli<0n||input.reservedMilli<0n)
    throw new BadRequestException("Некорректные значения складского резерва");
  const safety=input.configuredSafetyMilli>inherited
    ?input.configuredSafetyMilli:inherited;
  if(input.physicalMilli-input.reservedMilli-input.requestedMilli<safety)
    throw new ConflictException("Недостаточно доступного запаса с учётом страхового остатка");
}
