import {assertDanceLessonWindow,isValidDanceDate,validCapacity} from "./dance-validation";

describe("dance studio — business safety rules",()=>{
  it("accepts leap day and rejects impossible dates",()=>{
    expect(isValidDanceDate("2028-02-29")).toBe(true);
    expect(isValidDanceDate("2026-02-29")).toBe(false);
    expect(isValidDanceDate("2026-02-31")).toBe(false);
    expect(isValidDanceDate("2026-13-01")).toBe(false);
    expect(isValidDanceDate("2026-10-11")).toBe(true);
  });
  it("allows a short schedule but blocks invalid or excessive generation",()=>{
    expect(assertDanceLessonWindow("2026-10-11","2026-10-11")).toBe(1);
    expect(assertDanceLessonWindow("2026-10-11","2026-10-18")).toBe(8);
    expect(()=>assertDanceLessonWindow("2026-10-18","2026-10-11")).toThrow();
    expect(()=>assertDanceLessonWindow("2026-01-01","2027-01-01")).toThrow();
    expect(()=>assertDanceLessonWindow("2026-02-31","2026-03-05")).toThrow();
  });
  it("protects group capacity when admin submits a fraction or NaN",()=>{
    expect(validCapacity(12,1,500)).toBe(true);
    expect(validCapacity(12.5,1,500)).toBe(false);
    expect(validCapacity(Number.NaN,1,500)).toBe(false);
    expect(validCapacity(-1,1,500)).toBe(false);
    expect(validCapacity(501,1,500)).toBe(false);
    expect(validCapacity("15",1,500)).toBe(false);
  });
});
