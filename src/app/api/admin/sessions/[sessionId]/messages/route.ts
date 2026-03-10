import { NextRequest } from "next/server";
import { queryOne } from "@/db";
import { withErrorHandler } from "@/lib/api";
import { SendMessageSchema, SessionRow, AgentRowInternal } from "@/lib/validation";
import { getSession, transitionSessionStatus } from "@/lib/sessions";
import { createNdjsonStream, ndjsonHeaders } from "@/lib/streaming";
import { prepareSessionSandbox, executeSessionMessage, finalizeSessionMessage } from "@/lib/session-executor";
import { logger } from "@/lib/logger";
import { ConflictError, NotFoundError } from "@/lib/errors";
import type { TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const { sessionId } = await context!.params;
  const body = await request.json();
  const input = SendMessageSchema.parse(body);

  // Admin: no RLS — query directly
  const session = await queryOne(
    SessionRow,
    "SELECT * FROM sessions WHERE id = $1",
    [sessionId],
  );
  if (!session) throw new NotFoundError("Session not found");

  if (session.status === "stopped") {
    throw new ConflictError("Session is stopped");
  }
  if (session.status === "active") {
    throw new ConflictError("Session is currently processing a message");
  }

  const tenantId = session.tenant_id as TenantId;

  // Load agent
  const agent = await queryOne(
    AgentRowInternal,
    "SELECT * FROM agents WHERE id = $1",
    [session.agent_id],
  );
  if (!agent) throw new NotFoundError("Agent not found");

  const effectiveBudget = Math.min(
    input.max_budget_usd ?? agent.max_budget_usd,
    agent.max_budget_usd,
  );
  const effectiveMaxTurns = Math.min(
    input.max_turns ?? agent.max_turns,
    agent.max_turns,
  );

  const sandbox = await prepareSessionSandbox(
    {
      sessionId,
      tenantId,
      agent,
      prompt: input.prompt,
      platformApiUrl: new URL(request.url).origin,
      effectiveBudget,
      effectiveMaxTurns,
    },
    session,
  );

  const { runId, logIterator, transcriptChunks, sdkSessionIdRef } =
    await executeSessionMessage(
      {
        sessionId,
        tenantId,
        agent,
        prompt: input.prompt,
        platformApiUrl: new URL(request.url).origin,
        effectiveBudget,
        effectiveMaxTurns,
      },
      sandbox,
      session,
    );

  let detached = false;

  async function* streamWithFinalize() {
    for await (const line of logIterator) {
      yield line;
    }

    if (!detached) {
      await finalizeSessionMessage(
        runId,
        tenantId,
        sessionId,
        transcriptChunks,
        effectiveBudget,
        sandbox,
        sdkSessionIdRef.value,
      );
    }
  }

  const stream = createNdjsonStream({
    runId,
    logIterator: streamWithFinalize(),
    onDetach: () => {
      detached = true;
      logger.info("Admin session message stream detached", {
        session_id: sessionId,
        run_id: runId,
      });
    },
  });

  return new Response(stream, { status: 200, headers: ndjsonHeaders() });
});
