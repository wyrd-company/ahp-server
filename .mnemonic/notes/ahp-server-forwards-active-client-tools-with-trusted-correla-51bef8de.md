---
title: AHP server forwards active-client tools with trusted correlation
tags:
  - ahp
  - active-client-tools
  - tools
  - claude-agent-sdk
  - mcp
  - pi-agent
  - openai-compatible
  - codex
  - codex-app-server
lifecycle: permanent
createdAt: '2026-06-10T14:55:23.973Z'
updatedAt: '2026-06-11T01:40:37.918Z'
role: summary
alwaysLoad: false
project: github-com-wyrd-company-ahp-server
projectName: ahp-server
memoryVersion: 1
---
# AHP server forwards active-client tools with trusted correlation

On 2026-06-10, `ahp-server` commit `9fd9916` implemented active-client tool plumbing as a generic provider capability.

Provider/session contract additions:

- `AgentSessionContext.activeClientTools` provides the current `{ clientId, tools }` at session creation.
- `AgentSession.setActiveClientTools(...)` is an optional hook for full-replacement updates and removal.
- `AgentSessionContext.activeClientToolSink.reportInvocation(...)` lets providers report that a runtime invoked an active-client tool.

Server-owned behavior:

- `session/activeClientToolsChanged` updates provider tool view only when dispatched by the current active client.
- Clearing the active client, disposing the session, or disconnecting the active client removes the provider tool view and clears internal active-client tool call records.
- Provider-reported active-client tool invocations emit `session/toolCallStart` and `session/toolCallReady` with `contributor: { kind: 'client', clientId }`.
- The server stores trusted correlation for session URI, turn id, tool call id, tool name, and owning client id. Tool input is not trusted for these correlation fields.
- `session/toolCallComplete`, `session/toolCallContentChanged`, and `session/toolCallResultConfirmed` are accepted only from the active client that owns the server-recorded tool call; state alone is not sufficient to authorize stale/untracked client tool results.

Validation: `task verify` passed. The new acceptance test `test/active-client-tools.test.ts` covers create-time tool visibility, tool replacement, active-client clearing, provider invocation, emitted contributor identity, rejection of a different completing client, owner completion, and disconnect cleanup.

## Claude MCP Provider Bridge

On 2026-06-10, `ahp-server` commit `b8f7f06` wired active-client tools into the Claude Agent SDK provider through a per-session local Streamable HTTP MCP bridge.

Key implementation details:

- `ActiveClientToolSink.reportInvocation(...)` now returns a `Promise<ToolCallResult>` and resolves when the owning active client dispatches `session/toolCallComplete`.
- A reusable `ActiveClientToolsMcpBridge` serves `tools/list` and `tools/call` with the official `@modelcontextprotocol/sdk` Streamable HTTP server transport.
- The Claude Agent SDK provider always registers that bridge as an HTTP MCP server named `activeClientTools`, preserving existing caller-supplied `mcpServers`.
- AHP turn startup is queued instead of awaited by the JSON-RPC dispatch handler so active clients can dispatch tool completions while the provider turn is still running.
- Validation: `npm run verify` passed. `test/claude-agent-sdk-provider.test.ts` uses the official MCP client over Streamable HTTP to list the registered active-client tool, call it, observe AHP `toolCallStart`/`toolCallReady`, complete it via AHP, and receive the MCP tool result.

## Pi Agent OpenAI Tool-Call Provider Bridge

On 2026-06-11, `ahp-server` commit `f7ffd28` wired active-client tools into the Pi Agent provider through OpenAI-compatible Chat Completions tool calls.

Key implementation details:

- `PiAgentChatMessage` now supports assistant `tool_calls` and OpenAI `tool` result messages.
- `PiAgentStreamCompletionParams` now supports OpenAI-compatible `tools` derived from AHP `ToolDefinition` values.
- `OpenAICompatiblePiAgentClient` parses streamed `delta.tool_calls` chunks, accumulates function names and JSON argument strings, and emits completed tool-call events after the stream ends.
- The Pi provider loops chat completions: it sends active-client tools, forwards model tool calls through `activeClientToolSink.reportInvocation(...)`, appends returned AHP tool results as OpenAI `tool` messages, then continues until the model emits final text.
- Validation: `npm run verify` passed. `npm run test:live:pi` also passed with the repo `.env` OpenAI-compatible provider configuration. `test/pi-agent-provider.test.ts` covers model `tool_calls`, trusted AHP turn correlation despite forged tool arguments, AHP client completion, OpenAI `tool` result continuation, and final assistant output.

## Codex App Server Dynamic Tool Provider Bridge

On 2026-06-11, `ahp-server` commit `33849b0` wired active-client tools into the Codex App Server provider through CAS experimental dynamic tools.

Key implementation details:

- The provider converts the active client's initial AHP `ToolDefinition` values into CAS `dynamicTools` on `thread/start` under namespace `ahp_active_client`.
- `CodexAppServerSocketClient` server-to-client JSON-RPC request events now expose `respond(...)` and `reject(...)`, so handled CAS requests no longer fall through to method-not-found.
- During an AHP turn, CAS `item/tool/call` requests are routed through `ActiveClientToolSink.reportInvocation(...)` using the server-owned AHP turn id and CAS `callId` as the AHP tool call id.
- AHP tool results are converted back into CAS `DynamicToolCallResponse` content items, including text and image content where representable.
- `AgentSession.setActiveClientTools(...)` keeps the adapter's local validation view current, but CAS currently only accepts `dynamicTools` at `thread/start`; post-creation tool additions are not model-visible until CAS exposes a live dynamic-tool update API.
- Validation: `npm run verify` passed. `test/codex-provider.test.ts` covers CAS dynamic tool registration, trusted AHP tool lifecycle emissions, active-client completion, and CAS response conversion. `test/codex-rpc-client.test.ts` exercises the real WebSocket request-response path for handled CAS server requests.
