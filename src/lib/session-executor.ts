import {
  createSessionSandbox,
  reconnectSessionSandbox,
  type SessionSandboxInstance,
  type SessionSandboxConfig,
} from "@/lib/sandbox";
import { buildMcpConfig } from "@/lib/mcp";
import { fetchPluginContent } from "@/lib/plugins";
import { createRun, transitionRunStatus } from "@/lib/runs";
import {
  transitionSessionStatus,
  incrementMessageCount,
  updateSessionSandbox,
  type Session,
} from "@/lib/sessions";
import { uploadTranscript } from "@/lib/transcripts";
import { backupSessionFile } from "@/lib/session-files";
import { restoreSessionFile } from "@/lib/session-files";
import { processLineAssets } from "@/lib/assets";
import { generateRunToken } from "@/lib/crypto";
import { logger } from "@/lib/logger";
import { getEnv } from "@/lib/env";
import type { AgentInternal } from "@/lib/validation";
import type { RunId, RunStatus, TenantId, SessionId, AgentId } from "@/lib/types";

export interface SessionExecutionParams {
  sessionId: string;
  tenantId: TenantId;
  agent: AgentInternal;
  prompt: string;
  platformApiUrl: string;
  effectiveBudget: number;
  effectiveMaxTurns: number;
}

export interface SessionMessageResult {
  runId: RunId;
  sandbox: SessionSandboxInstance;
  logIterator: AsyncGenerator<string>;
  transcriptChunks: string[];
  sdkSessionIdRef: { value: string | null };
}

const MAX_TRANSCRIPT_EVENTS = 10_000;
const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Prepare a session sandbox (create or reconnect).
 * Returns the sandbox instance ready for runMessage().
 */
export async function prepareSessionSandbox(
  params: SessionExecutionParams,
  session: Session,
): Promise<SessionSandboxInstance> {
  const env = getEnv();

  // Build sandbox config (needed for both hot and cold path)
  const [mcpResult, pluginResult] = await Promise.all([
    buildMcpConfig(params.agent, params.tenantId),
    fetchPluginContent(params.agent.plugins ?? []),
  ]);

  if (mcpResult.errors.length > 0) {
    logger.warn("MCP config errors for session", {
      session_id: params.sessionId,
      errors: mcpResult.errors,
    });
  }

  const sandboxConfig: SessionSandboxConfig = {
    agent: {
      ...params.agent,
      max_budget_usd: params.effectiveBudget,
      max_turns: params.effectiveMaxTurns,
    },
    tenantId: params.tenantId,
    sessionId: params.sessionId,
    platformApiUrl: params.platformApiUrl,
    aiGatewayApiKey: env.AI_GATEWAY_API_KEY,
    mcpServers: mcpResult.servers,
    mcpErrors: mcpResult.errors,
    pluginFiles: [...pluginResult.skillFiles, ...pluginResult.commandFiles],
    maxIdleTimeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
  };

  // Hot path: try to reconnect to existing sandbox
  if (session.sandbox_id) {
    const sandbox = await reconnectSessionSandbox(session.sandbox_id, sandboxConfig);
    if (sandbox) {
      // Extend timeout on each message
      await sandbox.extendTimeout(DEFAULT_SESSION_TIMEOUT_MS);
      logger.info("Session sandbox reconnected (hot path)", {
        session_id: params.sessionId,
        sandbox_id: session.sandbox_id,
      });
      return sandbox;
    }
    logger.info("Session sandbox gone, creating new (cold path)", {
      session_id: params.sessionId,
      old_sandbox_id: session.sandbox_id,
    });
  }

  // Cold path: create new sandbox
  const sandbox = await createSessionSandbox(sandboxConfig);

  // Update session with new sandbox_id
  await updateSessionSandbox(params.sessionId, params.tenantId, sandbox.id);

  // Restore session file from Blob if resuming
  if (session.sdk_session_id && session.session_blob_url) {
    await restoreSessionFile(sandbox, session.session_blob_url, session.sdk_session_id);
  }

  return sandbox;
}

/**
 * Execute a single message within a session.
 * Creates a run, starts the runner, and returns an iterator for streaming.
 */
export async function executeSessionMessage(
  params: SessionExecutionParams,
  sandbox: SessionSandboxInstance,
  session: Session,
): Promise<SessionMessageResult> {
  const env = getEnv();

  // Create run record with session_id and triggered_by: "chat"
  const { run } = await createRun(
    params.tenantId,
    params.agent.id as AgentId,
    params.prompt,
    { triggeredBy: "chat" },
  );
  const runId = run.id as RunId;

  const runToken = await generateRunToken(runId, env.ENCRYPTION_KEY);

  // Transition session to active
  const fromStatus = session.status as "creating" | "idle";
  await transitionSessionStatus(
    params.sessionId,
    params.tenantId,
    fromStatus,
    "active",
    { idle_since: null },
  );

  // Start the runner in the sandbox
  const { logs } = await sandbox.runMessage({
    prompt: params.prompt,
    sdkSessionId: session.sdk_session_id,
    runId,
    runToken,
    maxTurns: params.effectiveMaxTurns,
    maxBudgetUsd: params.effectiveBudget,
  });

  // Transition run to running
  await transitionRunStatus(runId, params.tenantId, "pending", "running", {
    sandbox_id: sandbox.id,
    started_at: new Date().toISOString(),
  });

  // Capture transcript and session_info events
  const transcriptChunks: string[] = [];
  const sdkSessionIdRef = { value: session.sdk_session_id };
  const logIterator = captureSessionTranscript(
    logs(),
    transcriptChunks,
    params.tenantId,
    runId,
    sdkSessionIdRef,
  );

  return { runId, sandbox, logIterator, transcriptChunks, sdkSessionIdRef };
}

/**
 * Finalize a session message: persist transcript, update run, backup session file.
 * Does NOT stop sandbox. Session transitions to idle.
 * CRITICAL: This must complete BEFORE the response stream closes.
 */
export async function finalizeSessionMessage(
  runId: RunId,
  tenantId: TenantId,
  sessionId: string,
  transcriptChunks: string[],
  effectiveBudget: number,
  sandbox: SessionSandboxInstance,
  sdkSessionId: string | null,
): Promise<void> {
  try {
    // 1. Persist transcript
    let resultData: { status: RunStatus; updates: Record<string, unknown> } | null = null;
    if (transcriptChunks.length > 0) {
      const transcript = transcriptChunks.join("\n") + "\n";
      const blobUrl = await uploadTranscript(tenantId, runId, transcript);
      const lastLine = transcriptChunks[transcriptChunks.length - 1];
      resultData = parseResultEvent(lastLine);

      await transitionRunStatus(
        runId,
        tenantId,
        "running",
        resultData?.status ?? "completed",
        {
          completed_at: new Date().toISOString(),
          transcript_blob_url: blobUrl,
          ...resultData?.updates,
        },
        { expectedMaxBudgetUsd: effectiveBudget },
      );
    }

    // 2. Increment message count
    await incrementMessageCount(sessionId, tenantId);

    // 3. Back up session file SYNCHRONOUSLY (before response ends)
    let sessionBlobUrl: string | null = null;
    if (sdkSessionId) {
      sessionBlobUrl = await backupSessionFile(
        sandbox,
        tenantId as TenantId,
        sessionId,
        sdkSessionId,
      );
    }

    // 4. Transition session to idle
    await transitionSessionStatus(
      sessionId,
      tenantId,
      "active",
      "idle",
      {
        idle_since: new Date().toISOString(),
        last_message_at: new Date().toISOString(),
        ...(sdkSessionId ? { sdk_session_id: sdkSessionId } : {}),
        ...(sessionBlobUrl ? { session_blob_url: sessionBlobUrl, last_backup_at: new Date().toISOString() } : {}),
      },
    );
  } catch (err) {
    logger.error("Failed to finalize session message", {
      run_id: runId,
      session_id: sessionId,
      error: err instanceof Error ? err.message : String(err),
    });

    // Best-effort: mark run as failed
    await transitionRunStatus(runId, tenantId, "running", "failed", {
      completed_at: new Date().toISOString(),
      error_type: "session_finalize_error",
      error_messages: [err instanceof Error ? err.message : String(err)],
    }).catch(() => {});

    // Best-effort: transition session to idle even on error
    await transitionSessionStatus(
      sessionId,
      tenantId,
      "active",
      "idle",
      { idle_since: new Date().toISOString() },
    ).catch(() => {});
  }
}

async function* captureSessionTranscript(
  source: AsyncIterable<string>,
  chunks: string[],
  tenantId: TenantId,
  runId: RunId,
  sdkSessionIdRef: { value: string | null },
): AsyncGenerator<string> {
  let truncated = false;
  for await (const line of source) {
    const trimmed = line.trim();
    if (!trimmed) {
      yield line;
      continue;
    }

    // Check for session_info events to capture SDK session ID
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.type === "session_info" && parsed.sdk_session_id) {
        sdkSessionIdRef.value = parsed.sdk_session_id;
        logger.info("Captured SDK session ID", {
          run_id: runId,
          sdk_session_id: parsed.sdk_session_id,
        });
      }
    } catch {
      // Not JSON, continue
    }

    if (truncated) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.type === "result" || parsed.type === "error") {
          const processed = await processLineAssets(trimmed, tenantId, runId);
          chunks.push(processed);
          yield processed;
          continue;
        }
      } catch {
        // Not JSON
      }
      yield trimmed;
    } else {
      const processed = await processLineAssets(trimmed, tenantId, runId);
      const isTextDelta = (() => {
        try { return JSON.parse(processed).type === "text_delta"; } catch { return false; }
      })();
      if (isTextDelta) {
        yield processed;
        continue;
      }
      if (chunks.length < MAX_TRANSCRIPT_EVENTS) {
        chunks.push(processed);
      } else {
        truncated = true;
        chunks.push(JSON.stringify({ type: "system", message: `Transcript truncated at ${MAX_TRANSCRIPT_EVENTS} events` }));
        logger.warn("Session transcript truncated", { run_id: runId, max: MAX_TRANSCRIPT_EVENTS });
      }
      yield processed;
    }
  }
}

function parseResultEvent(line: string): {
  status: RunStatus;
  updates: Record<string, unknown>;
} | null {
  try {
    const event = JSON.parse(line);
    if (event.type === "result") {
      const status: RunStatus =
        event.subtype === "success" ? "completed" : "failed";
      return {
        status,
        updates: {
          result_summary: event.subtype,
          cost_usd: event.total_cost_usd,
          num_turns: event.num_turns,
          duration_ms: event.duration_ms,
          duration_api_ms: event.duration_api_ms,
          total_input_tokens: event.usage?.input_tokens,
          total_output_tokens: event.usage?.output_tokens,
          cache_read_tokens: event.usage?.cache_read_input_tokens,
          cache_creation_tokens: event.usage?.cache_creation_input_tokens,
          model_usage: event.modelUsage,
        },
      };
    }
    if (event.type === "error") {
      return {
        status: "failed",
        updates: {
          error_type: event.code || "execution_error",
          error_messages: [event.error],
        },
      };
    }
  } catch {
    // Not valid JSON
  }
  return null;
}
