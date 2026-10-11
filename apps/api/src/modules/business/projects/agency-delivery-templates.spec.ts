import { AGENCY_DELIVERY_TEMPLATES } from "./agency-delivery-templates";

describe("agency kickoff templates", () => {
  const types=new Set([
    "DESIGN","DEVELOPMENT","SEO","CONTENT","ADVERTISING",
    "ANALYTICS","STRATEGY","REPORT","OTHER"
  ]);
  it("has a distinct industry workflow for each agency service", () => {
    expect(AGENCY_DELIVERY_TEMPLATES.map(t=>t.code)).toEqual(
      ["WEB_BUILD","SEO","PPC","SMM","MARKETING"]
    );
  });
  it("uses only known deliverables and keeps task titles, keys and due dates valid", () => {
    for(const t of AGENCY_DELIVERY_TEMPLATES){
      expect(t.title.length).toBeGreaterThan(2);
      expect(t.steps.length).toBeGreaterThanOrEqual(5);
      expect(new Set(t.steps.map(s=>s.code)).size).toBe(t.steps.length);
      let previous=-1;
      for(const step of t.steps){
        expect(types.has(step.deliverableType)).toBe(true);
        expect(step.title.length).toBeGreaterThan(2);
        expect(step.title.length).toBeLessThanOrEqual(220);
        expect(step.checklist.length).toBeGreaterThan(20);
        expect(step.offsetDays).toBeGreaterThan(previous);
        expect(step.offsetDays).toBeLessThanOrEqual(90);
        previous=step.offsetDays;
      }
    }
  });
});
