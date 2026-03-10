import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { CreateSessionSchema, PaginationSchema, SessionStatusSchema, SessionResponseRow } from "@/lib/validation";
import { createSession, listSessions } from "@/lib/sessions";
import { createNdjsonStream, ndjsonHeaders } from "@/lib/streaming";
import { prepareSessionSandbox, executeSessionMessage, finalizeSessionMessage } from "@/lib/session-executor";
import { transitionSessionStatus } from "@/lib/sessions";
import { logger } from "@/lib/logger";
import type { AgentId, RunId } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const body = await request.json();
  const input = CreateSessionSchema.parse(body);

  const { session, agent } = await createSession(auth.tenantId, input.agent_id as AgentId);

  // Prepare sandbox (cold start)
  const sandbox = await prepareSessionSandbox(
    {
      sessionId: session.id,
      tenantId: auth.tenantId,
      agent,
      prompt: input.prompt ?? "",
      platformApiUrl: new URL(request.url).origin,
      effectiveBudget: agent.max_budget_usd,
      effectiveMaxTurns: agent.max_turns,
    },
    session,
  );

  if (!input.prompt) {
    // No prompt: just create session with warm sandbox, transition to idle
    await transitionSessionStatus(session.id, auth.tenantId, "creating", "idle", {
      sandbox_id: sandbox.id,
      idle_since: new Date().toISOString(),
    });

    const updatedSession = SessionResponseRow.parse({
      ...session,
      status: "idle",
      sandbox_id: sandbox.id,
      idle_since: new Date().toISOString(),
    });
    return jsonResponse(updatedSession, 201);
  }

  // With prompt: execute first message and stream response
  const { runId, logIterator, transcriptChunks, sdkSessionIdRef } =
    await executeSessionMessage(
      {
        sessionId: session.id,
        tenantId: auth.tenantId,
        agent,
        prompt: input.prompt,
        platformApiUrl: new URL(request.url).origin,
        effectiveBudget: agent.max_budget_usd,
        effectiveMaxTurns: agent.max_turns,
      },
      sandbox,
      { ...session, sandbox_id: sandbox.id },
    );

  let detached = false;

  // Wrap the log iterator to finalize session BEFORE stream closes
  async function* streamWithFinalize() {
    // Emit session_created event
    yield JSON.stringify({
      type: "session_created",
      session_id: session.id,
      agent_id: session.agent_id,
      timestamp: new Date().toISOString(),
    });

    for await (const line of logIterator) {
      yield line;
    }

    // Finalize SYNCHRONOUSLY before response ends
    if (!detached) {
      await finalizeSessionMessage(
        runId,
        auth.tenantId,
        session.id,
        transcriptChunks,
        agent.max_budget_usd,
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
      logger.info("Session stream detached", { session_id: session.id, run_id: runId });
    },
  });

  return new Response(stream, { status: 200, headers: ndjsonHeaders() });
});

export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const url = new URL(request.url);
  const pagination = PaginationSchema.parse({
    limit: url.searchParams.get("limit"),
    offset: url.searchParams.get("offset"),
  });
  const agentId = url.searchParams.get("agent_id") ?? undefined;
  const statusParam = url.searchParams.get("status");
  const status = statusParam ? SessionStatusSchema.parse(statusParam) : undefined;

  const sessions = await listSessions(auth.tenantId, {
    agentId,
    status,
    ...pagination,
  });

  const responseSessions = sessions.map((s) => SessionResponseRow.parse(s));
  return jsonResponse({ data: responseSessions, limit: pagination.limit, offset: pagination.offset });
});
