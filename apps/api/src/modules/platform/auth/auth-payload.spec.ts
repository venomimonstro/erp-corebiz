import { BadRequestException } from "@nestjs/common";
import { parseLoginPayload, parseRegisterPayload, parseMembershipPayload } from "./auth-payload";

describe("authentication input validation", () => {
  it("accepts normalized form fields without altering the password", () => {
    expect(parseLoginPayload({ email: " TEST@example.com ", password: "  secret " }))
      .toEqual({ email: "TEST@example.com", password: "  secret " });
  });
  it("accepts a bounded MFA code without normalizing the recovery secret", () => {
    expect(parseLoginPayload({
      email:"e@example.com",password:"secret-secret",mfaCode:" ABCD-1234 "
    })).toEqual({
      email:"e@example.com",password:"secret-secret",mfaCode:"ABCD-1234"
    });
  });
  it.each([null, [], {}, { email: {}, password: "secret" }, { email: "e@example.com", password: [] },
    { email: "e@example.com", password: "x".repeat(50000) },
    { email:"e@example.com",password:"secret-secret",mfaCode:"x".repeat(65) }])(
    "rejects malformed or oversized login request (%p)", (value) => {
      expect(() => parseLoginPayload(value)).toThrow(BadRequestException);
    }
  );
  it("rejects short passwords and invalid company name", () => {
    expect(() => parseRegisterPayload({ email: "e@example.com", password: "short", companyName: "Company" }))
      .toThrow(BadRequestException);
    expect(() => parseRegisterPayload({ email: "e@example.com", password: "correct horse", companyName: [] }))
      .toThrow(BadRequestException);
  });
  it("rejects invalid tenant identifiers before accessing the database", () => {
    expect(() => parseMembershipPayload({ membershipId: { id: 1 } }))
      .toThrow(BadRequestException);
    expect(parseMembershipPayload({ membershipId: "12345678-1234-1234-1234-123456789abc" }))
      .toBe("12345678-1234-1234-1234-123456789abc");
  });
});
