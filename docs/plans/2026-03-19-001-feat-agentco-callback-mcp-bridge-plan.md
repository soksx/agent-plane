---
title: "feat: AgentCo callback MCP bridge"
type: feat
status: active
date: 2026-03-19
origin: docs/brainstorms/2026-03-19-agentco-callback-bridge-requirements.md
---

# AgentCo Callback MCP Bridge

## Enhancement Summary

**Deepened on:** 2026-03-19
**Sections enhanced:** 5
**Research agents used:** MCP protocol research, Vercel Sandbox feasibility, security review, architecture review, Context7 SDK docs

### Key Improvements (from deepening)
1. **Static bridge script** instead of generated code — write via `writeFiles`, read config from env vars/files
2. **Extend `McpServerConfig`** with `"stdio"` variant instead of bypassing the type system
3. **Write tool schemas to file** instead of env var — avoids size limits, uses existing `writeFiles` pattern
4. **MCP protocol details confirmed** — newline-delimited JSON-RPC, `inputSchema` (not `parameters`), `content` array in results
5. **Vercel Sandbox confirmed viable** — full Linux VM, child processes fully supported, 4GB RAM, no stdin/stdout restrictions

### Security Findings (0 critical)
- Bridge script tampering mitigated by network egress policy (agent can only reach callback URL)
- Token in env vars acceptable — server-side JWT scope enforcement is the real security boundary
- Rate limiting gap: in-memory only on serverless — address before production scale

## Overview

When AgentCo dispatches a task to an AgentPlane agent, it sends callback credentials (URL, token, tool schemas) in an A2A DataPart. Currently the agent receives prose instructions to make raw HTTP calls — which is unreliable. This plan adds a stdio MCP bridge script that exposes AgentCo's 37 callback tools as native MCP tools the agent can call like any other tool.

## Problem Statement

Agents cannot reliably call back to AgentCo. The current approach relies on the LLM writing correct JSON-RPC over HTTP via Bash/curl. The agent needs structured, callable tools — not prose instructions.

## Proposed Solution

Inject a lightweight Node.js stdio MCP server (`agentco-bridge.mjs`) into the sandbox at run creation time. The bridge:
1. Reads callback credentials from env vars
2. Exposes AgentCo tools via MCP `tools/list`
3. Translates MCP `tools/call` → A2A JSON-RPC `message/send` to the callback URL
4. Returns parsed results to the agent

The agent sees tools like `mcp__agentco__ac_checkout_task` and calls them normally.

(see origin: `docs/brainstorms/2026-03-19-agentco-callback-bridge-requirements.md`)

## Technical Approach

### Architecture

```
Agent SDK (in sandbox)
    ↓ MCP tools/call
agentco-bridge.mjs (stdio MCP server)
    ↓ HTTP POST (A2A JSON-RPC)
AgentCo /a2a callback endpoint
    ↓ tool execution
    ↑ A2A response
agentco-bridge.mjs
    ↑ MCP tools/call result
Agent SDK
```

### Implementation Phases

#### Phase 1: Bridge Script + Injection

**1.1 Write the bridge MCP server script**

File: static script written to sandbox via `writeFiles()` (not generated code — reads config from env vars and a JSON file)

The bridge is a raw MCP stdio server (no SDK dependency — just JSON-RPC over stdin/stdout):

- **`initialize`** → return capabilities `{ tools: {} }`
- **`notifications/initialized`** → no-op
- **`tools/list`** → return tools from `AGENTCO_TOOLS_JSON` env var, mapping `parameters` → `inputSchema` and ensuring `type: "object"` at root
- **`tools/call`** → make A2A `message/send` to `AGENTCO_CALLBACK_URL` with auth header, parse response, return MCP result

Key details:
- Read line-delimited JSON-RPC from stdin (`readline`)
- Write JSON-RPC responses to stdout
- Tool call request format: `{ kind: "data", data: { tool, arguments }, mediaType: "application/json" }` as a message part
- Response parsing: extract from `result.artifacts[0].parts` — handle text parts, data parts, and error responses
- Error handling: network errors, non-200 status, malformed JSON → return MCP `isError: true` with descriptive message
- Timeouts: 30s per tool call via `AbortSignal.timeout(30_000)`

**1.2 Schema format mapping**

AgentCo returns: `{ name, description, parameters }`
MCP expects: `{ name, description, inputSchema }`

The bridge must:
- Rename `parameters` → `inputSchema`
- Ensure root has `type: "object"` (AgentCo schemas already use this format, but defensively add it)

**1.3 Inject bridge into sandbox**

In `src/lib/sandbox.ts` `createSandbox()`:
- If `config.callbackData` is present, generate the bridge script via `buildBridgeScript()`
- Write it to `/vercel/sandbox/agentco-bridge.mjs` via `sandbox.writeFiles()`
- Pass env vars: `AGENTCO_CALLBACK_URL`, `AGENTCO_CALLBACK_TOKEN`, `AGENTCO_TOOLS_JSON`

**1.4 Register bridge as stdio MCP server in runner**

In `buildRunnerScript()`:
- If callback env vars are set, add to the `mcpServers` object in the runner:
  ```js
  if (process.env.AGENTCO_CALLBACK_URL) {
    mcpServers['agentco'] = {
      command: 'node',
      args: ['agentco-bridge.mjs'],
      env: {
        AGENTCO_CALLBACK_URL: process.env.AGENTCO_CALLBACK_URL,
        AGENTCO_CALLBACK_TOKEN: process.env.AGENTCO_CALLBACK_TOKEN,
        AGENTCO_TOOLS_JSON: process.env.AGENTCO_TOOLS_JSON,
      }
    };
  }
  ```
- Extend `McpServerConfig` type with `"stdio"` variant:
  ```typescript
  export type McpServerConfig =
    | { type: "http" | "sse"; url: string; headers?: Record<string, string> }
    | { type: "stdio"; command: string; args: string[]; env?: Record<string, string> };
  ```
- Skip hostname extraction for stdio configs in `createSandbox`/`createSessionSandbox` network policy builders
- Write tool schemas to `/vercel/sandbox/agentco-tools.json` via `writeFiles()` instead of env var (avoids size limits)

**1.5 Pass callback data through the config chain**

`src/lib/a2a.ts` → `src/lib/run-executor.ts` → `src/lib/sandbox.ts`:

Add to interfaces:
```typescript
// RunExecutionParams
callbackData?: { url: string; token: string; tools: unknown[] };

// SandboxConfig
callbackData?: { url: string; token: string; tools: unknown[] };
```

In `a2a.ts` `SandboxAgentExecutor.execute()`:
- Extract callback data (already done — `cb`, `callbackUrl`)
- Pass `callbackData: { url: callbackUrl, token: cb.callback_token, tools: cb.available_tools }` to `prepareRunExecution()`

**1.6 Remove prose callback instructions from prompt**

Once the bridge is working, remove the `## Callback Connection` text block that was appended to the prompt (from our earlier fix). The agent no longer needs to see raw URLs/tokens — the tools handle it.

Keep the `## How to call AgentCo tools` section from AgentCo's message but update it to reference MCP tools instead of raw HTTP.

#### Phase 2: Token Refresh (Critical)

**Problem:** Callback JWTs expire after 30 minutes (`lib/auth/agent-jwt.ts:298` in AgentCo). Runs can last up to 120 minutes. After 30 min, all tool calls fail with 401.

**Solution:** Add a token refresh mechanism.

**Option A — Longer-lived tokens (simplest):**
On the AgentCo side, increase callback token expiry to match max run duration (120 min). Tradeoff: larger window for token misuse, but tokens are already scoped to specific tools and org.

**Option B — Refresh endpoint:**
Add `POST /api/a2a/refresh-token` to AgentCo that accepts a still-valid token and returns a new one. The bridge periodically refreshes (e.g., every 20 min). More complex but more secure.

**Recommendation:** Start with Option A (increase to 120 min). It's a one-line change in AgentCo. Add Option B later if security review requires shorter-lived tokens.

#### Phase 3: Cleanup & Polish

- Remove the `## Callback Connection` prompt text injection (from Phase 1.6)
- Add bridge-specific logging: emit `a2a_tool_call` transcript events for each tool invocation (tool name, duration, success/error)
- Handle edge case: if `available_tools` is empty or missing, skip bridge injection entirely

## System-Wide Impact

### Interaction Graph

A2A message arrives → `SandboxAgentExecutor.execute()` extracts DataPart → callback data passed to `prepareRunExecution()` → `createSandbox()` writes bridge script + sets env vars → runner starts bridge as stdio MCP server → Agent SDK connects → agent calls tools → bridge makes HTTP to AgentCo → AgentCo executes tool → response flows back.

### Error Propagation

- Bridge network error → MCP `isError: true` response → agent sees tool error, can retry or adapt
- Bridge script crash → Agent SDK loses MCP server connection → agent loses agentco tools but continues running (other tools still work)
- AgentCo 401 (token expired) → bridge returns auth error → agent sees error message
- AgentCo 500 → bridge returns server error → agent sees error message

### State Lifecycle Risks

- No persistent state in the bridge — it's purely a request translator
- If the sandbox is killed mid-tool-call, the AgentCo side may have partially executed (e.g., task checked out but not completed). This is pre-existing A2A behavior, not new.

### API Surface Parity

- Session-based runs also receive A2A messages via `SandboxAgentExecutor`. The bridge must also work in `buildSessionRunnerScript()` — same injection pattern applies.

## Acceptance Criteria

- [ ] Agent receiving AgentCo A2A dispatch can call `mcp__agentco__ac_get_tasks` and get a structured response
- [ ] Agent can complete full workflow: `ac_get_tasks` → `ac_checkout_task` → `ac_complete_task`
- [ ] Tool schemas match AgentCo's definitions (correct parameter names, types, descriptions)
- [ ] Bridge handles errors gracefully (network failure, auth error, malformed response)
- [ ] Non-A2A runs are unaffected (bridge only injected when callback data present)
- [ ] Session-based A2A runs also get the bridge
- [ ] Tool calls appear in run transcript
- [ ] Callback token expiry is extended to 120 min (or refresh mechanism added)

## Dependencies & Risks

**Dependencies:**
- Agent SDK stdio MCP server support works in Vercel Sandbox (high confidence — it's just Node.js spawning a child process)
- AgentCo callback endpoint correctly handles tool invocations (already tested in production)

**Risks:**
- **Token expiry (HIGH):** Must be addressed in Phase 2 or the bridge is useless for tasks > 30 min
- **Sandbox process limits:** Vercel Sandbox may have limits on child processes. The bridge is one additional Node.js process. Low risk but worth verifying.
- **Env var size limits:** `AGENTCO_TOOLS_JSON` contains 37 tool schemas — likely 20-50KB of JSON. Verify env var size limits in Vercel Sandbox.

## Files to Modify

| File | Change |
|------|--------|
| `src/lib/sandbox.ts` | Add `buildBridgeScript()`, inject into sandbox, add env vars, register in runner |
| `src/lib/run-executor.ts` | Pass `callbackData` through to `createSandbox()` |
| `src/lib/a2a.ts` | Extract callback data into structured object, pass to `prepareRunExecution()` |
| AgentCo: `lib/auth/agent-jwt.ts` | Increase callback token expiry to 120 min |

## Sources & References

### Origin

- **Origin document:** [docs/brainstorms/2026-03-19-agentco-callback-bridge-requirements.md](docs/brainstorms/2026-03-19-agentco-callback-bridge-requirements.md) — Key decisions: stdio MCP bridge, per-run templating, schemas passed through as-is
- **A2A integration brainstorm:** [docs/brainstorms/2026-03-10-a2a-protocol-integration-brainstorm.md](docs/brainstorms/2026-03-10-a2a-protocol-integration-brainstorm.md) — Section 5 describes the same stdio MCP pattern for outbound A2A

### Internal References

- MCP config: `src/lib/mcp.ts:13-17` (McpServerConfig type)
- Sandbox file injection: `src/lib/sandbox.ts:281-285` (writeFiles pattern)
- Runner MCP config: `src/lib/sandbox.ts:375-410` (mcpServers in runner)
- A2A callback handler: AgentCo `app/a2a/route.ts`
- Callback token issuance: AgentCo `lib/auth/agent-jwt.ts`
- Allowed tools: AgentCo `lib/a2a/allowed-tools.ts`

### External References

- Claude Agent SDK MCP docs: https://platform.claude.com/docs/en/agent-sdk/mcp
- MCP stdio transport: JSON-RPC 2.0 over stdin/stdout (line-delimited)
