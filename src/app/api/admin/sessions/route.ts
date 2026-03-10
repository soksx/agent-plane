import { NextRequest, NextResponse } from "next/server";
import { query } from "@/db";
import { PaginationSchema, SessionStatusSchema } from "@/lib/validation";
import { withErrorHandler } from "@/lib/api";
import { z } from "zod";

export const dynamic = "force-dynamic";

const SessionWithContext = z.object({
  id: z.string(),
  agent_id: z.string(),
  agent_name: z.string(),
  tenant_id: z.string(),
  tenant_name: z.string(),
  status: z.string(),
  message_count: z.coerce.number(),
  sandbox_id: z.string().nullable(),
  idle_since: z.coerce.string().nullable(),
  last_message_at: z.coerce.string().nullable(),
  created_at: z.coerce.string(),
  updated_at: z.coerce.string(),
});

export const GET = withErrorHandler(async (request: NextRequest) => {
  const url = new URL(request.url);
  const { limit, offset } = PaginationSchema.parse({
    limit: url.searchParams.get("limit") ?? "50",
    offset: url.searchParams.get("offset") ?? "0",
  });
  const statusParam = url.searchParams.get("status");
  const status = statusParam ? SessionStatusSchema.parse(statusParam) : undefined;
  const tenantId = url.searchParams.get("tenant_id");
  const agentId = url.searchParams.get("agent_id");

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (status) {
    conditions.push(`s.status = $${idx++}`);
    params.push(status);
  }
  if (tenantId) {
    conditions.push(`s.tenant_id = $${idx++}`);
    params.push(tenantId);
  }
  if (agentId) {
    conditions.push(`s.agent_id = $${idx++}`);
    params.push(agentId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  params.push(limit, offset);

  const sessions = await query(
    SessionWithContext,
    `SELECT s.id, s.agent_id, a.name AS agent_name, s.tenant_id, t.name AS tenant_name,
       s.status, s.message_count, s.sandbox_id, s.idle_since,
       s.last_message_at, s.created_at, s.updated_at
     FROM sessions s
     JOIN agents a ON a.id = s.agent_id
     JOIN tenants t ON t.id = s.tenant_id
     ${where}
     ORDER BY s.created_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    params,
  );

  return NextResponse.json({ data: sessions, limit, offset });
});
