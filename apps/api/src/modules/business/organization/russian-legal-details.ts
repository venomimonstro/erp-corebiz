/**
 * Russian INN checksum for legal entities (10 digits) and individuals/IP
 * (12 digits). This validates syntax/check digits, NOT registration at FNS.
 */
export function validRussianInn(value:string):boolean{
  if(!/^(?:[0-9]{10}|[0-9]{12})$/.test(value) || /^0+$/.test(value))
    return false;
  const d=[...value].map(Number);
  const check=(weights:number[])=>weights.reduce(
    (sum,weight,i)=>sum+weight*d[i]!,0)%11%10;
  if(d.length===10){
    return check([2,4,10,3,5,9,4,6,8])===d[9];
  }
  return check([7,2,4,10,3,5,9,4,6,8])===d[10] &&
    check([3,7,2,4,10,3,5,9,4,6,8])===d[11];
}

/** KPP format, not verification of actual registration. */
export function validRussianKpp(value:string):boolean{
  return /^[0-9]{4}[0-9A-Z]{2}[0-9]{3}$/.test(value);
}
