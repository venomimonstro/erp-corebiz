import type { Pool } from "pg";

type SupportEscalation = {
  ticket_id: string;
  tenant_id: string;
  business_number: string;
  priority: string;
  escalation_level: number;
  breach_type: "FIRST_RESPONSE" | "RESOLUTION";
};

export async function processSupportSlaOnce(pool: Pool): Promise<boolean> {
  const result = await pool.query<SupportEscalation>(
    "SELECT * FROM public.corebiz_claim_support_sla_escalation()"
  );
  const event = result.rows[0];
  if (!event) return false;

  process.stderr.write(
    "[worker] support SLA escalation " +
      event.business_number +
      " level=" +
      event.escalation_level +
      " type=" +
      event.breach_type +
      "\n"
  );
  return true;
}
