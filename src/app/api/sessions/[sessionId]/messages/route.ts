import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler } from "@/lib/api";
import { SendMessageSchema, AgentRowInternal } from "@/lib/validation";
import { getSession } from "@/lib/sessions";
import { createNdjsonStream, ndjsonHeaders } from "@/lib/streaming";
import { prepareSessionSandbox, executeSessionMessage, finalizeSessionMessage } from "@/lib/session-executor";
import { queryOne } from "@/db";
import { logger } from "@/lib/logger";
import { ConflictError, NotFoundError } from "@/lib/errors";
import type { RunId } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { sessionId } = await context!.params;
  const body = await request.json();
  const input = SendMessageSchema.parse(body);

  const session = await getSession(sessionId, auth.tenantId);

  if (session.status === "stopped") {
    throw new ConflictError("Session is stopped");
  }
  if (session.status === "active") {
    throw new ConflictError("Session is currently processing a message");
  }

  // Load agent config (need internal schema for MCP fields)
  const agent = await queryOne(
    AgentRowInternal,
    "SELECT * FROM agents WHERE id = $1 AND tenant_id = $2",
    [session.agent_id, auth.tenantId],
  );
  if (!agent) throw new NotFoundError("Agent not found");

  // Apply per-message overrides capped to agent config
  const effectiveBudget = Math.min(
    input.max_budget_usd ?? agent.max_budget_usd,
    agent.max_budget_usd,
  );
  const effectiveMaxTurns = Math.min(
    input.max_turns ?? agent.max_turns,
    agent.max_turns,
  );

  // Get or create sandbox
  const sandbox = await prepareSessionSandbox(
    {
      sessionId,
      tenantId: auth.tenantId,
      agent,
      prompt: input.prompt,
      platformApiUrl: new URL(request.url).origin,
      effectiveBudget,
      effectiveMaxTurns,
    },
    session,
  );

  // Execute message
  const { runId, logIterator, transcriptChunks, sdkSessionIdRef } =
    await executeSessionMessage(
      {
        sessionId,
        tenantId: auth.tenantId,
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

  // Wrap log iterator to finalize session before stream closes
  async function* streamWithFinalize() {
    for await (const line of logIterator) {
      yield line;
    }

    if (!detached) {
      await finalizeSessionMessage(
        runId,
        auth.tenantId,
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
      logger.info("Session message stream detached", {
        session_id: sessionId,
        run_id: runId,
      });
    },
  });

  return new Response(stream, { status: 200, headers: ndjsonHeaders() });
});
