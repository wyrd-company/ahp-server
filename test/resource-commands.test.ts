import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';

import { AhpClient } from '@microsoft/agent-host-protocol/client';
import type { AhpTransport, JsonRpcMessage, TransportFrame } from '@microsoft/agent-host-protocol/client';
import type { ContentEncoding, ResourceType } from '@microsoft/agent-host-protocol';

import {
  AhpServer,
  createInMemoryTransportPair,
} from '../src/index.js';

const runningServers: Array<Promise<void>> = [];

after(async () => {
  await Promise.allSettled(runningServers);
});

test('serves file resource commands through the AHP client', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ahp-resources-'));
  const outside = resolve(root, '..', `${root.split('/').pop()}-outside.txt`);
  const rootUri = pathToFileURL(root).href;
  const server = new AhpServer({
    providers: [],
    defaultDirectory: rootUri,
  });
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  runningServers.push(server.accept(serverTransport));
  const client = new AhpClient(clientTransport, { requestTimeoutMs: 1_000 });

  try {
    client.connect();
    const init = await client.initialize({ clientId: 'resource-client', protocolVersions: ['0.3.0'] });
    assert.equal(init.defaultDirectory, rootUri);

    const dirUri = resourceUri(root, 'nested/deeper');
    const fileUri = resourceUri(root, 'nested/deeper/hello.txt');
    const copyUri = resourceUri(root, 'nested/deeper/copy.txt');
    const movedUri = resourceUri(root, 'nested/deeper/moved.txt');

    await client.request('resourceMkdir', { channel: 'ahp-root://', uri: dirUri });
    await client.request('resourceWrite', {
      channel: 'ahp-root://',
      uri: fileUri,
      data: 'Hello',
      encoding: 'utf-8' as ContentEncoding,
    });
    await client.request('resourceWrite', {
      channel: 'ahp-root://',
      uri: fileUri,
      data: ' world',
      encoding: 'utf-8' as ContentEncoding,
      mode: 'append' as never,
    });
    await client.request('resourceWrite', {
      channel: 'ahp-root://',
      uri: fileUri,
      data: ' brave',
      encoding: 'utf-8' as ContentEncoding,
      mode: 'insert' as never,
      position: 5,
    });

    const read = await client.request('resourceRead', {
      channel: 'ahp-root://',
      uri: fileUri,
      encoding: 'utf-8' as ContentEncoding,
    });
    assert.equal(read.data, 'Hello brave world');
    assert.equal(read.encoding, 'utf-8');

    const resolved = await client.request('resourceResolve', {
      channel: 'ahp-root://',
      uri: fileUri,
    });
    assert.equal(resolved.type, 'file' as ResourceType);
    assert.equal(resolved.size, 'Hello brave world'.length);
    assert.ok(resolved.etag);

    await assert.rejects(
      () => client.request('resourceWrite', {
        channel: 'ahp-root://',
        uri: fileUri,
        data: 'stale',
        encoding: 'utf-8' as ContentEncoding,
        ifMatch: 'W/"stale"',
      }),
      /etag does not match/,
    );

    const listed = await client.request('resourceList', {
      channel: 'ahp-root://',
      uri: dirUri,
    });
    assert.deepEqual(listed.entries, [{ name: 'hello.txt', type: 'file' }]);

    await client.request('resourceCopy', {
      channel: 'ahp-root://',
      source: fileUri,
      destination: copyUri,
    });
    await client.request('resourceMove', {
      channel: 'ahp-root://',
      source: copyUri,
      destination: movedUri,
    });
    assert.equal(readFileSync(filePath(root, 'nested/deeper/moved.txt'), 'utf8'), 'Hello brave world');

    await client.request('resourceDelete', {
      channel: 'ahp-root://',
      uri: movedUri,
    });
    await assert.rejects(
      () => client.request('resourceResolve', { channel: 'ahp-root://', uri: movedUri }),
      /resource not found/,
    );

    writeFileSync(outside, 'outside');
    symlinkSync(outside, filePath(root, 'nested/deeper/link-outside.txt'));
    await assert.rejects(
      () => client.request('resourceRead', {
        channel: 'ahp-root://',
        uri: pathToFileURL(outside).href,
        encoding: 'utf-8' as ContentEncoding,
      }),
      /outside allowed roots/,
    );
    await assert.rejects(
      () => client.request('resourceRead', {
        channel: 'ahp-root://',
        uri: resourceUri(root, 'nested/deeper/link-outside.txt'),
        encoding: 'utf-8' as ContentEncoding,
      }),
      /outside allowed roots/,
    );
  } finally {
    await client.shutdown().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

function resourceUri(root: string, relativePath: string): string {
  return pathToFileURL(filePath(root, relativePath)).href;
}

function filePath(root: string, relativePath: string): string {
  return join(root, ...relativePath.split('/'));
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
