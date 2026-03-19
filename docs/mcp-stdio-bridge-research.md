# MCP Stdio Bridge Research — Integration Points

## 1. MCP Server Config & Type

**File:** `/Users/marmarko/code/agent-plane/src/lib/mcp.ts` (lines 13-17)

```ts
export interface McpServerConfig {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}
```

**Key finding:** `McpServerConfig` only supports `"http" | "sse"` — no `"stdio"` type.
The Claude Agent SDK's `mcpServers` option receives this exact shape (passed via `MCP_SERVERS_JSON` env var).
To add an stdio bridge, either extend this type to include `"stdio"` or inject the bridge
as a file written into the sandbox that the SDK discovers independently.

## 2. Runner Script — How MCP Config is Consumed

**File:** `/Users/marmarko/code/agent-plane/src/lib/sandbox.ts`

### `buildRunnerScript` (line 352)
- Serializes `mcpServers` into the runner script JSON
- Runner reads `MCP_SERVERS_JSON` env var at runtime (line 378-379)
- Passes to `query({ prompt, options })` where `options.mcpServers = mcpServers` (line 410)

### `buildSessionRunnerScript` (line 709)
- Same pattern: `mcpServers` from env var, passed to `query()` options (line 756)

### SDK consumption:
```js
const mcpServers = process.env.MCP_SERVERS_JSON
  ? JSON.parse(process.env.MCP_SERVERS_JSON)
  : {};
// ...
const options = {
  ...config,
  ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
};
for await (const message of query({ prompt, options })) { ... }
```

The SDK receives `mcpServers` as a `Record<string, { type, url, headers? }>`.
For stdio, the SDK likely expects `{ type: "stdio", command: "...", args: [...] }`.

## 3. Env Vars Passed to Sandbox

**File:** `/Users/marmarko/code/agent-plane/src/lib/sandbox.ts` (lines 291-308)

```
AGENT_PLANE_RUN_ID, AGENT_PLANE_AGENT_ID, AGENT_PLANE_TENANT_ID,
AGENT_PLANE_PLATFORM_URL, ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN,
ANTHROPIC_API_KEY (empty), ENABLE_TOOL_SEARCH, AGENT_PLANE_RUN_TOKEN,
MCP_SERVERS_JSON
```

Session sandbox adds same vars at lines 587-598.
The bridge script would need `callback_url` and `callback_token` — these could be
added as new env vars or embedded in the bridge script itself.

## 4. A2A Callback Endpoint (AgentCo Side)

**File:** `/Users/marmarko/code/agent-co/app/a2a/route.ts`

### Request format (JSON-RPC 2.0):
```json
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "method": "message/send",
  "params": {
    "message": {
      "parts": [{ "data": { "tool": "ac_checkout_task", "arguments": {...} }, "mediaType": "application/json" }]
    }
  }
}
```

### Auth: `Authorization: Bearer <callback_token>` (ac:tools audience JWT)

### Response format (tool invocation):
```json
{
  "jsonrpc": "2.0",
  "id": "...",
  "result": {
    "kind": "task",
    "id": "<uuid>",
    "contextId": "...",
    "status": { "state": "completed"|"failed", "timestamp": "..." },
    "artifacts": [{
      "artifactId": "<uuid>",
      "name": "<tool_name>",
      "parts": [{ "data": { "result": ... } | { "error": "...", "code": "..." }, "mediaType": "application/json" }]
    }]
  }
}
```

### Tool extraction (line 134-145 of tool-executor.ts):
```ts
// Looks for parts with: p.data.tool (string) + p.data.arguments (object)
extractToolInvocation(parts)
```

### Execution pipeline (tool-executor.ts):
1. JWT allowlist check (`claims.tools.includes(tool)`)
2. Tool registry lookup
3. Agent status check (must be active)
4. Rate limit (tiered by trust_level: 120/90/60/30 per min)
5. Governance evaluation
6. Execute handler (same as MCP handler)

## 5. DataPart Extraction (Agent-Plane A2A Executor)

**File:** `/Users/marmarko/code/agent-plane/src/lib/a2a.ts` (lines 438-475)

The `SandboxAgentExecutor.execute()` extracts callback data from incoming A2A messages:

```ts
// Extract data parts with type "ac_callback"
const dataParts = requestContext.userMessage.parts.filter(
  (p): p is DataPart => p.kind === "data",
);
const callbackData = dataParts.find(
  (p) => p.data && typeof p.data === "object" && (p.data as Record<string, unknown>).type === "ac_callback",
);

// Parse callback fields
const cb = callbackData?.data as Record<string, unknown>;
const callbackUrl = cb?.callback_url as string;
```

Currently this data is **appended to the prompt as text** (lines 460-466):
```ts
prompt += `\n\n## Callback Connection\ncallback_url: ${cb.callback_url}\ncallback_token: ${cb.callback_token}\n`;
if (cb.available_tools) {
  prompt += `\navailable_tools:\n${JSON.stringify(cb.available_tools, null, 2)}\n`;
}
```

The callback hostname is added to the sandbox network policy (line 524):
```ts
extraAllowedHostnames: callbackHostname ? [callbackHostname] : [],
```

## 6. Writing Files Into the Sandbox

**File:** `/Users/marmarko/code/agent-plane/src/lib/sandbox.ts`

### Pattern: `sandbox.writeFiles([{ path, content: Buffer }])`

Used in three places:
1. **Runner script + skills + plugins** (line 284): written before `runCommand`
2. **Session runner per-message** (line 674): `runner-${runId}.mjs` written per `runMessage()`
3. **Session file persistence** (line 640): SDK session state files

### File path conventions:
- Runner: `/vercel/sandbox/runner.mjs`
- Skills: `/vercel/sandbox/.claude/skills/<folder>/<file>`
- Plugins: `/vercel/sandbox/<path>` (relative to sandbox root)
- Session files: `/vercel/sandbox/.claude/projects/vercel/sandbox/<id>.jsonl`

### Path safety: every resolved path is checked with `startsWith(root + "/")`.

## 7. How AgentCo Issues Callback Tokens

**File:** `/Users/marmarko/code/agent-co/lib/auth/agent-jwt.ts`

```ts
interface CallbackTokenClaims {
  agentId: string;
  companyId: string;
  trustLevel: string;
  tools: string[];
}

async function issueCallbackToken(options: {
  agentId: string;
  companyId: string;
  trustLevel: string;
  allowedTools: string[];
}): Promise<string>
// ES256, 30min TTL, audience: "ac:tools", no JTI (reusable)
```

**File:** `/Users/marmarko/code/agent-co/lib/a2a/client.ts` (lines 247-292)

`sendTaskToAgent()` is the dispatch entry point. It:
1. Assembles agent context (tasks, goals, strategy, knowledge)
2. Issues callback token with `A2A_ALLOWED_TOOLS` (37 tools)
3. Builds a data part: `{ type: "ac_callback", callback_url, callback_token, available_tools }`
4. Sends via `sendMessageToAgent()` which makes JSON-RPC `message/send` call

## Summary: Bridge Integration Strategy

The MCP stdio bridge needs to:

1. **Be written as a file into the sandbox** (like skills/plugins) — a Node.js script that implements the MCP stdio protocol
2. **Receive callback credentials** via env vars (`AC_CALLBACK_URL`, `AC_CALLBACK_TOKEN`) or embedded in the script
3. **Translate MCP tool calls** to A2A JSON-RPC `message/send` requests with `{ data: { tool, arguments }, mediaType: "application/json" }` parts
4. **Parse A2A responses** extracting `result.artifacts[0].parts[0].data.result` or `.data.error`
5. **Be registered in mcpServers** as `{ type: "stdio", command: "node", args: ["/vercel/sandbox/ac-bridge.mjs"] }` — requires extending `McpServerConfig.type` to include `"stdio"`
6. **Callback hostname** must be in `networkPolicy.allow` (already handled via `extraAllowedHostnames`)
