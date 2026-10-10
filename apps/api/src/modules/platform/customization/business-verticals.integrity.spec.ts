import { BUSINESS_CAPABILITIES, BUSINESS_VERTICAL_LIST, BUSINESS_VERTICALS } from "./business-verticals";

describe("vertical configuration integrity", () => {
  const knownCapabilities = new Set<string>(BUSINESS_CAPABILITIES);
  const requiredByProfile: Record<string, string[]> = {
    GENERAL: ["crm", "finance"],
    TRADE: ["sales", "inventory", "procurement", "finance"],
    ECOMMERCE: ["oms", "channels", "inventory", "finance"],
    SERVICE: ["service", "crm", "finance"],
    WAREHOUSE_3PL: ["wms", "inventory", "finance"]
  };

  it("has a unique code and a coherent profile for every template", () => {
    expect(new Set(BUSINESS_VERTICAL_LIST.map((v) => v.code)).size)
      .toBe(BUSINESS_VERTICAL_LIST.length);
    for (const vertical of BUSINESS_VERTICAL_LIST) {
      expect(BUSINESS_VERTICALS[vertical.code]).toBe(vertical);
      expect(vertical.version).toBeGreaterThan(0);
      expect(vertical.title.trim()).not.toBe("");
      expect(vertical.summary.trim()).not.toBe("");
      for (const capability of requiredByProfile[vertical.profileCode]) {
        expect(vertical.enabledCapabilities).toContain(capability);
      }
    }
  });

  it("never exposes an unavailable workspace in onboarding", () => {
    for (const vertical of BUSINESS_VERTICAL_LIST) {
      const capabilities = new Set<string>(vertical.enabledCapabilities);
      expect(new Set(vertical.primaryWorkspaces).size)
        .toBe(vertical.primaryWorkspaces.length);
      for (const workspace of vertical.primaryWorkspaces) {
        expect(knownCapabilities.has(workspace) || workspace === "owner").toBe(true);
        if (workspace !== "owner") {
          expect(capabilities.has(workspace)).toBe(true);
        }
      }
    }
  });

  it("has valid, unique per-entity custom fields", () => {
    for (const vertical of BUSINESS_VERTICAL_LIST) {
      const keys = new Set<string>();
      for (const field of vertical.customFields) {
        const key = `${field.entityType}:${field.fieldKey}`;
        expect(keys.has(key)).toBe(false);
        keys.add(key);
        expect(field.fieldKey).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(field.label.trim()).not.toBe("");
        if (field.dataType === "SELECT" || field.dataType === "MULTISELECT") {
          expect(field.options?.length ?? 0).toBeGreaterThan(0);
          expect(new Set(field.options).size).toBe(field.options?.length);
        } else {
          expect(field.options ?? []).toHaveLength(0);
        }
      }
    }
  });

  it("includes owner-facing operating guidance without duplicates", () => {
    for (const vertical of BUSINESS_VERTICAL_LIST) {
      for (const items of [vertical.ownerQuestions, vertical.operatingFlows, vertical.attentionSignals]) {
        expect(items.length).toBeGreaterThan(0);
        expect(new Set(items).size).toBe(items.length);
        expect(items.every((item) => item.trim().length > 8)).toBe(true);
      }
    }
  });
});
