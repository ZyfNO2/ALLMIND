import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopHostBridge, DesktopHostError } from '../../app/desktop-host-bridge.js';
import { desktopHostManagement, desktopHostRoute } from '../../management/desktop-host-routes.js';
import { ManagementError } from '../../contracts/management.js';

/**
 * RWR-10-01 AC-01-1: the management route must reach the host through the stdio bridge, and it must never
 * report success the host did not confirm. These tests drive the real bridge and the real route against a
 * scripted host, so the correlation logic under test is the production one.
 */
function scriptedHost(reply: (message: Record<string, unknown>) => unknown | undefined) {
  const sent: Record<string, unknown>[] = [];
  const bridge = new DesktopHostBridge({ send: message => { sent.push(message as Record<string, unknown>); }, timeoutMs: 200 });
  return { bridge, sent, reply };
}

/** Answer the most recent request the way the real Electron host does. */
function answer(bridge: DesktopHostBridge, sent: Record<string, unknown>[], result: unknown, ok = true) {
  const last = sent.at(-1)!;
  bridge.receive(ok
    ? { channel: 'host_reply', requestId: last.requestId, ok: true, result }
    : { channel: 'host_reply', requestId: last.requestId, ok: false, error: result });
}

const preferences = {
  apiVersion: 1, revision: 2, hotkey: 'KeyV', replySound: true,
  display: { mode: 'full', preferredWidth: 360, modelWidth: 340, modelHeight: 321, drawerHeight: 0 },
  capabilities: { hotkey: 'window-only', filePicker: false, display: true, preferences: true },
};

test('RWR-10-01: GET /api/desktop/preferences returns the host payload with the api version', async () => {
  const { bridge, sent } = scriptedHost(() => undefined);
  const port = desktopHostManagement(bridge, { instanceId: 'test' })!;
  const response: unknown[] = [];
  const pending = desktopHostRoute('GET', port, '/api/desktop/preferences', async () => ({}), value => response.push(value));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1, 'exactly one host request is sent');
  assert.equal(sent[0]!.channel, 'host_request');
  assert.equal(sent[0]!.method, 'preferences.get');
  answer(bridge, sent, preferences);
  assert.equal(await pending, true);
  assert.deepEqual(response[0], preferences);
  bridge.close();
});

test('RWR-10-01: PUT /api/desktop/preferences forwards a validated patch and returns the host receipt', async () => {
  const { bridge, sent } = scriptedHost(() => undefined);
  const port = desktopHostManagement(bridge, { instanceId: 'test' })!;
  const response: unknown[] = [];
  const receipt = { revision: 3, applied: ['hotkey'], preferences: { ...preferences, revision: 3, hotkey: 'KeyB' } };
  const pending = desktopHostRoute('PUT', port, '/api/desktop/preferences',
    async () => ({ expectedRevision: 2, operationId: 'op-1', patch: { hotkey: 'KeyB' } }), value => response.push(value));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent[0]!.method, 'preferences.patch');
  const params = sent[0]!.params as Record<string, unknown>;
  assert.equal(params.expectedRevision, 2);
  assert.equal(params.operationId, 'op-1');
  assert.deepEqual(params.patch, { hotkey: 'KeyB' });
  answer(bridge, sent, receipt);
  assert.equal(await pending, true);
  assert.deepEqual(response[0], receipt);
  bridge.close();
});

/** AC-01-1: a bad shape is a 400 before any host round-trip; the host is not asked to fix the client. */
test('RWR-10-01: invalid patches are refused at the HTTP edge without contacting the host', async () => {
  const { bridge, sent } = scriptedHost(() => undefined);
  const port = desktopHostManagement(bridge, { instanceId: 'test' })!;
  const call = (payload: Record<string, unknown>) =>
    desktopHostRoute('PUT', port, '/api/desktop/preferences', async () => payload, () => {});
  const rejects = async (payload: Record<string, unknown>, pattern: RegExp) => {
    await assert.rejects(call(payload), (error: unknown) => {
      assert.ok(error instanceof ManagementError);
      assert.equal(error.code, 'invalid_request');
      assert.match(error.message, pattern);
      return true;
    });
  };
  await rejects({ expectedRevision: -1, operationId: 'op', patch: { replySound: true } }, /修订号/);
  await rejects({ expectedRevision: 0, operationId: '  ', patch: { replySound: true } }, /操作编号/);
  await rejects({ expectedRevision: 0, operationId: 'op', patch: {} }, /没有需要保存/);
  await rejects({ expectedRevision: 0, operationId: 'op', patch: { nope: 1 } }, /不支持的设置项/);
  await rejects({ expectedRevision: 0, operationId: 'op', patch: { hotkey: 'Key!' } }, /按键/);
  await rejects({ expectedRevision: 0, operationId: 'op', patch: { mode: 'sideways' } }, /展示模式/);
  await rejects({ expectedRevision: 0, operationId: 'op', patch: { preferredWidth: 'wide' } }, /尺寸/);
  assert.equal(sent.length, 0, 'a rejected request never reaches the host');
  bridge.close();
});

/** AC-01-1: a host conflict must surface as 409 so the console keeps the draft instead of claiming success. */
test('RWR-10-01: host revision and operation conflicts map onto 409', async () => {
  for (const code of ['stale_revision', 'operation_conflict'] as const) {
    const { bridge, sent } = scriptedHost(() => undefined);
    const port = desktopHostManagement(bridge, { instanceId: 'test' })!;
    const pending = desktopHostRoute('PUT', port, '/api/desktop/preferences',
      async () => ({ expectedRevision: 1, operationId: 'op', patch: { replySound: true } }), () => {});
    await new Promise(resolve => setImmediate(resolve));
    answer(bridge, sent, { code, message: 'conflict' }, false);
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof ManagementError);
      assert.equal(error.code, 'version_conflict');
      return true;
    });
    bridge.close();
  }
});

/** AC-01-4: with no host attached the section reports unavailable rather than fabricating data. */
test('RWR-10-01: an unattached host reports unavailable instead of inventing preferences', async () => {
  assert.equal(desktopHostManagement(undefined, { instanceId: 'test' }), undefined);
  await assert.rejects(
    desktopHostRoute('GET', undefined, '/api/desktop/preferences', async () => ({}), () => {}),
    (error: unknown) => {
      assert.ok(error instanceof ManagementError);
      assert.equal(error.code, 'unavailable');
      assert.match(error.message, /未连接桌宠宿主/);
      return true;
    });
  // A path outside this route's prefix is not claimed.
  assert.equal(await desktopHostRoute('GET', undefined, '/api/other', async () => ({}), () => {}), false);
});

/** AC-01-1: a host that never answers must fail the request rather than hang it forever. */
test('RWR-10-01: a host that never answers times out as unavailable', async () => {
  const bridge = new DesktopHostBridge({ send: () => {}, timeoutMs: 60 });
  const port = desktopHostManagement(bridge, { instanceId: 'test' })!;
  await assert.rejects(port.preferences(), (error: unknown) => {
    assert.ok(error instanceof ManagementError);
    assert.equal(error.code, 'unavailable');
    assert.match(error.message, /宿主没有响应/);
    return true;
  });
  bridge.close();
});

/**
 * AC-01-1: a reply that arrives after its request settled must be dropped. Otherwise a late answer could
 * settle a newer request that happens to be waiting.
 */
test('RWR-10-01: a late or unknown host reply is dropped, not applied to another request', async () => {
  const { bridge, sent } = scriptedHost(() => undefined);
  const port = desktopHostManagement(bridge, { instanceId: 'test' })!;
  const first = desktopHostRoute('GET', port, '/api/desktop/preferences', async () => ({}), () => {});
  await new Promise(resolve => setImmediate(resolve));
  const firstId = sent[0]!.requestId as string;
  // A reply for an id this bridge never issued must not be claimed.
  assert.equal(bridge.receive({ channel: 'host_reply', requestId: 'foreign-id', ok: true, result: {} }), false);
  assert.equal(bridge.receive({ channel: 'not-a-reply', requestId: firstId }), false);
  answer(bridge, sent, preferences);
  await first;
  // The same id answered twice: the second reply has nothing left to settle.
  assert.equal(bridge.receive({ channel: 'host_reply', requestId: firstId, ok: true, result: preferences }), false);
  assert.equal(bridge.hostAnswered, true);
  bridge.close();
});

/** A closed bridge rejects rather than silently swallowing writes during shutdown. */
test('RWR-10-01: closing the bridge rejects in-flight and later requests', async () => {
  const bridge = new DesktopHostBridge({ send: () => {}, timeoutMs: 5000 });
  const pending = bridge.request('preferences.get', {});
  assert.equal(bridge.inFlight, 1);
  bridge.close();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof DesktopHostError);
    assert.equal(error.code, 'unavailable');
    return true;
  });
  await assert.rejects(bridge.request('preferences.get', {}), /已断开/);
});

/** The method union is closed: an unlisted method can never become a native call. */
test('RWR-10-01: only the frozen host methods are accepted', async () => {
  const sent: unknown[] = [];
  const bridge = new DesktopHostBridge({ send: message => sent.push(message), timeoutMs: 100 });
  await assert.rejects(
    bridge.request('shell.exec' as never, { command: 'calc.exe' }),
    (error: unknown) => {
      assert.ok(error instanceof DesktopHostError);
      assert.equal(error.code, 'unsupported');
      return true;
    });
  assert.equal(sent.length, 0, 'an unsupported method never reaches the host');
  bridge.close();
});
