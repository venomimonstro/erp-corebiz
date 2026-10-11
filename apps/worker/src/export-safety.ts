/**
 * Spreadsheet programs may evaluate cells starting with =, +, -, @ or
 * control+formula prefixes as active commands when opening a CSV.
 * The archive is business data, never executable spreadsheet formulas.
 */
export function csvCell(value:unknown):string{
  if(value===null||value===undefined)return '""';
  const isUserString=typeof value==="string";
  let raw=typeof value==="object"?JSON.stringify(value):String(value);
  if(isUserString){
    // Leading tabs/CRs sometimes bypass spreadsheet formula detection.
    // Retain the original content, but force spreadsheet text mode.
    if(/^[\\s\\u0000-\\u001f]*[=+\\-@]/u.test(raw))
      raw="'"+raw;
  }
  return '"'+raw.replace(/"/g,'""')+'"';
}

export function csvBatch(
  rows:Record<string,unknown>[],
  columns:string[],
  includeHeader:boolean
):string{
  if(!rows.length)return "";
  const result:string[]=[];
  if(includeHeader)result.push(columns.map(csvCell).join(","));
  for(const row of rows)
    result.push(columns.map(col=>csvCell(row[col])).join(","));
  return result.join("\n")+"\n";
}
