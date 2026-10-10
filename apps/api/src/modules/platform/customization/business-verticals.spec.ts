import {
  BUSINESS_CAPABILITIES,
  BUSINESS_VERTICAL_LIST,
  BUSINESS_VERTICALS
} from "./business-verticals";

describe("business vertical operating models", () => {
  it("uses only managed capabilities and never duplicates them", () => {
    const allowed = new Set<string>(BUSINESS_CAPABILITIES);

    for (const vertical of BUSINESS_VERTICAL_LIST) {
      expect(new Set(vertical.enabledCapabilities).size)
        .toBe(vertical.enabledCapabilities.length);

      for (const capability of vertical.enabledCapabilities) {
        expect(allowed.has(capability)).toBe(true);
      }

      expect(vertical.operatingFlows.length).toBeGreaterThan(0);
      expect(vertical.attentionSignals.length).toBeGreaterThan(0);
    }
  });

  it("keeps lean service businesses free from stock modules by default", () => {
    for (const code of ["DANCE_FITNESS", "PROFESSIONAL_SERVICES"] as const) {
      const capabilities = new Set(
        BUSINESS_VERTICALS[code].enabledCapabilities
      );

      expect(capabilities.has("service")).toBe(true);
      expect(capabilities.has("crm")).toBe(true);
      expect(capabilities.has("finance")).toBe(true);
      expect(capabilities.has("inventory")).toBe(false);
      expect(capabilities.has("procurement")).toBe(false);
    }
  });

  it("keeps stock-dependent service businesses operationally complete", () => {
    for (const code of ["BEAUTY_SALON", "AUTO_SERVICE"] as const) {
      const capabilities = new Set(
        BUSINESS_VERTICALS[code].enabledCapabilities
      );

      expect(capabilities.has("service")).toBe(true);
      expect(capabilities.has("catalog")).toBe(true);
      expect(capabilities.has("inventory")).toBe(true);
      expect(capabilities.has("procurement")).toBe(true);
      expect(capabilities.has("finance")).toBe(true);
    }
  });

  it("does not force the site builder on marketplace-only sellers", () => {
    const marketplace = new Set(
      BUSINESS_VERTICALS.MARKETPLACE_SELLER.enabledCapabilities
    );
    const store = new Set(
      BUSINESS_VERTICALS.ECOMMERCE_STORE.enabledCapabilities
    );

    expect(marketplace.has("channels")).toBe(true);
    expect(marketplace.has("oms")).toBe(true);
    expect(marketplace.has("sites")).toBe(false);
    expect(store.has("sites")).toBe(true);
  });

  it("keeps 3PL centered on inventory and WMS rather than CRM/growth", () => {
    const capabilities = new Set(
      BUSINESS_VERTICALS.WAREHOUSE_3PL.enabledCapabilities
    );

    expect(capabilities.has("wms")).toBe(true);
    expect(capabilities.has("inventory")).toBe(true);
    expect(capabilities.has("finance")).toBe(true);
    expect(capabilities.has("crm")).toBe(false);
    expect(capabilities.has("growth")).toBe(false);
  });
  it("keeps regulated accounting available in every business vertical", () => {
    for (const vertical of BUSINESS_VERTICAL_LIST) {
      expect(vertical.enabledCapabilities).toContain("accounting");
    }
  });

  it("enables project delivery only where it is an operating core", () => {
    expect(
      BUSINESS_VERTICALS.PROFESSIONAL_SERVICES.enabledCapabilities
    ).toContain("projects");

    for (const code of [
      "BEAUTY_SALON",
      "AUTO_SERVICE",
      "DANCE_FITNESS",
      "RETAIL_STORE",
      "WHOLESALE_B2B",
      "ECOMMERCE_STORE",
      "MARKETPLACE_SELLER",
      "WAREHOUSE_3PL"
    ] as const) {
      expect(BUSINESS_VERTICALS[code].enabledCapabilities).not.toContain(
        "projects"
      );
    }
  });
});
