import {
  BadRequestException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { createHash, randomUUID } from "node:crypto";
import * as ExcelJS from "exceljs";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service";

type EntityType = "PRODUCTS" | "CUSTOMERS";
type SourceRow = Record<string, string>;

const PRODUCT_ALIASES: Record<string, string[]> = {
  name: ["name", "название", "товар", "product", "product name", "наименование"],
  sku: ["sku", "артикул", "код", "код товара", "vendor code"],
  barcode: ["barcode", "штрихкод", "штрих-код", "ean"],
  salePrice: ["price", "цена", "цена продажи", "sale price", "розничная цена"],
  costPrice: ["cost", "себестоимость", "закупочная цена", "cost price"]
};

const CUSTOMER_ALIASES: Record<string, string[]> = {
  displayName: ["name", "название", "клиент", "фио", "company", "компания", "контрагент"],
  email: ["email", "e-mail", "почта", "электронная почта"],
  phone: ["phone", "телефон", "mobile", "мобильный"],
  type: ["type", "тип", "вид"]
};

@Injectable()
export class MigrationService {
  constructor(private readonly database: DatabaseService) {}

  async ingest(
    context: TenantContext,
    input: {
      entityType: EntityType;
      filename: string;
      contentBase64: string;
      idempotencyKey: string;
    }
  ): Promise<Record<string, unknown>> {
    if (!input.idempotencyKey?.trim()) {
      throw new BadRequestException("Требуется ключ идемпотентности");
    }
    if (!input.filename?.trim()) {
      throw new BadRequestException("Не указано имя файла");
    }
    if (!input.contentBase64 || input.contentBase64.length > 20_000_000) {
      throw new BadRequestException("Файл пустой или слишком большой");
    }

    const buffer = Buffer.from(input.contentBase64, "base64");
    if (!buffer.length || buffer.length > 15_000_000) {
      throw new BadRequestException("Файл пустой или превышает лимит 15 МБ");
    }

    const filename = input.filename.trim();
    const ext = filename.toLowerCase().split(".").pop();
    const sourceType = ext === "csv" ? "CSV" : ext === "xlsx" ? "XLSX" : null;
    if (!sourceType) {
      throw new BadRequestException("Поддерживаются только CSV и XLSX");
    }

    const checksum = createHash("sha256").update(buffer).digest("hex");

    return this.database.withTenantTransaction(context, async (client) => {
      const existing = await client.query(
        "SELECT id, status, row_count, valid_count, error_count, mapping " +
        "FROM migration_batch WHERE tenant_id = $1 AND idempotency_key = $2",
        [context.tenantId, input.idempotencyKey.trim()]
      );

      if (existing.rows[0]) {
        return this.batchSummary(existing.rows[0], true);
      }

      const duplicate = await client.query(
        "SELECT id, status, row_count, valid_count, error_count, mapping " +
        "FROM migration_batch WHERE tenant_id = $1 AND entity_type = $2 " +
        "AND checksum = $3 AND status IN ('VALIDATED','IMPORTED','RECONCILED') " +
        "ORDER BY created_at DESC LIMIT 1",
        [context.tenantId, input.entityType, checksum]
      );

      if (duplicate.rows[0]) {
        return this.batchSummary(duplicate.rows[0], true);
      }

      const rows = sourceType === "CSV"
        ? this.parseCsv(buffer.toString("utf8"))
        : await this.parseXlsx(buffer);

      if (!rows.length) {
        throw new BadRequestException("В файле нет строк данных");
      }
      if (rows.length > 50_000) {
        throw new BadRequestException("В одном batch допускается до 50 000 строк");
      }

      const mapping = this.inferMapping(
        input.entityType,
        Object.keys(rows[0] ?? {})
      );

      const batchResult = await client.query<{ id: string }>(
        "INSERT INTO migration_batch(" +
        "tenant_id, entity_type, source_type, filename, checksum, idempotency_key, " +
        "status, mapping, created_by_membership_id" +
        ") VALUES ($1,$2,$3,$4,$5,$6,'ANALYZED',$7,$8) RETURNING id",
        [
          context.tenantId,
          input.entityType,
          sourceType,
          filename,
          checksum,
          input.idempotencyKey.trim(),
          JSON.stringify(mapping),
          context.membershipId
        ]
      );

      const batch = batchResult.rows[0];
      if (!batch) throw new Error("MIGRATION_BATCH_CREATE_FAILED");

      let validCount = 0;
      let errorCount = 0;

      for (let index = 0; index < rows.length; index += 1) {
        const source = rows[index]!;
        const normalized = this.normalizeRow(input.entityType, source, mapping);
        const errors = this.validateRow(input.entityType, normalized);
        const status = errors.length ? "ERROR" : "VALID";
        const fingerprint = this.fingerprint(input.entityType, normalized);

        if (errors.length) errorCount += 1;
        else validCount += 1;

        await client.query(
          "INSERT INTO migration_row(" +
          "tenant_id, batch_id, row_number, source_data, normalized_data, " +
          "status, errors, fingerprint" +
          ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            context.tenantId,
            batch.id,
            index + 2,
            JSON.stringify(source),
            JSON.stringify(normalized),
            status,
            JSON.stringify(errors),
            fingerprint
          ]
        );
      }

      const summary = {
        rowCount: rows.length,
        validCount,
        errorCount,
        qualityPercent: Math.round((validCount / rows.length) * 10_000) / 100
      };

      await client.query(
        "UPDATE migration_batch SET status = 'VALIDATED', row_count = $3, " +
        "valid_count = $4, error_count = $5, validation_summary = $6, " +
        "updated_at = now() WHERE tenant_id = $1 AND id = $2",
        [
          context.tenantId,
          batch.id,
          rows.length,
          validCount,
          errorCount,
          JSON.stringify(summary)
        ]
      );

      await this.audit(client, context, "migration.batch_validated", batch.id, summary);

      return {
        batchId: batch.id,
        status: "VALIDATED",
        rowCount: rows.length,
        validCount,
        errorCount,
        mapping,
        reused: false
      };
    });
  }

  async preview(
    context: TenantContext,
    batchId: string
  ): Promise<Record<string, unknown>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const batch = await client.query(
        "SELECT id, entity_type, source_type, filename, status, mapping, " +
        "validation_summary, reconciliation_summary, row_count, valid_count, " +
        "error_count, imported_count FROM migration_batch " +
        "WHERE tenant_id = $1 AND id = $2",
        [context.tenantId, batchId]
      );

      if (!batch.rows[0]) {
        throw new NotFoundException("Batch импорта не найден");
      }

      const rows = await client.query(
        "SELECT id, row_number, normalized_data, status, errors, target_id " +
        "FROM migration_row WHERE tenant_id = $1 AND batch_id = $2 " +
        "ORDER BY row_number LIMIT 200",
        [context.tenantId, batchId]
      );

      return {
        batch: batch.rows[0],
        rows: rows.rows
      };
    });
  }

  async importBatch(
    context: TenantContext,
    batchId: string
  ): Promise<Record<string, unknown>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const batchResult = await client.query<{
        id: string;
        entity_type: EntityType;
        status: string;
        valid_count: number;
        error_count: number;
      }>(
        "SELECT id, entity_type, status, valid_count, error_count " +
        "FROM migration_batch WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [context.tenantId, batchId]
      );

      const batch = batchResult.rows[0];
      if (!batch) throw new NotFoundException("Batch импорта не найден");

      const rows = await client.query<{
        id: string;
        normalized_data: Record<string, string>;
        status: string;
      }>(
        "SELECT id, normalized_data, status FROM migration_row " +
        "WHERE tenant_id = $1 AND batch_id = $2 " +
        "AND status IN ('VALID','IMPORTED','SKIPPED') " +
        "ORDER BY row_number FOR UPDATE",
        [context.tenantId, batchId]
      );

      let imported = 0;
      let skipped = 0;

      for (const row of rows.rows) {
        if (row.status === "IMPORTED") {
          imported += 1;
          continue;
        }
        if (row.status === "SKIPPED") {
          skipped += 1;
          continue;
        }

        const outcome = batch.entity_type === "PRODUCTS"
          ? await this.importProduct(client, context, row.normalized_data)
          : await this.importCustomer(client, context, row.normalized_data);

        await client.query(
          "UPDATE migration_row SET status = $3, target_type = $4, " +
          "target_id = $5, updated_at = now() WHERE tenant_id = $1 AND id = $2",
          [
            context.tenantId,
            row.id,
            outcome.created ? "IMPORTED" : "SKIPPED",
            outcome.targetType,
            outcome.targetId
          ]
        );

        if (outcome.created) imported += 1;
        else skipped += 1;
      }

      const reconciliation = {
        sourceRows: batch.valid_count + batch.error_count,
        validRows: batch.valid_count,
        importedRows: imported,
        skippedDuplicates: skipped,
        errorRows: batch.error_count,
        balanced: imported + skipped === batch.valid_count
      };

      await client.query(
        "UPDATE migration_batch SET status = 'RECONCILED', imported_count = $3, " +
        "reconciliation_summary = $4, updated_at = now() " +
        "WHERE tenant_id = $1 AND id = $2",
        [context.tenantId, batchId, imported, JSON.stringify(reconciliation)]
      );

      await this.audit(
        client,
        context,
        "migration.batch_reconciled",
        batchId,
        reconciliation
      );

      return {
        batchId,
        imported,
        skipped,
        errors: batch.error_count,
        status: "RECONCILED",
        reconciliation
      };
    });
  }

  async updateOnboarding(
    context: TenantContext,
    input: {
      businessKind?: string;
      companySize?: string;
      salesChannels?: string[];
      capabilities?: string[];
      migrationSource?: string;
      completed?: boolean;
    }
  ): Promise<void> {
    await this.database.withTenantTransaction(context, async (client) => {
      await client.query(
        "INSERT INTO onboarding_state(" +
        "tenant_id, business_kind, company_size, sales_channels, capabilities, " +
        "migration_source, completed_at, updated_at" +
        ") VALUES ($1,$2,$3,$4,$5,$6,$7,now()) " +
        "ON CONFLICT (tenant_id) DO UPDATE SET " +
        "business_kind = COALESCE(EXCLUDED.business_kind, onboarding_state.business_kind), " +
        "company_size = COALESCE(EXCLUDED.company_size, onboarding_state.company_size), " +
        "sales_channels = CASE WHEN $4::jsonb = '[]'::jsonb " +
        "THEN onboarding_state.sales_channels ELSE $4::jsonb END, " +
        "capabilities = CASE WHEN $5::jsonb = '[]'::jsonb " +
        "THEN onboarding_state.capabilities ELSE $5::jsonb END, " +
        "migration_source = COALESCE(EXCLUDED.migration_source, onboarding_state.migration_source), " +
        "completed_at = COALESCE(EXCLUDED.completed_at, onboarding_state.completed_at), " +
        "updated_at = now()",
        [
          context.tenantId,
          input.businessKind?.trim() || null,
          input.companySize?.trim() || null,
          JSON.stringify(input.salesChannels ?? []),
          JSON.stringify(input.capabilities ?? []),
          input.migrationSource?.trim() || null,
          input.completed ? new Date() : null
        ]
      );
    });
  }

  private batchSummary(row: any, reused: boolean): Record<string, unknown> {
    return {
      batchId: row.id,
      status: row.status,
      rowCount: row.row_count,
      validCount: row.valid_count,
      errorCount: row.error_count,
      mapping: row.mapping,
      reused
    };
  }

  private inferMapping(
    entityType: EntityType,
    headers: string[]
  ): Record<string, string> {
    const aliases = entityType === "PRODUCTS" ? PRODUCT_ALIASES : CUSTOMER_ALIASES;
    const normalized = headers.map((original) => ({
      original,
      key: this.normalizeHeader(original)
    }));
    const mapping: Record<string, string> = {};

    for (const [target, variants] of Object.entries(aliases)) {
      const match = normalized.find((header) =>
        variants.some((variant) => this.normalizeHeader(variant) === header.key)
      );
      if (match) mapping[target] = match.original;
    }

    return mapping;
  }

  private normalizeRow(
    entityType: EntityType,
    source: SourceRow,
    mapping: Record<string, string>
  ): Record<string, string> {
    const get = (key: string) => {
      const sourceKey = mapping[key];
      return sourceKey ? String(source[sourceKey] ?? "").trim() : "";
    };

    if (entityType === "PRODUCTS") {
      return {
        name: get("name"),
        sku: get("sku"),
        barcode: get("barcode"),
        salePriceMinor: this.moneyToMinor(get("salePrice")),
        costPriceMinor: this.moneyToMinor(get("costPrice"))
      };
    }

    const rawType = get("type").toLowerCase();
    return {
      displayName: get("displayName"),
      email: get("email").toLowerCase(),
      phone: get("phone"),
      type:
        rawType.includes("орг") ||
        rawType.includes("company") ||
        rawType.includes("юр")
          ? "ORGANIZATION"
          : "PERSON"
    };
  }

  private validateRow(
    entityType: EntityType,
    row: Record<string, string>
  ): string[] {
    const errors: string[] = [];

    if (entityType === "PRODUCTS") {
      if (!row.name || row.name.length < 2) errors.push("Не указано название товара");
      if (!/^\d+$/.test(row.salePriceMinor || "0")) errors.push("Некорректная цена продажи");
      if (!/^\d+$/.test(row.costPriceMinor || "0")) errors.push("Некорректная себестоимость");
    } else {
      if (!row.displayName || row.displayName.length < 2) {
        errors.push("Не указано имя/название клиента");
      }
      if (row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) {
        errors.push("Некорректный email");
      }
    }

    return errors;
  }

  private fingerprint(
    entityType: EntityType,
    row: Record<string, string>
  ): string {
    const natural = entityType === "PRODUCTS"
      ? row.sku || row.name
      : row.email || row.phone || row.displayName;

    return createHash("sha256")
      .update(entityType + "|" + String(natural).toLowerCase().trim())
      .digest("hex");
  }

  private async importProduct(
    client: PoolClient,
    context: TenantContext,
    row: Record<string, string>
  ): Promise<{ created: boolean; targetType: string; targetId: string }> {
    if (row.sku) {
      const existing = await client.query<{ product_id: string }>(
        "SELECT v.product_id FROM sku s JOIN product_variant v " +
        "ON v.tenant_id = s.tenant_id AND v.id = s.variant_id " +
        "WHERE s.tenant_id = $1 AND lower(s.code) = lower($2) LIMIT 1",
        [context.tenantId, row.sku]
      );
      if (existing.rows[0]) {
        return {
          created: false,
          targetType: "product",
          targetId: existing.rows[0].product_id
        };
      }
    }

    const product = await client.query<{ id: string }>(
      "INSERT INTO product(tenant_id, name, kind) " +
      "VALUES ($1,$2,'STOCKABLE') RETURNING id",
      [context.tenantId, row.name]
    );
    const productId = product.rows[0]!.id;

    const variant = await client.query<{ id: string }>(
      "INSERT INTO product_variant(tenant_id, product_id, name) " +
      "VALUES ($1,$2,'Основной') RETURNING id",
      [context.tenantId, productId]
    );

    const skuCode = row.sku ||
      "SKU-" + randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();

    await client.query(
      "INSERT INTO sku(tenant_id, variant_id, code, barcode, " +
      "sale_price_minor, cost_price_minor, track_inventory) " +
      "VALUES ($1,$2,$3,$4,$5,$6,true)",
      [
        context.tenantId,
        variant.rows[0]!.id,
        skuCode,
        row.barcode || null,
        row.salePriceMinor || "0",
        row.costPriceMinor || "0"
      ]
    );

    return { created: true, targetType: "product", targetId: productId };
  }

  private async importCustomer(
    client: PoolClient,
    context: TenantContext,
    row: Record<string, string>
  ): Promise<{ created: boolean; targetType: string; targetId: string }> {
    if (row.email) {
      const existingEmail = await client.query<{ party_id: string }>(
        "SELECT party_id FROM party_contact WHERE tenant_id = $1 " +
        "AND type = 'EMAIL' AND lower(value) = lower($2) LIMIT 1",
        [context.tenantId, row.email]
      );
      if (existingEmail.rows[0]) {
        return {
          created: false,
          targetType: "party",
          targetId: existingEmail.rows[0].party_id
        };
      }
    }

    if (row.phone) {
      const existingPhone = await client.query<{ party_id: string }>(
        "SELECT party_id FROM party_contact WHERE tenant_id = $1 " +
        "AND type = 'PHONE' AND value = $2 LIMIT 1",
        [context.tenantId, row.phone]
      );
      if (existingPhone.rows[0]) {
        return {
          created: false,
          targetType: "party",
          targetId: existingPhone.rows[0].party_id
        };
      }
    }

    const party = await client.query<{ id: string }>(
      "INSERT INTO party(tenant_id, type, display_name, responsible_membership_id) " +
      "VALUES ($1,$2,$3,$4) RETURNING id",
      [
        context.tenantId,
        row.type === "ORGANIZATION" ? "ORGANIZATION" : "PERSON",
        row.displayName,
        context.membershipId
      ]
    );
    const partyId = party.rows[0]!.id;

    await client.query(
      "INSERT INTO party_role(tenant_id, party_id, role) VALUES ($1,$2,'CUSTOMER')",
      [context.tenantId, partyId]
    );

    if (row.email) {
      await client.query(
        "INSERT INTO party_contact(tenant_id, party_id, type, value, is_primary) " +
        "VALUES ($1,$2,'EMAIL',$3,true)",
        [context.tenantId, partyId, row.email]
      );
    }
    if (row.phone) {
      await client.query(
        "INSERT INTO party_contact(tenant_id, party_id, type, value, is_primary) " +
        "VALUES ($1,$2,'PHONE',$3,$4)",
        [context.tenantId, partyId, row.phone, !row.email]
      );
    }

    return { created: true, targetType: "party", targetId: partyId };
  }

  private parseCsv(text: string): SourceRow[] {
    const matrix: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let quoted = false;
    const source = text.replace(/^\uFEFF/, "");
    const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
    const delimiterCandidates = [
      { value: ";", count: (firstLine.match(/;/g) ?? []).length },
      { value: "\t", count: (firstLine.match(/\t/g) ?? []).length },
      { value: ",", count: (firstLine.match(/,/g) ?? []).length }
    ].sort((a, b) => b.count - a.count);
    const delimiter = delimiterCandidates[0]?.count
      ? delimiterCandidates[0].value
      : ",";

    for (let index = 0; index < source.length; index += 1) {
      const char = source[index]!;
      if (char === '"') {
        if (quoted && source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
        continue;
      }
      if (!quoted && char === delimiter) {
        row.push(cell.trim());
        cell = "";
        continue;
      }
      if (!quoted && (char === "\n" || char === "\r")) {
        if (char === "\r" && source[index + 1] === "\n") index += 1;
        row.push(cell.trim());
        cell = "";
        if (row.some((value) => value !== "")) matrix.push(row);
        row = [];
        continue;
      }
      cell += char;
    }

    row.push(cell.trim());
    if (row.some((value) => value !== "")) matrix.push(row);
    if (matrix.length < 2) return [];

    const headers = matrix[0]!.map((header, index) =>
      header || "column_" + (index + 1)
    );

    return matrix.slice(1).map((values) => {
      const result: SourceRow = {};
      headers.forEach((header, index) => {
        result[header] = values[index] ?? "";
      });
      return result;
    });
  }

  private async parseXlsx(buffer: Buffer): Promise<SourceRow[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet || sheet.rowCount < 2) return [];

    const headerRow = sheet.getRow(1);
    const headers: string[] = [];
    for (let column = 1; column <= headerRow.cellCount; column += 1) {
      headers.push(
        this.cellText(headerRow.getCell(column).value) || "column_" + column
      );
    }

    const rows: SourceRow[] = [];
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const excelRow = sheet.getRow(rowNumber);
      const row: SourceRow = {};
      let hasValue = false;

      headers.forEach((header, index) => {
        const value = this.cellText(excelRow.getCell(index + 1).value);
        row[header] = value;
        if (value) hasValue = true;
      });

      if (hasValue) rows.push(row);
    }

    return rows;
  }

  private cellText(value: ExcelJS.CellValue): string {
    if (value === null || value === undefined) return "";
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "object") {
      if ("result" in value && value.result !== undefined) {
        return String(value.result ?? "").trim();
      }
      if ("text" in value) return String(value.text ?? "").trim();
      if ("richText" in value && Array.isArray(value.richText)) {
        return value.richText.map((part) => part.text).join("").trim();
      }
    }
    return String(value).trim();
  }

  private normalizeHeader(value: string): string {
    return value.trim().toLowerCase().replace(/[._-]+/g, " ").replace(/\s+/g, " ");
  }

  private moneyToMinor(value: string): string {
    if (!value) return "0";
    const normalized = value
      .replace(/\s/g, "")
      .replace(/₽|руб\.?/gi, "")
      .replace(",", ".");
    const number = Number(normalized);
    if (!Number.isFinite(number) || number < 0) return "INVALID";
    return String(Math.round(number * 100));
  }

  private async audit(
    client: PoolClient,
    context: TenantContext,
    action: string,
    batchId: string,
    data: Record<string, unknown>
  ): Promise<void> {
    await client.query(
      "INSERT INTO audit_event(tenant_id, actor_user_id, actor_membership_id, " +
      "action, resource_type, resource_id, after_data) " +
      "VALUES ($1,$2,$3,$4,'migration_batch',$5,$6)",
      [
        context.tenantId,
        context.userId,
        context.membershipId,
        action,
        batchId,
        JSON.stringify(data)
      ]
    );
  }
}
