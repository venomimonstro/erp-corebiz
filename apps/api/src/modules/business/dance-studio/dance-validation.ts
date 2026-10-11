/** Strict studio-calendar validation. ISO date text alone is not enough (e.g. 2026-02-31). */
export function isValidDanceDate(value:unknown):value is string{
  if(typeof value!=="string"||!/^(20\d{2}|21\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value))
    return false;
  const date=new Date(value+"T00:00:00.000Z");
  return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
}
export function assertDanceLessonWindow(from:unknown,to:unknown,maxDays=120){
  if(!isValidDanceDate(from)||!isValidDanceDate(to)||from>to)
    throw new Error("INVALID_LESSON_PERIOD");
  const start=Date.parse(from+"T00:00:00.000Z");
  const end=Date.parse(to+"T00:00:00.000Z");
  const days=Math.round((end-start)/86400000)+1;
  if(days<1||days>maxDays)throw new Error("LESSON_PERIOD_TOO_LONG");
  return days;
}
export function validCapacity(value:unknown,min:number,max:number){
  return typeof value==="number"&&Number.isSafeInteger(value)&&value>=min&&value<=max;
}
