import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicTarget, capturePublicDocument } from '../../memory/resource-web.js';

test('encoded IPv4-mapped loopback and private IPv6 addresses fail before fetching', async () => {
  for (const address of ['http://[::ffff:7f00:1]/', 'http://[::ffff:a00:1]/', 'http://[fe90::1]/', 'http://[ff02::1]/']) {
    await assert.rejects(() => assertPublicTarget(address), /不允许/);
  }
});

test('web capture cancels an oversized streaming response without buffering its remainder', async () => {
  let cancelled = false, emitted = 0;
  await assert.rejects(() => capturePublicDocument('https://synthetic.example/', new AbortController().signal, {
    resolveHost: async () => ['93.184.216.34'],
    fetch: async () => new Response(new ReadableStream({
      pull(controller) { emitted++; controller.enqueue(new Uint8Array(1024*1024)); },
      cancel() { cancelled = true; }
    }), {headers:{'content-type':'text/plain'}})
  }), /超过 2 MiB/);
  assert.equal(cancelled, true);
  assert.ok(emitted <= 4);
});
