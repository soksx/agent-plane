import { NextRequest, NextResponse } from "next/server";
import { query, queryOne } from "@/db";
import { withErrorHandler } from "@/lib/api";
import { SessionRow, RunRow } from "@/lib/validation";
import { stopSession } from "@/lib/sessions";
import { reconnectSandbox } from "@/lib/sandbox";
import { logger } from "@/lib/logger";
import type { TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const { sessionId } = await context!.params;

  // Admin: no RLS — query directly
  const session = await queryOne(
    SessionRow,
    "SELECT * FROM sessions WHERE id = $1",
    [sessionId],
  );
  if (!session) {
    return NextResponse.json({ error: { code: "not_found", message: "Session not found" } }, { status: 404 });
  }

  // Get session runs
  const runs = await query(
    RunRow,
    "SELECT * FROM runs WHERE session_id = $1 ORDER BY created_at ASC",
    [sessionId],
  );

  return NextResponse.json({ ...session, runs });
});

export const DELETE = withErrorHandler(async (request: NextRequest, context) => {
  const { sessionId } = await context!.params;

  const session = await queryOne(
    SessionRow,
    "SELECT * FROM sessions WHERE id = $1",
    [sessionId],
  );
  if (!session) {
    return NextResponse.json({ error: { code: "not_found", message: "Session not found" } }, { status: 404 });
  }

  // Stop sandbox if alive
  if (session.sandbox_id) {
    try {
      const sandbox = await reconnectSandbox(session.sandbox_id);
      if (sandbox) await sandbox.stop();
    } catch (err) {
      logger.warn("Failed to stop sandbox during admin session delete", {
        session_id: sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const stopped = await stopSession(sessionId, session.tenant_id as TenantId);
  return NextResponse.json(stopped);
});
