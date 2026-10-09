import { hashToken, parseCookie } from "./auth.utils";

describe("auth utils", () => {
  it("hashes the same token deterministically without storing the raw token", () => {
    const token = "secret-session-token";
    const hash = hashToken(token);

    expect(hash).toHaveLength(64);
    expect(hash).not.toBe(token);
    expect(hashToken(token)).toBe(hash);
  });

  it("reads a named cookie without depending on cookie order", () => {
    expect(
      parseCookie("foo=1; corebiz_session=abc123; bar=2", "corebiz_session")
    ).toBe("abc123");
  });

  it("returns undefined for an absent cookie", () => {
    expect(parseCookie("foo=1", "corebiz_session")).toBeUndefined();
  });
  it("ignores malformed and oversized session cookies without throwing", () => {
    expect(parseCookie("corebiz_session=%ZZ", "corebiz_session")).toBeUndefined();
    expect(parseCookie("corebiz_session=" + "a".repeat(9000), "corebiz_session")).toBeUndefined();
  });
});
