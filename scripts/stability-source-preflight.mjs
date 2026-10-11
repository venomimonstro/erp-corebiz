#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const findings = [  {
    path: "apps/web/components/service-business-setup.tsx",
    patterns: [
      /mode==="dance"/,
      /technology-cards/,
      /delivery-rules/,
      /service\/resources/,
      /ruleBranch/
    ],
    message: "Shared service setup workspace is missing"
  },
];

function add(severity, file, message) {
  findings.push({
    severity,
    file: file ? relative(ROOT, file).split(sep).join("/") : null,
    message
  });
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const output = [];

  for (const entry of entries) {
    if (
      entry.name === "node_modules" ||
      entry.name === ".next" ||
      entry.name === "dist" ||
      entry.name === "coverage"
    ) {
      continue;
    }

    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await walk(path)));
    } else {
      output.push(path);
    }
  }

  return output;
}

function normalize(path) {
  return relative(ROOT, path).split(sep).join("/");
}

function inspectAppModule(file, source) {
  const imports = Array.from(
    source.matchAll(/^import\s+\{\s*([A-Za-z0-9_]+)\s*\}\s+from\s+/gm),
    (match) => match[1]
  );
  const duplicateImports = imports.filter(
    (name, index) => imports.indexOf(name) !== index
  );

  for (const name of new Set(duplicateImports)) {
    add("BLOCK", file, "duplicate AppModule import: " + name);
  }

  const importsArray = source.match(/imports\s*:\s*\[([\s\S]*?)\]\s*,\s*providers/);
  if (!importsArray) {
    add("BLOCK", file, "AppModule imports array could not be inspected");
    return;
  }

  const names = Array.from(
    importsArray[1].matchAll(/\b([A-Za-z][A-Za-z0-9_]*Module)\b/g),
    (match) => match[1]
  );
  const duplicates = names.filter(
    (name, index) => names.indexOf(name) !== index
  );

  for (const name of new Set(duplicates)) {
    add("BLOCK", file, "duplicate module in AppModule imports: " + name);
  }
}

function inspectController(file, source) {
  if (/DatabaseService/.test(source)) {
    add(
      "BLOCK",
      file,
      "controller imports/uses DatabaseService; controllers must call application/domain services"
    );
  }
  if (/\bfrom\s+["']pg["']/.test(source)) {
    add(
      "BLOCK",
      file,
      "controller imports pg directly"
    );
  }

  const publicMutations = Array.from(
    source.matchAll(
      /@Public\(\)[\s\S]{0,240}?@(Post|Put|Patch|Delete)\(([^\n]*)/g
    )
  );

  for (const match of publicMutations) {
    add(
      "WARN",
      file,
      "public mutating endpoint requires explicit rate-limit/idempotency review: @" +
        match[1] +
        "(" +
        match[2].trim() +
        ")"
    );
  }
}

function inspectWeb(file, source) {
  if (/dangerouslySetInnerHTML/.test(source)) {
    add(
      "BLOCK",
      file,
      "dangerouslySetInnerHTML is forbidden in product UI/public renderer"
    );
  }

  const exposedSecrets = Array.from(
    source.matchAll(
      /NEXT_PUBLIC_[A-Z0-9_]*(?:SECRET|PASSWORD|PRIVATE_KEY|API_KEY|TOKEN)[A-Z0-9_]*/g
    ),
    (match) => match[0]
  );

  for (const name of new Set(exposedSecrets)) {
    add(
      "BLOCK",
      file,
      "sensitive environment variable exposed to browser: " + name
    );
  }

  const localSensitive = Array.from(
    source.matchAll(
      /localStorage\.setItem\(\s*["'][^"']*(?:token|secret|password|session|api[_-]?key)[^"']*["']/gi
    )
  );

  if (localSensitive.length) {
    add(
      "BLOCK",
      file,
      "sensitive credential/session-like value persisted to localStorage"
    );
  }
}

function inspectBusinessBoundaries(file, source) {
  const path = normalize(file);

  if (
    /\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+inventory_balance\b/i.test(
      source
    ) &&
    !path.includes("/business/inventory/") &&
    !path.includes("/business/wms/")
  ) {
    add(
      "BLOCK",
      file,
      "inventory_balance mutation outside Inventory/WMS bounded contexts"
    );
  }

  if (
    /\bINSERT\s+INTO\s+accounting_entry\b/i.test(source) &&
    !path.includes("/business/accounting/")
  ) {
    add(
      "BLOCK",
      file,
      "accounting_entry creation outside Accounting bounded context"
    );
  }

  if (
    /\bUPDATE\s+accounting_entry\b/i.test(source) &&
    !path.includes("/business/accounting/")
  ) {
    add(
      "BLOCK",
      file,
      "accounting_entry mutation outside Accounting bounded context"
    );
  }
}

async function inspectRequiredHardening(root) {
  const required = [
    {
      path: "apps/api/src/modules/platform/payments/commerce-payments.service.ts",
      patterns: [/verifyAmount\(intent,payment\)/,
        /finance\.receiveSalesPayment/, /finance\.refundSalesPayment/,
        /corebiz_resolve_payment_tenant/, /corebiz_resolve_refund_tenant/,
        /sealMerchantSecret/, /commerce_order_delivery/,
        /COREBIZ_SAAS_FISCAL_ENABLED/],
      message: "Verified acquiring or refund ledger reconciliation is missing"
    },
    {
      path: "apps/api/src/modules/platform/payments/yookassa.gateway.ts",
      patterns: [/api\.yookassa\.ru\/v3/, /aes-256-gcm/,
        /Idempotence-Key/, /AbortController/],
      message: "Fixed-origin payment transport, encryption or retries are missing"
    },
    {
      path: "apps/api/src/modules/platform/payments/payments.controller.ts",
      patterns: [/@RequirePermission\("billing.manage"\)/,
        /@RequirePermission\("finance.write"\)/,
        /@ApiCost\("PUBLIC_CHECKOUT"\)/, /webhooks\/yookassa/],
      message: "Missing protected payment and provider callback routes"
    },
    {
      path: "infrastructure/postgres/227_commerce_checkout_payments_shipping.sql",
      patterns: [/commerce_payment_intent/, /commerce_merchant_config/,
        /commerce_order_delivery/, /ENABLE ROW LEVEL SECURITY/,
        /corebiz_resolve_payment_tenant/],
      message: "Tenant-isolated payment intent and delivery tables missing"
    },
    {
      path: "apps/api/src/modules/platform/billing/billing.service.ts",
      patterns: [/BigInt\(row\.monthly_price_minor\) > 0n/, /ConflictException/,
        /current_plan_code === row.code/],
      message: "Unpaid SaaS self-service upgrades are not blocked"
    },
    {
      path: "apps/api/src/modules/business/sites/storefront.service.ts",
      patterns: [/COALESCE\(ip.enabled,true\)/,
        /w.status='ACTIVE'/, /is_available !== true/,
        /p.slug='\/' AND p.status='ACTIVE' AND v.status='PUBLISHED'/],
      message: "Storefront availability or pre-checkout publication guard is missing"
    },
    {
      path: "apps/api/src/modules/business/sites/storefront.controller.ts",
      patterns: [/@ApiCost\("PUBLIC_CHECKOUT"\)/, /@ApiCost\("PUBLIC_CART"\)/],
      message: "Anonymous commerce is not protected by specific budgets"
    },
    {
      path: "apps/web/components/public-storefront.tsx",
      patterns: [/current.status === "PROCESSING"/,
        /cart.status !== "OPEN"/, /line.is_available/],
      message: "Buyer recovery after interrupted checkout is incomplete"
    },
    {
      path: "infrastructure/postgres/226_public_storefront_publication_gate.sql",
      patterns: [/corebiz_resolve_public_storefront/,
        /v.status='PUBLISHED'/, /SECURITY DEFINER/],
      message: "Draft storefront is publicly available"
    },
    {
      path: "scripts/production-gate.sh",
      patterns: [/COREBIZ_SMOKE_BASE_URL COREBIZ_SMOKE_WEB_URL/,
        /loopback staging instance/],
      message: "Business smoke tests may target public production URLs"
    },
    {
      path: "apps/api/src/modules/business/party/party.service.ts",
      patterns: [
        /party_create_idempotency/,
        /pg_advisory_xact_lock/,
        /idempotencyKey/
      ],
      message: "Party crash-safe idempotency is not fully wired"
    },
    {
      path: "apps/api/src/modules/business/sites/storefront.service.ts",
      patterns: [/storefront-party:/],
      message: "Storefront checkout does not use idempotent Party creation"
    },
    {
      path: "apps/api/src/modules/business/sites/site-forms.service.ts",
      patterns: [/site-submission-party:/],
      message: "Public site submissions do not use idempotent Party creation"
    },
    {
      path: "apps/api/src/modules/business/search/global-search.service.ts",
      patterns: [/runtime\.acquire/, /global_search/, /runtime\.release/],
      message: "Global search runtime concurrency budget is not enforced"
    },
    {
      path: "apps/api/src/modules/business/assistant/owner-assistant.service.ts",
      patterns: [/runtime\.acquire/, /owner_assistant_brief/, /runtime\.release/],
      message: "Owner assistant runtime concurrency budget is not enforced"
    },
    {
      path: "apps/api/src/modules/platform/data-management/data-management.service.ts",
      patterns: [/runtime\.deny/, /tenant_export/],
      message: "Tenant export runtime budget is not enforced"
    },
    {
      path: "apps/api/src/modules/platform/authorization/capability.guard.ts",
      patterns: [/capability_toggle/, /PERMISSION_CAPABILITY/, /enabled !== false/],
      message: "Disabled business capabilities are not enforced on API routes"
    },
    {
      path: "apps/api/src/modules/business/projects/projects.service.ts",
      patterns: [/projects\.read/, /projects\.write/, /membershipIdsForScope/, /source_deal_id/],
      message: "Project scope or deal-conversion hardening is missing"
    },
    {
      path: "apps/api/src/modules/platform/customization/customization.service.ts",
      patterns: [/entityScopeMembershipIds/, /normalizeEntityType/, /responsible_membership_id = ANY/],
      message: "Custom-field entity access is not permission/scope guarded"
    },
    {
      path: "apps/api/src/modules/business/sales/sales.service.ts",
      patterns: [/scopedMembershipIds/, /party_commercial_terms/, /responsible_membership_id = ANY/],
      message: "B2B commercial terms are not sales-scope guarded"
    },
    {
      path: "apps/api/src/modules/business/accounting/accounting.service.ts",
      patterns: [
        /saveTaxProfile/,
        /buildComplianceCalendar/,
        /prepareCompliancePacket/,
        /complianceTransition/,
        /accounting_compliance_obligation/
      ],
      message: "Russian tax compliance workflow is not fully wired"
    },
    {
      path: "apps/web/app/app/accounting/taxes/page.tsx",
      patterns: [
        /Налоги и ФНС/,
        /Налоговый профиль/,
        /Подготовить/,
        /Принято ФНС/
      ],
      message: "Owner tax compliance workspace is missing"
    },
    {
      path: "apps/api/src/modules/business/accounting/compliance.service.ts",
      patterns: [
        /complianceEnabled/,
        /compliance_enabled===false/,
        /Налоговый контур выключен/
      ],
      message: "Optional regulated accounting contour is incomplete"
    },
    {
      path: "apps/api/src/modules/business/automotive/automotive.service.ts",
      patterns: [
        /automotive_work_order/,
        /automotive_donor_vehicle/,
        /automotive_dismantled_part/,
        /updateWorkOrder/,
        /updateWorkOrderLine/,
        /compatibleParts/,
        /linkPartToInventory/
      ],
      message: "Automotive operational backend is incomplete"
    },
    {
      path: "apps/web/app/app/automotive/page.tsx",
      patterns: [
        /Автосервис и авторазбор/,
        /Заказ-наряды/,
        /Авторазбор/,
        /Деньги в донорах/
      ],
      message: "Automotive owner workspace is incomplete"
    },
    {
      path: "apps/api/src/modules/platform/customization/business-verticals.ts",
      patterns: [
        /AUTO_SERVICE/,
        /AUTO_PARTS_DISMANTLING/,
        /Автозапчасти \/ авторазбор/
      ],
      message: "Automotive vertical templates are incomplete"
    },
    {
      path: "apps/api/src/modules/business/service-ops/booking.service.ts",
      patterns: [
        /serviceScope/,
        /assertBookingAccess/,
        /assertResourceScope/,
        /requireServiceAll/,
        /SERVICE_BOOKING_CHARGE/,
        /ensureBookingChargeTx/,
        /cancelBookingChargeTx/
      ],
      message: "Service booking/catalog/billing hardening is missing"
    },
    {
      path: "apps/api/src/modules/business/service-ops/service-workspace.service.ts",
      patterns: [/serviceScope/, /assertBookingAccess/, /membership_id = ANY/],
      message: "Service workspace scope enforcement is missing"
    },
    {
      path: "apps/api/src/modules/business/service-ops/resources.service.ts",
      patterns: [/serviceScope/, /assertResource/, /membership_id = ANY/],
      message: "Service resource scope enforcement is missing"
    },
    {
      path: "apps/api/src/modules/platform/customization/customization.service.ts",
      patterns: [/BUSINESS_CAPABILITIES as readonly string\[\]/, /seenPermissions/, /customization\.manage/],
      message: "Customization capability/role/shared-view validation is missing"
    },
    {
      path: "apps/api/src/modules/business/sales/sales.service.ts",
      patterns: [/orderIdempotencyFingerprint/, /pg_advisory_xact_lock/, /idempotency_fingerprint/],
      message: "Sales-order strict idempotency hardening is missing"
    },
  {
    path: "apps/api/src/modules/business/dance-studio/dance-studio.service.ts",
    patterns: [
      /syncGroupRosterToLesson/,
      /promoteLessonWaitlistTx/,
      /service_package_entitlement/,
      /activation_policy_snapshot/,
      /resolveDanceDeliveryRule/,
      /updateGroup/,
      /room_zone_id/,
      /room_capacity_units/,
      /SELF_PRACTICE/
    ],
    message: "Dance studio operational hardening is missing"
  },
  {
    path: "apps/api/src/modules/business/dance-studio/dance-economics.service.ts",
    patterns: [
      /trainer_compensation_accrual/,
      /dance_lesson_profitability/,
      /room_rental_contract/,
      /room_rental_statement/,
      /DANCE_ROOM_RENT_STATEMENT/,
      /package_entitlement_id/,
      /trainer_compensation_component/,
      /trainer_payroll_statement/,
      /trainer_payroll_adjustment/,
      /trainer_payroll_profile/,
      /payroll_accrual_component/,
      /addPayrollAdjustment/,
      /payrollProfiles/,
      /MONTHLY_BASE/,
      /DANCE_TRAINER_STATEMENT/,
      /payroll_accrual_component/,
      /payroll_batch_id/,
      /service_booking_material/,
      /payroll_statement_review/,
      /reviewPayrollStatement/,
      /resolvePayrollReview/
    ],
    message: "Dance studio economics hardening is missing"
  },
  {
    path: "apps/api/src/modules/business/finance/finance.service.ts",
    patterns: [
      /receiveAllocatedPayment/,
      /payment_allocation/,
      /allocationFingerprint/
    ],
    message: "Family payment allocation hardening is missing"
  },
  {
    path: "apps/api/src/modules/business/sites/site-forms.service.ts",
    patterns: [
      /DANCE_BOOKING/,
      /danceGroupId/,
      /childBirthDate/,
      /deduplicateContacts/
    ],
    message: "Public dance booking hardening is missing"
  },
  {
    path: "scripts/golden-business-journeys.mjs",
    patterns: [
      /async function serviceJourney/,
      /billing\?\.invoiceNumber/,
      /obligationStatus/,
      /invoiceStatus/,
      /status: "CANCELLED"/
    ],
    message: "Service booking billing golden journey is missing"
  },
  {
    path: "scripts/golden-business-journeys.mjs",
    patterns: [
      /async function automotiveJourney/,
      /AUTO_SERVICE/,
      /automotive\/work-orders/,
      /automotive\/donors/,
      /automotive\/fitments/,
      /compatible-parts/,
      /inventory\/balances/
    ],
    message: "Automotive golden business journey is missing"
  },
  {
    path: "scripts/golden-business-journeys.mjs",
    patterns: [
      /async function danceStudioJourney/,
      /DANCE_FITNESS/,
      /finance\/allocated-payment/,
      /dance\/lessons\//,
      /dance\/payroll-profiles/,
      /DANCE_TRAINER_STATEMENT/,
      /payroll-statements\/.*\/review/,
      /ACKNOWLEDGED/,
      /accounting\/payroll\/batches\//,
      /dance\/room-statements\/finalize/
    ],
    message: "Dance studio golden owner/payroll journey is missing"
  },
  {
    path: "apps/web/app/app/dance/team/page.tsx",
    patterns: [
      /Постоянные условия тренеров/,
      /Правила доплат за работу/,
      /payroll-profiles/,
      /archivePlan/,
      /Зарегистрировать выплату/,
      /approvePayrollBatch/,
      /review_status/,
      /Есть спор/
    ],
    message: "Premium trainer payroll workspace is missing"
  },
  {
    path: "apps/api/src/modules/business/accounting/payroll.service.ts",
    patterns: [
      /async markPaid/,
      /status='PAID'/,
      /payment_reference/,
      /assertNoOpenPayrollDisputes/,
      /review_status='DISPUTED'/
    ],
    message: "Explicit payroll payment lifecycle is missing"
  },
  {
    path: "apps/web/app/app/dance/groups/page.tsx",
    patterns: [
      /lessonRoomZoneId/,
      /lessonRoomCapacityUnits/,
      /roomZoneId/,
      /SELF_PRACTICE/
    ],
    message: "Shared hall and self-practice lesson UX is missing"
  },
  {
    path: "apps/web/components/service-business-setup.tsx",
    patterns: [
      /service\/delivery-rules/,
      /service\/technology-cards/,
      /createTechnologyCard/,
      /inventory\/warehouses/,
      /service\/resources\/.*\/zones/
    ],
    message: "Shared service pricing, technology card, or zone setup UX is missing"
  },
  {
    path: "apps/api/src/modules/business/accounting/compliance.service.ts",
    patterns: [
      /syncTaxLedger/,
      /assignCashAccount/,
      /usnPreview/,
      /preparePacket/,
      /recordProviderSignature/,
      /recordReceipt/,
      /accounting_tax_ledger_item/
    ],
    message: "Owner accounting compliance workflow is incomplete"
  },
  {
    path: "apps/web/components/accounting-compliance-center.tsx",
    patterns: [
      /AccountingComplianceCenter/,
      /Счета этого юрлица/,
      /Расчёт УСН/,
      /Собрать из финансов/,
      /Обновить календарь/,
      /Подготовить пакет/,
      /Подтвердить КЭП/,
      /Зарегистрировать оплату/,
      /Регламентированный контур/,
      /VAT_22/
    ],
    message: "Owner accounting compliance center is incomplete"
  },
  {
    path: "apps/api/src/modules/business/accounting/compliance.service.ts",
    patterns: [
      /complianceLines/,
      /saveComplianceLine/,
      /KND_1110355/,
      /recordProviderSignature/,
      /recordReceipt/
    ],
    message: "Structured FNS compliance flow is incomplete"
  },
  {
    path: "apps/web/components/accounting-compliance-center.tsx",
    patterns: [
      /КНД 1110355/,
      /КБК/,
      /ОКТМО/,
      /Подтвердить КЭП/,
      /Принято ФНС/
    ],
    message: "Owner FNS filing workflow UI is incomplete"
  },
  {
    path: "apps/api/src/modules/business/accounting/compliance.service.ts",
    patterns: [
      /async npdOverview/,
      /registerNpdReceipt/,
      /confirmNpdReceipt/,
      /rebuildNpdMonths/,
      /tax_regime='NPD'/,
      /annual_limit_minor/
    ],
    message: "NPD accounting workflow is incomplete"
  },
  {
    path: "apps/web/app/app/accounting/taxes/page.tsx",
    patterns: [
      /НПД \/ самозанятость/,
      /Мой налог/,
      /Подтвердить чек/,
      /remaining_limit_minor/
    ],
    message: "NPD owner workspace is incomplete"
  },
  {
    path: "apps/api/src/modules/business/crm/crm.service.ts",
    patterns: [
      /dealDetails/,
      /addActivity/,
      /addNote/,
      /createPipeline/,
      /crm_activity/,
      /crm_deal_tag/
    ],
    message: "Advanced CRM workspace is incomplete"
  },
  {
    path: "apps/web/app/app/crm/deals/[id]/page.tsx",
    patterns: [
      /Единая история/,
      /Следующее действие/,
      /Lead score/,
      /createProject/
    ],
    message: "Premium CRM deal workspace is incomplete"
  },
  {
    path: "apps/api/src/modules/business/projects/projects.service.ts",
    patterns: [
      /agencyOverview/,
      /addDeliverable/,
      /requestApproval/,
      /RETAINER/,
      /work_project_client_approval/
    ],
    message: "Agency project workflow is incomplete"
  },
  {
    path: "apps/web/app/app/agency/page.tsx",
    patterns: [
      /Профессиональные услуги/,
      /Клиентский портфель/,
      /Себестоимость команды/,
      /Ждём клиента/
    ],
    message: "Agency owner workspace is incomplete"
  },
  {
    path: "apps/api/src/modules/platform/customization/business-verticals.ts",
    patterns: [
      /WEB_MARKETING_AGENCY/,
      /Веб-студия \/ маркетинговое агентство/,
      /deliverables/,
      /ретейнер/i
    ],
    message: "Web studio and marketing agency vertical is incomplete"
  },
  {
    path: "apps/worker/src/tenant-export.ts",
    patterns: [
      /dance_students/,
      /dance_lessons/,
      /payment_allocations/,
      /trainer_compensation_accruals/,
      /trainer_payroll_profiles/,
      /payroll_accrual_components/,
      /room_rental_statements/,
      /payroll_statement_reviews/,
      /payroll_statement_review_events/,
      /accounting_tax_profiles/,
      /accounting_compliance_obligations/,
      /accounting_tax_calculations/,
      /accounting_compliance_packets/,
      /accounting_tax_payment_classifications/,
      /accounting_tax_ledger_items/,
      /accounting_compliance_lines/,
      /automotive_vehicles/,
      /automotive_work_orders/,
      /automotive_donor_vehicles/,
      /automotive_dismantled_parts/,
      /accounting_npd_receipts/,
      /accounting_npd_months/,
      /crm_activities/,
      /crm_automation_rules/,
      /project_deliverables/,
      /project_client_approvals/
    ],
    message: "Dance studio tenant export coverage is missing"
  }
  ];

  for (const item of required) {
    const file = resolve(root,item.path);
    let source;
    try {
      source = await readFile(file,"utf8");
    } catch {
      add("BLOCK",file,"required hardening source is missing: " + item.path);
      continue;
    }

    if (item.patterns.some((pattern) => !pattern.test(source))) {
      add("BLOCK",file,item.message);
    }
  }

  const requiredMigrations = [
    "136_party_create_idempotency.sql",
    "137_runtime_pressure_leases.sql",
    "148_capability_project_hardening.sql",
    "149_sales_order_idempotency_fingerprint.sql",
    "150_goods_receipt_idempotency.sql",
    "151_dance_studio_core.sql",
    "152_dance_finance_allocations.sql",
    "153_service_package_entitlements.sql",
    "154_dance_capability_permissions.sql",
    "155_package_management_revenue.sql",
    "156_package_family_combo_activation.sql",
    "157_public_dance_booking.sql",
    "158_dance_tenant_integrity.sql",
    "159_dance_makeup_booking.sql",
    "160_dance_makeup_revenue.sql",
    "161_dance_makeup_lifecycle.sql",
    "162_dance_financial_constraints.sql",
    "163_room_rental_statements.sql",
    "164_room_rental_payment_terms.sql",
    "165_room_rental_statement_immutability.sql",
    "166_room_rental_contract_overlap.sql",
    "167_dance_lesson_timezone.sql",
    "168_dance_rule_ambiguity_guards.sql",
    "169_dance_group_waitlist_terms.sql",
    "170_sales_order_package_activation.sql",
    "171_service_delivery_rules.sql",
    "172_shared_resource_capacity.sql",
    "173_package_time_trainer_entitlements.sql",
    "174_composite_trainer_payroll.sql",
    "175_package_entitlement_integrity_v2.sql",
    "176_service_package_scoped_redemption.sql",
    "177_shared_capacity_integrity.sql",
    "178_trainer_payroll_export_lifecycle.sql",
    "179_trainer_payroll_tenant_integrity.sql",
    "179_trainer_payroll_adjustments.sql",
    "180_service_booking_billing.sql",
    "181_service_booking_billing_lifecycle.sql",
    "180_payroll_accrual_components.sql",
    "181_trainer_payroll_profile.sql",
    "182_payroll_component_guard_fix.sql",
    "183_service_booking_charge_integrity.sql",
    "184_service_booking_charge_deferred_fix.sql",
    "185_dance_group_room_allocation.sql",
    "185_payroll_payment_lifecycle.sql",
    "186_service_employee_economics.sql",
    "187_service_payroll_export_lifecycle.sql",
    "188_service_waitlist.sql",
    "189_service_rebooking_cycle.sql",
    "190_payroll_statement_reviews.sql",
    "192_accounting_compliance_center.sql",
    "193_accounting_tax_automation.sql",
    "193_accounting_compliance_workflow.sql",
    "194_accounting_tax_payment_classification.sql",
    "194_accounting_tax_ledger.sql",
    "194_tax_cash_basis_dimensions.sql",
    "195_accounting_compliance_integrity.sql",
    "195_accounting_signature_evidence.sql",
    "196_cash_account_legal_entity.sql",
    "197_accounting_compliance_lines.sql",
    "198_accounting_compliance_toggle.sql",
    "199_automotive_verticals.sql",
    "200_automotive_integrity.sql",
    "201_automotive_totals_trigger_fix.sql",
    "202_automotive_workflow_integrity.sql",
    "203_accounting_npd.sql",
    "204_crm_workspace.sql",
    "205_professional_services_operations.sql"
  ];

  for (const name of requiredMigrations) {
    const file = resolve(root,"infrastructure/postgres",name);
    try {
      const source = await readFile(file,"utf8");
      if (!/BEGIN;[\s\S]*COMMIT;/.test(source)) {
        add("BLOCK",file,"hardening migration is not transaction wrapped");
      }
      if (
        name === "148_capability_project_hardening.sql" &&
        !/corebiz_tenant_project_permission_bootstrap_trigger\(\)[\s\S]*AS \$\$[\s\S]*END;\s*\$\$;/.test(source)
      ) {
        add("BLOCK",file,"migration 148 trigger function dollar quoting is invalid");
      }
    } catch {
      add("BLOCK",file,"required hardening migration is missing: " + name);
    }
  }
}


async function inspectUniversalServiceEconomics(root) {
  const files = [
    [
      resolve(root,"apps/api/src/modules/business/service-ops/service-economics.service.ts"),
      [
        /service_booking_profitability/,
        /service_employee_compensation_plan/,
        /PERCENT_MARGIN/,
        /minimum_guarantee_minor/,
        /finalizePayroll/,
        /exportPayrollToBatch/,
        /SERVICE_EMPLOYEE_STATEMENT/,
        /service_waitlist_entry/,
        /service\.waitlist_offer_created/,
        /payroll_statement_review/,
        /reviewPayrollStatement/
      ]
    ],
    [
      resolve(root,"apps/web/app/app/service/team/page.tsx"),
      [
        /Команда \/ экономика/,
        /Правило оплаты/,
        /Месячная ведомость/,
        /PERCENT_REVENUE/
      ]
    ]
  ];
  for (const [file,patterns] of files) {
    try {
      const source=await readFile(file,"utf8");
      for (const pattern of patterns) {
        if (!pattern.test(source)) {
          add("BLOCK",file,"universal service economics flow is incomplete: "+pattern);
        }
      }
    } catch {
      add("BLOCK",file,"universal service economics source is missing");
    }
  }
}

export async function inspectSource(root = ROOT) {
  findings.length = 0;

  const apiRoot = resolve(root, "apps/api/src");
  const webRoot = resolve(root, "apps/web");
  const appModule = resolve(apiRoot, "app.module.ts");

  const [apiFiles, webFiles, appSource] = await Promise.all([
    walk(apiRoot),
    walk(webRoot),
    readFile(appModule, "utf8")
  ]);

  inspectAppModule(appModule, appSource);
  await inspectRequiredHardening(root);
  await inspectUniversalServiceEconomics(root);

  for (const file of apiFiles) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const source = await readFile(file, "utf8");

    if (file.endsWith(".controller.ts")) {
      inspectController(file, source);
    }

    inspectBusinessBoundaries(file, source);

    if (/\bTODO\b|\bFIXME\b/.test(source)) {
      add("WARN", file, "TODO/FIXME remains in API source");
    }
  }

  for (const file of webFiles) {
    if (!/\.(ts|tsx|js|jsx)$/.test(file)) continue;
    const source = await readFile(file, "utf8");
    inspectWeb(file, source);
  }

  const workflows = resolve(root, ".github/workflows");
  try {
    const workflowFiles = await readdir(workflows);
    if (workflowFiles.some((name) => /\.ya?ml$/i.test(name))) {
      add(
        "BLOCK",
        workflows,
        "GitHub Actions workflows found although this repository is operated without CI/Actions"
      );
    }
  } catch {
    // No workflow directory is expected for this repository.
  }

  return {
    checkedApiFiles: apiFiles.filter((file) => /\.(ts|tsx)$/.test(file)).length,
    checkedWebFiles: webFiles.filter((file) => /\.(ts|tsx|js|jsx)$/.test(file)).length,
    blocked: findings.filter((item) => item.severity === "BLOCK").length,
    warnings: findings.filter((item) => item.severity === "WARN").length,
    findings: [...findings]
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const report = await inspectSource(ROOT);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    process.exitCode = report.blocked > 0 ? 1 : 0;
  } catch (error) {
    process.stderr.write(
      "[stability-preflight] BLOCKED: " +
        (error instanceof Error ? error.stack ?? error.message : String(error)) +
        "\n"
    );
    process.exitCode = 1;
  }
}
