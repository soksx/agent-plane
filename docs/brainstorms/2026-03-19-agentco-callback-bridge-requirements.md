---
date: 2026-03-19
topic: agentco-callback-bridge
---

# AgentCo Callback Bridge: MCP Tools for A2A Callbacks

## Problem Frame

When AgentCo dispatches a task to an AgentPlane agent via A2A, it sends callback credentials (URL, token, tool schemas) in a DataPart. The agent is instructed in prose to "send an A2A message/send to the callback_url" — but the agent has no structured tools to do this. It would need to write raw curl/fetch commands with correct JSON-RPC formatting, auth headers, and A2A protocol semantics. This is unreliable and breaks in practice.

Agents need the AgentCo callback tools (`ac_get_tasks`, `ac_checkout_task`, `ac_complete_task`, etc.) exposed as real, callable MCP tools so the standard tool-calling loop works.

## Requirements

- R1. When an agent receives an A2A message with an `ac_callback` DataPart, the AgentCo tools must be available as MCP tools in the sandbox (e.g. `mcp__agentco__ac_get_tasks`).
- R2. The bridge must translate MCP `tools/call` requests into A2A JSON-RPC `message/send` calls to the callback URL, using the provided callback token for auth.
- R3. The bridge must expose tool schemas from the `available_tools` field in the callback DataPart, so the agent sees correct parameter definitions.
- R4. The bridge must parse A2A responses and return structured results to the agent (extract text/data from artifacts or message parts).
- R5. The callback URL hostname must be allowed in the sandbox network policy (already implemented).
- R6. Runs without callback data must be unaffected — the bridge is only injected when callback credentials are present.

## Success Criteria

- An agent receiving an AgentCo task can call `ac_checkout_task`, do work, and call `ac_complete_task` using standard MCP tool calls — no raw HTTP needed.
- The tools appear in the run transcript as normal tool calls.
- Existing non-A2A runs and session-based runs are unaffected.

## Scope Boundaries

- This covers only the AgentCo callback direction (agent → AgentCo). General outbound A2A client support (agent → arbitrary A2A servers) is Phase 2 of the A2A integration brainstorm and out of scope here.
- No changes to AgentCo's callback endpoint — it already speaks A2A JSON-RPC and handles tool invocations via DataParts.
- No new database tables or API endpoints on AgentPlane.

## Key Decisions

- **stdio MCP server injected into sandbox**: The Agent SDK natively supports stdio MCP servers (`{ command: "node", args: ["bridge.mjs"] }`). A small script written into the sandbox at run creation time is self-contained, requires no new server-side infra, and follows the pattern already outlined in the A2A integration brainstorm (Phase 2, section 5).
- **Bridge script generated per-run**: The callback URL, token, and tool schemas vary per invocation. The bridge script is templated with these values (via env vars) at sandbox creation time.
- **Tool schemas passed through as-is**: AgentCo's `getAllowedToolSchemas()` returns `{ name, description, parameters }` which maps directly to MCP's `tools/list` response format (`{ name, description, inputSchema }`). Minimal transformation needed.

## Dependencies / Assumptions

- The callback DataPart extraction is already implemented (current session's earlier work).
- The Agent SDK's stdio MCP server support works inside Vercel Sandbox (Node.js runtime available).
- AgentCo's `/a2a` callback endpoint correctly handles tool invocations sent as DataParts in `message/send`.

## Outstanding Questions

### Deferred to Planning
- [Affects R2][Technical] Exact JSON-RPC request format: should the bridge send each tool call as a separate `message/send`, or batch multiple calls in one message?
- [Affects R4][Needs research] What response shapes does AgentCo's callback return for different tool types (read vs. write vs. error)? Need to verify the result extraction logic handles all cases.
- [Affects R1][Technical] Should the MCP server name be `agentco` (so tools appear as `mcp__agentco__ac_*`) or something more descriptive?

## Next Steps

→ `/ce:plan` for structured implementation planning
