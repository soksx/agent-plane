import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { SessionResponseRow } from "@/lib/validation";
import { getSession, stopSession } from "@/lib/sessions";
import { listRuns } from "@/lib/runs";
import { reconnectSandbox } from "@/lib/sandbox";
import { backupSessionFile } from "@/lib/session-files";
import { logger } from "@/lib/logger";
import type { TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { sessionId } = await context!.params;

  const session = await getSession(sessionId, auth.tenantId);
  const responseSession = SessionResponseRow.parse(session);

  // Include recent runs (message history)
  const runs = await listRuns(auth.tenantId, {
    agentId: session.agent_id,
    limit: 100,
    offset: 0,
  });
  // Filter runs belonging to this session
  const sessionRuns = runs.filter((r) => r.session_id === sessionId);

  return jsonResponse({ ...responseSession, runs: sessionRuns });
});

export const DELETE = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { sessionId } = await context!.params;

  const session = await getSession(sessionId, auth.tenantId);

  // Back up session file before stopping if sandbox is alive
  if (session.sandbox_id && session.sdk_session_id) {
    try {
      const sandbox = await reconnectSandbox(session.sandbox_id);
      if (sandbox) {
        // Best-effort backup — don't fail the stop if backup fails
        await backupSessionFile(
          sandbox as never, // basic sandbox — readSessionFile not available, skip backup
          auth.tenantId as TenantId,
          sessionId,
          session.sdk_session_id,
        ).catch((err: Error) => {
          logger.warn("Session file backup failed before stop", {
            session_id: sessionId,
            error: err.message,
          });
        });
        await sandbox.stop();
      }
    } catch (err) {
      logger.warn("Failed to stop sandbox during session delete", {
        session_id: sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const stopped = await stopSession(sessionId, auth.tenantId);
  return jsonResponse(SessionResponseRow.parse(stopped));
});
