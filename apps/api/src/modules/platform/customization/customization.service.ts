import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { AuthorizationService } from "../authorization/authorization.service";
import {
  BUSINESS_CAPABILITIES,
  BUSINESS_VERTICAL_LIST,
  BUSINESS_VERTICALS,
  type BusinessVerticalCode
} from "./business-verticals";

type EntityType = "DEAL" | "PARTY" | "PRODUCT" | "SALES_ORDER" | "PURCHASE_ORDER";
type FieldType = "TEXT" | "NUMBER" | "DATE" | "BOOLEAN" | "SELECT" | "MULTISELECT";
type PermissionScope = "own" | "team" | "branch" | "all";

@Injectable()
export class CustomizationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: AuthorizationService
  ) {}

  async fields(
    context: TenantContext,
    entityType: EntityType
  ): Promise<Array<Record<string, unknown>>> {
    const normalizedEntityType = this.normalizeEntityType(entityType);
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT id, entity_type, field_key, label, data_type, options,
                is_required, is_active, created_at, updated_at
         FROM custom_field_definition
         WHERE tenant_id = $1
           AND entity_type = $2
           AND is_active = true
         ORDER BY created_at`,
        [context.tenantId, normalizedEntityType]
      );

      return result.rows;
    });
  }

  async createField(
    context: TenantContext,
    input: {
      entityType: EntityType;
      fieldKey: string;
      label: string;
      dataType: FieldType;
      options?: string[];
      isRequired?: boolean;
    }
  ): Promise<{ id: string }> {
    const entityType = this.normalizeEntityType(input.entityType);
    const dataType = this.normalizeFieldType(input.dataType);
    const key = input.fieldKey.trim().toLowerCase();
    const label = input.label.trim();

    if (!/^[a-z][a-z0-9_]{1,63}$/.test(key)) {
      throw new BadRequestException(
        "Ключ поля: латиница, цифры и _, начинается с буквы"
      );
    }
    if (label.length < 2 || label.length > 120) {
      throw new BadRequestException("Некорректное название поля");
    }

    const options = Array.from(
      new Set((input.options ?? []).map((item) => item.trim()).filter(Boolean))
    );

    if (
      ["SELECT", "MULTISELECT"].includes(dataType) &&
      options.length === 0
    ) {
      throw new BadRequestException("Для списка укажите варианты значений");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      try {
        const result = await client.query<{ id: string }>(
          `INSERT INTO custom_field_definition(
             tenant_id, entity_type, field_key, label,
             data_type, options, is_required
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING id`,
          [
            context.tenantId,
            entityType,
            key,
            label,
            dataType,
            JSON.stringify(options),
            Boolean(input.isRequired)
          ]
        );

        const field = result.rows[0];
        if (!field) throw new Error("CUSTOM_FIELD_CREATE_FAILED");

        await this.audit(
          client,
          context,
          "customization.field_created",
          "custom_field_definition",
          field.id,
          { entityType, fieldKey: key }
        );

        return field;
      } catch (error) {
        if (this.isUniqueViolation(error)) {
          throw new ConflictException("Поле с таким ключом уже существует");
        }
        throw error;
      }
    });
  }

  async values(
    context: TenantContext,
    entityType: EntityType,
    entityId: string
  ): Promise<Record<string, unknown>> {
    const normalizedEntityType = this.normalizeEntityType(entityType);
    const scopedMembershipIds = await this.entityScopeMembershipIds(
      context,
      normalizedEntityType,
      "read"
    );

    return this.database.withTenantTransaction(context, async (client) => {
      await this.assertEntity(
        client,
        context.tenantId,
        normalizedEntityType,
        entityId,
        scopedMembershipIds
      );

      const result = await client.query<{
        field_key: string;
        value: unknown;
      }>(
        `SELECT d.field_key, v.value
         FROM custom_field_definition d
         LEFT JOIN custom_field_value v
           ON v.tenant_id = d.tenant_id
          AND v.definition_id = d.id
          AND v.entity_id = $3
         WHERE d.tenant_id = $1
           AND d.entity_type = $2
           AND d.is_active = true
         ORDER BY d.created_at`,
        [context.tenantId, normalizedEntityType, entityId]
      );

      return Object.fromEntries(
        result.rows.map((row) => [row.field_key, row.value ?? null])
      );
    });
  }

  async setValues(
    context: TenantContext,
    entityType: EntityType,
    entityId: string,
    values: Record<string, unknown>
  ): Promise<void> {
    const normalizedEntityType = this.normalizeEntityType(entityType);
    const scopedMembershipIds = await this.entityScopeMembershipIds(
      context,
      normalizedEntityType,
      "write"
    );

    await this.database.withTenantTransaction(context, async (client) => {
      await this.assertEntity(
        client,
        context.tenantId,
        normalizedEntityType,
        entityId,
        scopedMembershipIds
      );

      const definitions = await client.query<{
        id: string;
        field_key: string;
        data_type: FieldType;
        options: unknown;
      }>(
        `SELECT id, field_key, data_type, options
         FROM custom_field_definition
         WHERE tenant_id = $1
           AND entity_type = $2
           AND is_active = true`,
        [context.tenantId, normalizedEntityType]
      );

      const byKey = new Map(
        definitions.rows.map((row) => [row.field_key, row])
      );

      for (const [key, value] of Object.entries(values)) {
        const definition = byKey.get(key);
        if (!definition) {
          throw new BadRequestException("Неизвестное custom-поле: " + key);
        }

        const normalized = this.validateValue(
          definition.data_type,
          definition.options,
          value
        );

        await client.query(
          `INSERT INTO custom_field_value(
             tenant_id, definition_id, entity_type, entity_id,
             value, updated_by_membership_id
           ) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (definition_id, entity_id)
           DO UPDATE SET
             value = EXCLUDED.value,
             updated_by_membership_id = EXCLUDED.updated_by_membership_id,
             updated_at = now()`,
          [
            context.tenantId,
            definition.id,
            normalizedEntityType,
            entityId,
            JSON.stringify(normalized),
            context.membershipId
          ]
        );
      }

      await this.audit(
        client,
        context,
        "customization.values_updated",
        normalizedEntityType.toLowerCase(),
        entityId,
        { fields: Object.keys(values) }
      );
    });
  }

  async layouts(
    context: TenantContext,
    entityType: string
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT id, entity_type, version, status, layout,
                published_at, created_at
         FROM form_layout_version
         WHERE tenant_id = $1 AND entity_type = $2
         ORDER BY version DESC`,
        [context.tenantId, entityType]
      );

      return result.rows;
    });
  }

  async createLayoutDraft(
    context: TenantContext,
    entityType: string,
    layout: Record<string, unknown>
  ): Promise<{ id: string; version: number }> {
    if (!entityType.trim()) {
      throw new BadRequestException("Не указан тип формы");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const versionResult = await client.query<{ next_version: number }>(
        `SELECT COALESCE(max(version), 0) + 1 AS next_version
         FROM form_layout_version
         WHERE tenant_id = $1 AND entity_type = $2`,
        [context.tenantId, entityType]
      );

      const version = Number(versionResult.rows[0]?.next_version ?? 1);

      const result = await client.query<{ id: string }>(
        `INSERT INTO form_layout_version(
           tenant_id, entity_type, version, status,
           layout, created_by_membership_id
         ) VALUES ($1,$2,$3,'DRAFT',$4,$5)
         RETURNING id`,
        [
          context.tenantId,
          entityType,
          version,
          JSON.stringify(layout),
          context.membershipId
        ]
      );

      return { id: result.rows[0]!.id, version };
    });
  }

  async publishLayout(
    context: TenantContext,
    layoutId: string
  ): Promise<void> {
    await this.database.withTenantTransaction(context, async (client) => {
      const draft = await client.query<{
        id: string;
        entity_type: string;
        status: string;
      }>(
        `SELECT id, entity_type, status
         FROM form_layout_version
         WHERE tenant_id = $1 AND id = $2
         FOR UPDATE`,
        [context.tenantId, layoutId]
      );

      const row = draft.rows[0];
      if (!row) throw new NotFoundException("Версия layout не найдена");
      if (row.status === "PUBLISHED") return;
      if (row.status !== "DRAFT") {
        throw new BadRequestException("Опубликовать можно только draft");
      }

      await client.query(
        `UPDATE form_layout_version
         SET status = 'ARCHIVED'
         WHERE tenant_id = $1
           AND entity_type = $2
           AND status = 'PUBLISHED'`,
        [context.tenantId, row.entity_type]
      );

      await client.query(
        `UPDATE form_layout_version
         SET status = 'PUBLISHED',
             published_by_membership_id = $3,
             published_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [context.tenantId, layoutId, context.membershipId]
      );

      await this.audit(
        client,
        context,
        "customization.layout_published",
        "form_layout_version",
        layoutId,
        { entityType: row.entity_type }
      );
    });
  }

  async savedViews(
    context: TenantContext,
    entityType: string
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        `SELECT id, entity_type, name, owner_membership_id,
                is_shared, configuration, created_at
         FROM saved_view
         WHERE tenant_id = $1
           AND entity_type = $2
           AND (is_shared = true OR owner_membership_id = $3)
         ORDER BY is_shared DESC, name`,
        [context.tenantId, entityType, context.membershipId]
      );

      return result.rows;
    });
  }

  async createSavedView(
    context: TenantContext,
    input: {
      entityType: string;
      name: string;
      isShared?: boolean;
      configuration: Record<string, unknown>;
    }
  ): Promise<{ id: string }> {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 120) {
      throw new BadRequestException("Некорректное название представления");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO saved_view(
           tenant_id, entity_type, name, owner_membership_id,
           is_shared, configuration
         ) VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id`,
        [
          context.tenantId,
          input.entityType,
          name,
          context.membershipId,
          Boolean(input.isShared),
          JSON.stringify(input.configuration)
        ]
      );

      return { id: result.rows[0]!.id };
    });
  }

  businessVerticals(): Array<Record<string, unknown>> {
    return BUSINESS_VERTICAL_LIST.map((template) => ({
      code: template.code,
      title: template.title,
      summary: template.summary,
      profileCode: template.profileCode,
      version: template.version,
      ownerQuestions: template.ownerQuestions,
      primaryWorkspaces: template.primaryWorkspaces,
      enabledCapabilities: template.enabledCapabilities,
      operatingFlows: template.operatingFlows,
      attentionSignals: template.attentionSignals
    }));
  }

  async applyBusinessVertical(
    context: TenantContext,
    verticalInput: string
  ): Promise<{
    verticalCode: string;
    verticalTitle: string;
    profileCode: string;
    templateVersion: number;
    createdFields: number;
    enabledCapabilities: string[];
    disabledCapabilities: string[];
  }> {
    const verticalCode = verticalInput.trim().toUpperCase() as BusinessVerticalCode;
    const template = BUSINESS_VERTICALS[verticalCode];
    if (!template) {
      throw new BadRequestException("Неизвестный тип бизнеса");
    }

    const enabled = new Set<string>(template.enabledCapabilities);
    const disabled = BUSINESS_CAPABILITIES.filter((key) => !enabled.has(key));

    // A vertical switch is one business operation. Profile, module visibility,
    // template fields and persisted vertical metadata must never diverge.
    return this.database.withTenantTransaction(context, async (client) => {
      await client.query(
        "SELECT id FROM tenant WHERE id=$1 FOR UPDATE",
        [context.tenantId]
      );

      await client.query(
        `INSERT INTO tenant_business_profile(
           tenant_id,profile_code,applied_at,updated_by_membership_id,updated_at
         ) VALUES ($1,$2,now(),$3,now())
         ON CONFLICT (tenant_id)
         DO UPDATE SET
           profile_code=EXCLUDED.profile_code,
           applied_at=now(),
           updated_by_membership_id=EXCLUDED.updated_by_membership_id,
           updated_at=now()`,
        [context.tenantId, template.profileCode, context.membershipId]
      );

      for (const key of BUSINESS_CAPABILITIES) {
        await client.query(
          `INSERT INTO capability_toggle(
             tenant_id,capability_key,enabled,updated_by_membership_id
           ) VALUES ($1,$2,$3,$4)
           ON CONFLICT (tenant_id,capability_key)
           DO UPDATE SET
             enabled=EXCLUDED.enabled,
             updated_by_membership_id=EXCLUDED.updated_by_membership_id,
             updated_at=now()`,
          [
            context.tenantId,
            key,
            enabled.has(key),
            context.membershipId
          ]
        );
      }

      let createdFields = 0;
      for (const field of template.customFields) {
        const result = await client.query(
          `INSERT INTO custom_field_definition(
             tenant_id,entity_type,field_key,label,data_type,options,is_required
           ) VALUES ($1,$2,$3,$4,$5,$6,false)
           ON CONFLICT (tenant_id,entity_type,field_key) DO NOTHING
           RETURNING id`,
          [
            context.tenantId,
            field.entityType,
            field.fieldKey,
            field.label,
            field.dataType,
            JSON.stringify(field.options ?? [])
          ]
        );
        createdFields += result.rowCount ?? 0;
      }

      await client.query(
        `INSERT INTO tenant_business_vertical(
           tenant_id,vertical_code,template_version,configuration,
           applied_at,updated_by_membership_id,updated_at
         ) VALUES ($1,$2,$3,$4,now(),$5,now())
         ON CONFLICT (tenant_id)
         DO UPDATE SET
           vertical_code=EXCLUDED.vertical_code,
           template_version=EXCLUDED.template_version,
           configuration=EXCLUDED.configuration,
           applied_at=now(),
           updated_by_membership_id=EXCLUDED.updated_by_membership_id,
           updated_at=now()`,
        [
          context.tenantId,
          template.code,
          template.version,
          JSON.stringify({
            title: template.title,
            profileCode: template.profileCode,
            ownerQuestions: template.ownerQuestions,
            primaryWorkspaces: template.primaryWorkspaces,
            enabledCapabilities: template.enabledCapabilities,
            operatingFlows: template.operatingFlows,
            attentionSignals: template.attentionSignals
          }),
          context.membershipId
        ]
      );

      await this.audit(
        client,
        context,
        "customization.business_profile_applied",
        "tenant_business_profile",
        context.tenantId,
        {
          profileCode: template.profileCode,
          source: "business_vertical",
          verticalCode: template.code,
          enabled: Array.from(enabled),
          disabled
        }
      );

      await this.audit(
        client,
        context,
        "customization.business_vertical_applied",
        "tenant_business_vertical",
        context.tenantId,
        {
          verticalCode: template.code,
          templateVersion: template.version,
          profileCode: template.profileCode,
          createdFields,
          enabled: Array.from(enabled),
          disabled
        }
      );

      return {
        verticalCode: template.code,
        verticalTitle: template.title,
        profileCode: template.profileCode,
        templateVersion: template.version,
        createdFields,
        enabledCapabilities: Array.from(enabled),
        disabledCapabilities: disabled
      };
    });
  }

  async businessProfile(
    context: TenantContext
  ): Promise<{
    profileCode: "GENERAL" | "TRADE" | "ECOMMERCE" | "SERVICE" | "WAREHOUSE_3PL";
    verticalCode: string | null;
    verticalTitle: string | null;
    verticalVersion: number | null;
    verticalEnabledCapabilities: string[];
    verticalMissingCapabilities: string[];
    verticalOperatingFlows: string[];
    verticalAttentionSignals: string[];
    capabilities: Array<{ key: string; enabled: boolean }>;
    appliedAt: string;
  }> {
    return this.database.withTenantTransaction(context, async (client) => {
      const profile = await client.query<{
        profile_code: "GENERAL" | "TRADE" | "ECOMMERCE" | "SERVICE" | "WAREHOUSE_3PL";
        applied_at: Date;
      }>(
        `SELECT profile_code,applied_at
         FROM tenant_business_profile
         WHERE tenant_id=$1`,
        [context.tenantId]
      );

      const capabilities = await client.query<{
        capability_key: string;
        enabled: boolean;
      }>(
        `SELECT capability_key,enabled
         FROM capability_toggle
         WHERE tenant_id=$1
         ORDER BY capability_key`,
        [context.tenantId]
      );

      const vertical = await client.query<{
        vertical_code: string;
        template_version: number;
      }>(
        `SELECT vertical_code,template_version
         FROM tenant_business_vertical
         WHERE tenant_id=$1`,
        [context.tenantId]
      );

      const row = profile.rows[0];
      const verticalRow = vertical.rows[0] ?? null;
      const verticalTemplate = verticalRow
        ? BUSINESS_VERTICALS[
            verticalRow.vertical_code as BusinessVerticalCode
          ] ?? null
        : null;
      const capabilityMap = new Map(
        capabilities.rows.map((item) => [item.capability_key, item.enabled])
      );
      const verticalEnabledCapabilities =
        verticalTemplate?.enabledCapabilities ?? [];
      const verticalMissingCapabilities = verticalEnabledCapabilities.filter(
        (key) => capabilityMap.get(key) !== true
      );

      return {
        profileCode: row?.profile_code ?? "GENERAL",
        verticalCode: verticalRow?.vertical_code ?? null,
        verticalTitle:
          verticalTemplate?.title ??
          (verticalRow?.vertical_code ?? null),
        verticalVersion: verticalRow?.template_version ?? null,
        verticalEnabledCapabilities,
        verticalMissingCapabilities,
        verticalOperatingFlows: verticalTemplate?.operatingFlows ?? [],
        verticalAttentionSignals: verticalTemplate?.attentionSignals ?? [],
        appliedAt: (row?.applied_at ?? new Date()).toISOString(),
        capabilities: capabilities.rows.map((item) => ({
          key: item.capability_key,
          enabled: item.enabled
        }))
      };
    });
  }

  async applyBusinessProfile(
    context: TenantContext,
    profileInput: string
  ): Promise<{
    profileCode: string;
    enabled: string[];
    disabled: string[];
  }> {
    const profile = profileInput.trim().toUpperCase();
    const allowed = new Set([
      "GENERAL","TRADE","ECOMMERCE","SERVICE","WAREHOUSE_3PL"
    ]);
    if (!allowed.has(profile)) {
      throw new BadRequestException("Неизвестный профиль бизнеса");
    }

    const controlled = [...BUSINESS_CAPABILITIES];

    const presets: Record<string, Set<string>> = {
      GENERAL: new Set(controlled),
      TRADE: new Set([
        "crm","tasks","catalog","sales","procurement","inventory","finance","accounting",
        "growth","workflow","support"
      ]),
      ECOMMERCE: new Set([
        "crm","tasks","catalog","sales","procurement","inventory","finance","accounting",
        "channels","oms","sites","growth","workflow","support"
      ]),
      SERVICE: new Set([
        "crm","tasks","catalog","sales","procurement","inventory","finance","accounting",
        "service","sites","growth","workflow","support"
      ]),
      WAREHOUSE_3PL: new Set([
        "tasks","catalog","sales","procurement","inventory","finance","accounting",
        "oms","wms","workflow","support"
      ])
    };

    const enabled = presets[profile]!;
    const disabled = controlled.filter((key) => !enabled.has(key));

    await this.database.withTenantTransaction(context, async (client) => {
      await client.query(
        `INSERT INTO tenant_business_profile(
           tenant_id,profile_code,applied_at,updated_by_membership_id,updated_at
         ) VALUES ($1,$2,now(),$3,now())
         ON CONFLICT (tenant_id)
         DO UPDATE SET
           profile_code=EXCLUDED.profile_code,
           applied_at=now(),
           updated_by_membership_id=EXCLUDED.updated_by_membership_id,
           updated_at=now()`,
        [context.tenantId, profile, context.membershipId]
      );

      for (const key of controlled) {
        await client.query(
          `INSERT INTO capability_toggle(
             tenant_id,capability_key,enabled,updated_by_membership_id
           ) VALUES ($1,$2,$3,$4)
           ON CONFLICT (tenant_id,capability_key)
           DO UPDATE SET
             enabled=EXCLUDED.enabled,
             updated_by_membership_id=EXCLUDED.updated_by_membership_id,
             updated_at=now()`,
          [
            context.tenantId,
            key,
            enabled.has(key),
            context.membershipId
          ]
        );
      }

      await this.audit(
        client,
        context,
        "customization.business_profile_applied",
        "tenant_business_profile",
        context.tenantId,
        {
          profileCode: profile,
          enabled: Array.from(enabled),
          disabled
        }
      );
    });

    return {
      profileCode: profile,
      enabled: Array.from(enabled),
      disabled
    };
  }

  async capabilities(context: TenantContext): Promise<Array<{
    key: string;
    enabled: boolean;
  }>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{
        capability_key: string;
        enabled: boolean;
      }>(
        `SELECT capability_key, enabled
         FROM capability_toggle
         WHERE tenant_id = $1
         ORDER BY capability_key`,
        [context.tenantId]
      );

      return result.rows.map((row) => ({
        key: row.capability_key,
        enabled: row.enabled
      }));
    });
  }

  async setCapability(
    context: TenantContext,
    keyInput: string,
    enabled: boolean
  ): Promise<void> {
    const key = keyInput.trim().toLowerCase();

    if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(key)) {
      throw new BadRequestException("Некорректный capability key");
    }

    await this.database.withTenantTransaction(context, async (client) => {
      await client.query(
        `INSERT INTO capability_toggle(
           tenant_id, capability_key, enabled, updated_by_membership_id
         ) VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, capability_key)
         DO UPDATE SET
           enabled = EXCLUDED.enabled,
           updated_by_membership_id = EXCLUDED.updated_by_membership_id,
           updated_at = now()`,
        [context.tenantId, key, enabled, context.membershipId]
      );

      await this.audit(
        client,
        context,
        "customization.capability_changed",
        "capability_toggle",
        key,
        { enabled }
      );
    });
  }

  async createCustomRole(
    context: TenantContext,
    nameInput: string
  ): Promise<{ id: string; code: string; name: string }> {
    const name = nameInput.trim();
    if (name.length < 2 || name.length > 120) {
      throw new BadRequestException("Некорректное название роли");
    }

    const code =
      "CUSTOM_" + randomBytes(6).toString("hex").toUpperCase();

    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{
        id: string;
        code: string;
        name: string;
      }>(
        `INSERT INTO tenant_role(
           tenant_id, code, name, is_system
         ) VALUES ($1,$2,$3,false)
         RETURNING id, code, name`,
        [context.tenantId, code, name]
      );

      return result.rows[0]!;
    });
  }

  async setCustomRolePermissions(
    context: TenantContext,
    roleId: string,
    permissions: Array<{
      code: string;
      scope: PermissionScope;
    }>
  ): Promise<void> {
    await this.database.withTenantTransaction(context, async (client) => {
      const role = await client.query<{ is_system: boolean }>(
        `SELECT is_system
         FROM tenant_role
         WHERE tenant_id = $1 AND id = $2
         FOR UPDATE`,
        [context.tenantId, roleId]
      );

      const roleRow = role.rows[0];
      if (!roleRow) throw new NotFoundException("Роль не найдена");
      if (roleRow.is_system) {
        throw new BadRequestException("Системную роль нельзя изменять");
      }

      const allowedResult = await client.query<{ permission_code: string }>(
        `SELECT DISTINCT permission_code
         FROM role_permission
         WHERE tenant_id = $1
           AND permission_code <> '*'`,
        [context.tenantId]
      );

      const allowed = new Set(
        allowedResult.rows.map((row) => row.permission_code)
      );

      for (const permission of permissions) {
        if (!allowed.has(permission.code)) {
          throw new BadRequestException(
            "Неизвестное право: " + permission.code
          );
        }
      }

      await client.query(
        `DELETE FROM role_permission
         WHERE tenant_id = $1 AND role_id = $2`,
        [context.tenantId, roleId]
      );

      for (const permission of permissions) {
        await client.query(
          `INSERT INTO role_permission(
             tenant_id, role_id, permission_code, scope
           ) VALUES ($1,$2,$3,$4)`,
          [
            context.tenantId,
            roleId,
            permission.code,
            permission.scope
          ]
        );
      }

      await this.audit(
        client,
        context,
        "customization.role_permissions_changed",
        "tenant_role",
        roleId,
        { permissions }
      );
    });
  }

  private normalizeEntityType(value: unknown): EntityType {
    const normalized = String(value ?? "").trim().toUpperCase();
    const allowed: EntityType[] = [
      "DEAL",
      "PARTY",
      "PRODUCT",
      "SALES_ORDER",
      "PURCHASE_ORDER"
    ];
    if (!allowed.includes(normalized as EntityType)) {
      throw new BadRequestException("Неизвестный тип сущности");
    }
    return normalized as EntityType;
  }

  private normalizeFieldType(value: unknown): FieldType {
    const normalized = String(value ?? "").trim().toUpperCase();
    const allowed: FieldType[] = [
      "TEXT",
      "NUMBER",
      "DATE",
      "BOOLEAN",
      "SELECT",
      "MULTISELECT"
    ];
    if (!allowed.includes(normalized as FieldType)) {
      throw new BadRequestException("Неизвестный тип custom-поля");
    }
    return normalized as FieldType;
  }

  private validateValue(
    type: FieldType,
    optionsInput: unknown,
    value: unknown
  ): unknown {
    const options = Array.isArray(optionsInput)
      ? optionsInput.map(String)
      : [];

    if (value === null || value === undefined || value === "") return null;

    if (type === "TEXT") return String(value);

    if (type === "NUMBER") {
      const number = Number(value);
      if (!Number.isFinite(number)) {
        throw new BadRequestException("Ожидалось число");
      }
      return number;
    }

    if (type === "BOOLEAN") {
      if (typeof value !== "boolean") {
        throw new BadRequestException("Ожидалось логическое значение");
      }
      return value;
    }

    if (type === "DATE") {
      const date = new Date(String(value));
      if (Number.isNaN(date.getTime())) {
        throw new BadRequestException("Некорректная дата");
      }
      return date.toISOString();
    }

    if (type === "SELECT") {
      const selected = String(value);
      if (!options.includes(selected)) {
        throw new BadRequestException("Значение отсутствует в списке");
      }
      return selected;
    }

    if (!Array.isArray(value)) {
      throw new BadRequestException("Ожидался список значений");
    }

    const selected = value.map(String);
    if (selected.some((item) => !options.includes(item))) {
      throw new BadRequestException("Список содержит недопустимое значение");
    }

    return selected;
  }

  private async entityScopeMembershipIds(
    context: TenantContext,
    type: EntityType,
    mode: "read" | "write"
  ): Promise<string[] | null> {
    const permissions: Record<EntityType, { read: string; write: string }> = {
      DEAL: { read: "crm.read", write: "crm.write" },
      PARTY: { read: "crm.read", write: "crm.write" },
      PRODUCT: { read: "catalog.read", write: "catalog.write" },
      SALES_ORDER: { read: "sales.read", write: "sales.write" },
      PURCHASE_ORDER: {
        read: "procurement.read",
        write: "procurement.write"
      }
    };

    const scope = await this.authorization.resolveScope(
      context,
      permissions[type][mode]
    );
    if (!scope) throw new ForbiddenException("Недостаточно прав");

    // Product currently has no responsible/owner dimension. A granted catalog
    // permission therefore applies to the tenant catalog as a whole.
    if (type === "PRODUCT") return null;

    return this.authorization.membershipIdsForScope(context, scope);
  }

  private async assertEntity(
    client: PoolClient,
    tenantId: string,
    type: EntityType,
    entityId: string,
    scopedMembershipIds: string[] | null
  ): Promise<void> {
    const queries: Record<EntityType, string> = {
      DEAL:
        "SELECT 1 FROM crm_deal WHERE tenant_id=$1 AND id=$2 " +
        "AND ($3::uuid[] IS NULL OR responsible_membership_id = ANY($3::uuid[]))",
      PARTY:
        "SELECT 1 FROM party WHERE tenant_id=$1 AND id=$2 " +
        "AND ($3::uuid[] IS NULL OR responsible_membership_id = ANY($3::uuid[]))",
      PRODUCT:
        "SELECT 1 FROM product WHERE tenant_id=$1 AND id=$2 " +
        "AND ($3::uuid[] IS NULL OR true)",
      SALES_ORDER:
        "SELECT 1 FROM sales_order WHERE tenant_id=$1 AND id=$2 " +
        "AND ($3::uuid[] IS NULL OR responsible_membership_id = ANY($3::uuid[]))",
      PURCHASE_ORDER:
        "SELECT 1 FROM purchase_order WHERE tenant_id=$1 AND id=$2 " +
        "AND ($3::uuid[] IS NULL OR responsible_membership_id = ANY($3::uuid[]))"
    };

    const result = await client.query(
      queries[type],
      [tenantId, entityId, scopedMembershipIds]
    );
    if (!result.rowCount) {
      throw new NotFoundException("Объект для custom-полей не найден");
    }
  }

  private async audit(
    client: PoolClient,
    context: TenantContext,
    action: string,
    resourceType: string,
    resourceId: string,
    data?: Record<string, unknown>
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_event(
         tenant_id, actor_user_id, actor_membership_id,
         action, resource_type, resource_id, after_data
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        context.tenantId,
        context.userId,
        context.membershipId,
        action,
        resourceType,
        resourceId,
        data ? JSON.stringify(data) : null
      ]
    );
  }

  private isUniqueViolation(error: unknown): boolean {
    return Boolean(
      error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "23505"
    );
  }
}
