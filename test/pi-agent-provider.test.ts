import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { AhpClient } from '@microsoft/agent-host-protocol/client';
import type { AhpTransport, JsonRpcMessage, TransportFrame } from '@microsoft/agent-host-protocol/client';
import type { Message, StateAction, ToolDefinition } from '@microsoft/agent-host-protocol';

import {
  AhpServer,
  createInMemoryTransportPair,
  createPiAgentProvider,
  type PiAgentChatClient,
  type PiAgentChatMessage,
  type PiAgentChatStreamEvent,
  type PiAgentChatTool,
  type PiAgentStreamCompletionParams,
} from '../src/index.js';

const runningServers: Array<Promise<void>> = [];

after(async () => {
  await Promise.allSettled(runningServers);
});

test('Pi Agent provider streams OpenAI-compatible chat completions as AHP actions', async () => {
  const pi = new FakePiAgentClient([['Pi ', 'says ', 'hello']]);
  const server = new AhpServer({
    providers: [createPiAgentProvider({ client: pi, defaultModel: 'pi-test' })],
  });
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  runningServers.push(server.accept(serverTransport));

  const client = new AhpClient(asAhpTransport(clientTransport), { requestTimeoutMs: 1_000 });
  client.connect();
  await client.initialize({ clientId: 'test-client', protocolVersions: ['0.3.0'] });

  const sessionUri = 'ahp-session:/pi-session';
  await client.request('createSession', {
    channel: sessionUri,
    provider: 'pi-agent',
  });
  const { subscription } = await client.subscribe(sessionUri);

  client.dispatch(sessionUri, {
    type: 'session/turnStarted',
    turnId: 'ahp-turn-1',
    message: userMessage('Hello Pi'),
  } as StateAction);

  const events = [
    await subscription.next(),
    await subscription.next(),
    await subscription.next(),
    await subscription.next(),
    await subscription.next(),
  ].map(event => {
    assert.equal(event.done, false);
    assert.equal(event.value.type, 'action');
    return event.value.params.action;
  });

  assert.equal(pi.requests.length, 1);
  assert.equal(pi.requests[0]?.model, 'pi-test');
  assert.deepEqual(pi.requests[0]?.messages, [{ role: 'user', content: 'Hello Pi' }]);
  assert.equal(events[1]?.type, 'session/responsePart');
  assert.equal((events[1] as { turnId?: string }).turnId, 'ahp-turn-1');
  assert.equal(events[2]?.type, 'session/delta');
  assert.equal((events[2] as { content?: string }).content, 'Pi ');
  assert.equal((events[2] as { turnId?: string }).turnId, 'ahp-turn-1');
  assert.equal(events[4]?.type, 'session/delta');

  const final = await subscription.next();
  assert.equal(final.done, false);
  assert.equal(final.value.type, 'action');
  assert.equal(final.value.params.action.type, 'session/turnComplete');
  assert.equal((final.value.params.action as { turnId?: string }).turnId, 'ahp-turn-1');

  await client.shutdown();
});

test('Pi Agent provider routes OpenAI-compatible tool calls through active-client tools', async () => {
  const pi = new FakePiAgentClient([
    [{
      type: 'toolCall',
      toolCall: {
        id: 'openai-call-1',
        type: 'function',
        function: {
          name: 'searchWorkspace',
          arguments: JSON.stringify({
            sessionUri: 'ahp-session:/forged',
            turnId: 'forged-turn',
            query: 'needle',
          }),
        },
      },
    }],
    ['Pi found needle'],
  ]);
  const server = new AhpServer({
    providers: [createPiAgentProvider({ client: pi, defaultModel: 'pi-test' })],
  });
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  runningServers.push(server.accept(serverTransport));

  const client = new AhpClient(asAhpTransport(clientTransport), { requestTimeoutMs: 1_000 });
  client.connect();
  await client.initialize({ clientId: 'owner-client', protocolVersions: ['0.3.0'] });

  const tool = toolDefinition('searchWorkspace', 'Search Workspace');
  const sessionUri = 'ahp-session:/pi-active-client-tools';
  await client.request('createSession', {
    channel: sessionUri,
    provider: 'pi-agent',
    activeClient: {
      clientId: 'owner-client',
      displayName: 'Owner Client',
      tools: [tool],
    },
  });
  const { subscription } = await client.subscribe(sessionUri);

  client.dispatch(sessionUri, {
    type: 'session/turnStarted',
    turnId: 'ahp-turn-tools',
    message: userMessage('Use the client tool'),
  } as StateAction);

  const toolActions = await collectUntilAction(subscription, action => action.type === 'session/toolCallReady');
  assert.equal(pi.requests.length, 1);
  assert.deepEqual(pi.requests[0]?.tools, [{
    type: 'function',
    function: {
      name: 'searchWorkspace',
      description: 'Search Workspace test tool',
      parameters: tool.inputSchema,
    },
  }]);

  const toolStart = toolActions.find(action => action.type === 'session/toolCallStart');
  assert.ok(toolStart);
  assert.equal(toolStart.turnId, 'ahp-turn-tools');
  assert.equal(toolStart.toolName, 'searchWorkspace');
  assert.deepEqual(toolStart.contributor, {
    kind: 'client',
    clientId: 'owner-client',
  });

  const toolReady = toolActions.at(-1);
  assert.equal(toolReady?.type, 'session/toolCallReady');
  assert.equal(toolReady.turnId, 'ahp-turn-tools');
  assert.equal(toolReady.toolCallId, 'openai-call-1');
  assert.match(String(toolReady.toolInput), /forged-turn/);
  assert.match(String(toolReady.toolInput), /needle/);

  client.dispatch(sessionUri, {
    type: 'session/toolCallComplete',
    turnId: 'ahp-turn-tools',
    toolCallId: 'openai-call-1',
    result: {
      success: true,
      pastTenseMessage: 'Searched workspace',
      content: [{ type: 'text', text: 'found needle' }],
    },
  } as StateAction);

  const terminalActions = await collectUntilAction(subscription, action => action.type === 'session/turnComplete');
  assert.ok(terminalActions.some(action => action.type === 'session/delta' && (action as { content?: string }).content === 'Pi found needle'));
  assert.equal(pi.requests.length, 2);
  assert.deepEqual(pi.requests[1]?.messages, [
    { role: 'user', content: 'Use the client tool' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'openai-call-1',
        type: 'function',
        function: {
          name: 'searchWorkspace',
          arguments: JSON.stringify({
            sessionUri: 'ahp-session:/forged',
            turnId: 'forged-turn',
            query: 'needle',
          }),
        },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'openai-call-1',
      content: 'found needle',
    },
  ]);
  assert.deepEqual(pi.requests[1]?.tools, pi.requests[0]?.tools);

  await client.shutdown();
});

class FakePiAgentClient implements PiAgentChatClient {
  readonly requests: Array<{
    model: string;
    messages: readonly PiAgentChatMessage[];
    tools?: readonly PiAgentChatTool[];
  }> = [];

  constructor(private readonly responses: readonly (readonly PiAgentChatStreamEvent[])[]) {}

  async *streamChatCompletion(params: PiAgentStreamCompletionParams): AsyncIterable<PiAgentChatStreamEvent> {
    this.requests.push({
      model: params.model,
      messages: params.messages.map(message => ({ ...message })),
      ...(params.tools ? { tools: params.tools.map(tool => ({ ...tool, function: { ...tool.function } })) } : {}),
    });
    const response = this.responses[this.requests.length - 1] ?? [];
    for (const chunk of response) {
      yield chunk;
    }
  }
}

async function collectUntilAction(
  subscription: AsyncIterator<unknown>,
  predicate: (action: StateAction) => boolean,
): Promise<StateAction[]> {
  const actions: StateAction[] = [];
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const next = await subscription.next();
    assert.equal(next.done, false);
    const value = next.value as { type?: string; params?: { action?: StateAction } };
    if (value.type !== 'action' || !value.params?.action) {
      continue;
    }
    actions.push(value.params.action);
    if (predicate(value.params.action)) {
      return actions;
    }
  }
  assert.fail(`timed out waiting for matching action; saw: ${JSON.stringify(actions)}`);
}

function toolDefinition(name: string, title: string): ToolDefinition {
  return {
    name,
    title,
    description: `${title} test tool`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
  };
}

function userMessage(text: string): Message {
  return {
    text,
    origin: { kind: 'user' as Message['origin']['kind'] },
  };
}

function asAhpTransport(transport: {
  send(message: unknown): Promise<void> | void;
  recv(): Promise<unknown>;
  close(): Promise<void> | void;
}): AhpTransport {
  return {
    send(message: JsonRpcMessage | string): Promise<void> | void {
      return transport.send(message);
    },
    async recv(): Promise<TransportFrame | null> {
      const message = await transport.recv();
      if (message === null) {
        return null;
      }
      if (typeof message === 'string') {
        return { kind: 'text', text: message };
      }
      return { kind: 'parsed', message: message as never };
    },
    close(): Promise<void> | void {
      return transport.close();
    },
  };
}
