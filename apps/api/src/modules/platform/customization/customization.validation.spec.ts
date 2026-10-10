import {
  BadRequestException,
  ForbiddenException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { CustomizationService } from "./customization.service";

describe("CustomizationService validation boundaries", () => {
  const context: TenantContext = {
    tenantId: "11111111-1111-1111-1111-111111111111",
    userId: "22222222-2222-2222-2222-222222222222",
    membershipId: "33333333-3333-3333-3333-333333333333"
  };

  function subject() {
    const database = {
      withTenantTransaction: jest.fn()
    };
    const authorization = {
      resolveScope: jest.fn(),
      membershipIdsForScope: jest.fn()
    };

    return {
      service: new CustomizationService(
        database as any,
        authorization as any
      ),
      database,
      authorization
    };
  }

  it("rejects unknown capability keys before touching the database", async () => {
    const test = subject();

    await expect(
      test.service.setCapability(context, "finacne", true)
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(test.database.withTenantTransaction).not.toHaveBeenCalled();
  });

  it("rejects duplicate custom-role permissions before replacing grants", async () => {
    const test = subject();

    await expect(
      test.service.setCustomRolePermissions(context, "role-1", [
        { code: "crm.read", scope: "own" },
        { code: "crm.read", scope: "all" }
      ])
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(test.database.withTenantTransaction).not.toHaveBeenCalled();
  });

  it("rejects invalid custom-role scopes at runtime", async () => {
    const test = subject();

    await expect(
      test.service.setCustomRolePermissions(context, "role-1", [
        { code: "crm.read", scope: "tenant" as any }
      ])
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(test.database.withTenantTransaction).not.toHaveBeenCalled();
  });

  it("requires customization permission for a shared saved view", async () => {
    const test = subject();
    test.authorization.resolveScope.mockResolvedValue(null);

    await expect(
      test.service.createSavedView(context, {
        entityType: "DEAL",
        name: "Общая воронка",
        isShared: true,
        configuration: { columns: ["title"] }
      })
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(test.authorization.resolveScope).toHaveBeenCalledWith(
      context,
      "customization.manage"
    );
    expect(test.database.withTenantTransaction).not.toHaveBeenCalled();
  });

  it("rejects malformed saved-view configuration before persistence", async () => {
    const test = subject();

    await expect(
      test.service.createSavedView(context, {
        entityType: "DEAL",
        name: "Моё представление",
        configuration: [] as any
      })
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(test.database.withTenantTransaction).not.toHaveBeenCalled();
  });
});
