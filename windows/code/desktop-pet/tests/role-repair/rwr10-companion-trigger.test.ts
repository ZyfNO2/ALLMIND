import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { productionPairing } from '../../contracts/character-pack.js';
import type { DesktopEvent, DialogueContext, DialogueProvider, DialogueReply, TurnScope } from '../../contracts/index.js';
import { CaptureGrantManager } from '../../core/perception-grant.js';
import { ScreenCaptureSource } from '../../core/screen-capture-source.js';
import { ScreenPerceptionService } from '../../core/screen-perception.js';
import { ObservationContextAdapter, ObservationAwareDialogueProvider, ObservationTurnInbox } from '../../core/observation-context.js';
import { DesktopRuntime } from '../../core/desktop-runtime.js';
import { CompanionModeRuntime } from '../../core/companion-mode-runtime.js';
import { ScreenGrantRuntime } from '../../management/screen-grant-runtime.js';
import { CompanionTriggerRuntime } from '../../management/companion-trigger-runtime.js';
import { companionTriggerRoute } from '../../management/companion-trigger-routes.js';
import { ManagementError } from '../../contracts/management.js';
import type { DesktopHostBridge } from '../../app/desktop-host-bridge.js';
import { parseDesktopCommand } from '../../app/backend-session.js';

const pairing = productionPairing('companion', 'rwr10-trigger');
const target = { targetId: 'display-trigger', targetRevision: 3, kind: 'screen' as const, displayName: 'Fixture display',
  bounds: { x: 0, y: 0, width: 800, height: 600 }, scaleFactor: 1 };
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function context(scope: TurnScope): DialogueContext {
  return { scope, characterPrompt: 'Fixture', recent: [], summary: '', memories: [], perception: null, inputTokenBudget: 200 };
}
function fixturePorts(dialogue: DialogueProvider, append: (messages: readonly { role: string; text: string }[]) => void) {
  return {
    outputMode: 'text' as const,
    capture: { start: async () => {}, finish: async () => { throw new Error('not used'); }, stop: async () => {} },
    playback: { play: async () => {}, stop: async () => {} },
    mediaStore: { put: async () => { throw new Error('not used'); }, read: async () => { throw new Error('not used'); }, releaseScope: async () => {} },
    memory: {
      context: async (scope: TurnScope) => context(scope),
      append: async (_scope: TurnScope, messages: readonly { role: string; text: string }[]) => append(messages),
      maintain: async () => [],
    },
    perception: { perceive: async () => { throw new Error('not used'); } },
    dialogue,
    tts: { synthesize: async () => { throw new Error('text output must not synthesize'); } },
  };
}

function persistentStore() {
  const root = mkdtempSync(join(tmpdir(), 'rwr10-trigger-'));
  return new SqliteMemoryStore({ filename: resolve(root, 'memory.sqlite'), retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai') });
}

async function authorizeSingle(screen: ScreenGrantRuntime, mode: CompanionModeRuntime): Promise<void> {
  const selected = await screen.selectTarget({ pairing, operationId: 'select-display' }) as { revision: number };
  await screen.issue({ pairing, expectedRevision: selected.revision, operationId: 'capture-single', purpose: 'capture-single',
    destination: 'local', targetId: target.targetId, targetRevision: target.targetRevision, userConfirmed: true });
  await mode.issueContextUseGrant({ operationId: 'context-trigger', expectedRevision: 0, observationSourceScopes: [`screen:${target.targetId}`],
    modelBinding: 'provider:model', destination: 'cloud', ttlMs: 60_000 });
}

test('RWR-10-06: companion trigger uses the existing single-turn pipeline without creating a user message', async () => {
  const store = persistentStore();
  try {
    const manager = new CaptureGrantManager();
    const perception = new ScreenPerceptionService(manager, { localOcrEngine: async () => ({ status: 'ok', engine: 'pixel-fixture', blocks: [], readingOrderText: 'private fixture OCR' }) });
    const grant = manager.issueGrant({ sessionId: 'capture-session', scopeType: 'screen', targetId: target.targetId, bounds: target.bounds,
      purpose: 'capture-single', destination: 'local', duration: 'single' });
    const observation = await perception.processCapture({ grantId: grant.grantId, targetId: target.targetId, targetRevision: target.targetRevision,
      imageBytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }, pairing);
    const inbox = new ObservationTurnInbox(perception, new ObservationContextAdapter(perception));
    const appended: Array<{ role: string; text: string }> = [];
    const events: DesktopEvent[] = [];
    let savedConversationCount = 0;
    const provider = new ObservationAwareDialogueProvider({ reply: async request => {
      assert.equal(request.text, '', 'the trigger has no fabricated submit text');
      assert.ok(request.context.screenObservation?.text.includes('private fixture OCR'));
      return { scope: request.scope, text: 'Fixture response', expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } };
    } }, inbox, pairing);
    const ports = fixturePorts(provider, messages => appended.push(...messages));
    const runtime = new DesktopRuntime(ports as never, event => events.push(event), () => { savedConversationCount++; });
    await runtime.dispatch({ type: 'companion_trigger', triggerId: 'rwr10-trigger-Zml4dHVyZQ', observationId: observation.observationId });
    await runtime.drain();
    assert.deepEqual(appended.map(message => message.role), ['assistant']);
    assert.equal(savedConversationCount, 0, 'proactive output does not enter the user conversation lifecycle');
    const turn = events.find((event): event is Extract<DesktopEvent, { type: 'turn' }> => event.type === 'turn');
    const reply = events.find((event): event is Extract<DesktopEvent, { type: 'reply' }> => event.type === 'reply');
    assert.equal(turn?.input.provenance?.observationId, observation.observationId);
    assert.equal(reply?.provenance?.triggerId, 'rwr10-trigger-Zml4dHVyZQ');
    assert.equal(events.some(event => event.type === 'transcript'), false);
    await runtime.close();
  } finally { store.close(); }
});

test('RWR-10-06: idempotent screen trigger captures once, delivers by renderer acknowledgement, and survives restart', async () => {
  const store = persistentStore();
  const frameBytes = png.slice();
  try {
    let captureCount = 0;
    const source = new ScreenCaptureSource({ captureHook: async picked => {
      captureCount++;
      return { targetId: picked.targetId, targetRevision: picked.targetRevision, capturedAt: new Date().toISOString(),
        mimeType: 'image/png', dimensions: { width: 800, height: 600 }, bytes: frameBytes };
    } });
    // The production ScreenGrantRuntime owns the source; replace only the fixture's source through a fresh grant runtime.
    const manager = new CaptureGrantManager();
    const bridge = { request: async () => ({ outcome: 'selected', target }) } as unknown as DesktopHostBridge;
    const testMode = new CompanionModeRuntime({ db: store.rawDatabaseForKnowledge(), pairing });
    const testScreen = new ScreenGrantRuntime({ bridge, grants: manager, captureSource: source, pairing, runtimeSessionId: 'screen-session',
      companionMode: testMode, capabilities: { capture: true, localOcr: true, cloudVlm: false } });
    await authorizeSingle(testScreen, testMode);
    const testPerception = new ScreenPerceptionService(manager, { localOcrEngine: async () => ({ status: 'ok', engine: 'pixel-fixture', blocks: [],
      readingOrderText: 'Fixture screen content' }) });
    let resolveDispatch!: () => void;
    const dispatched = new Promise<void>(resolve => { resolveDispatch = resolve; });
    const session = {
      identity: () => ({ characterId: pairing.characterId, sessionId: 'turn-session-1', generation: 0 }),
      readiness: () => ({ ready: true }),
      dispatch: async (triggerId: string, observationId: string) => {
        assert.match(triggerId, /^rwr10-trigger-/); assert.match(observationId, /^obs-/); resolveDispatch();
      },
      cancel: async () => true,
    };
    const trigger = new CompanionTriggerRuntime({ pairing, mode: testMode, screenGrants: testScreen, perception: testPerception,
      session, requiresContextUseGrant: true, dialogueModelBinding: 'provider:model' });
    const request = { pairing, operationId: 'screen-trigger-operation', kind: 'screen' as const };
    const first = await trigger.trigger(request);
    assert.equal(first.outcome, 'accepted');
    const replay = await trigger.trigger(request);
    assert.equal(replay.triggerId, first.triggerId);
    await dispatched;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(captureCount, 1);
    assert.equal(trigger.get(first.triggerId, pairing)?.status, 'generating');
    const scope = { characterId: pairing.characterId, sessionId: 'turn-session-1', turnId: 'trigger-turn', generation: 1 };
    await trigger.replyDisplayed(first.triggerId, scope);
    assert.equal(trigger.get(first.triggerId, pairing)?.status, 'delivered');
    assert.ok([...frameBytes].every(byte => byte === 0), 'frame bytes are scrubbed after OCR');
    const restarted = new CompanionModeRuntime({ db: store.rawDatabaseForKnowledge(), pairing });
    assert.equal(restarted.getCompanionTrigger(first.triggerId, pairing)?.status, 'delivered');
    const duplicateAfterDelivery = await trigger.trigger(request);
    assert.equal(duplicateAfterDelivery.status, 'delivered');
    assert.equal(captureCount, 1);
    await assert.rejects(() => trigger.trigger({ ...request, kind: 'greeting' }), /different trigger kind/);
  } finally { store.close(); }
});

test('RWR-10-06: trigger route rejects client-supplied capture payloads and target claims', async () => {
  let calls = 0;
  const runtime = { trigger: async () => { calls++; return { outcome: 'unavailable', triggerId: 'x', status: 'failed' }; } } as unknown as CompanionTriggerRuntime;
  await assert.rejects(() => companionTriggerRoute('POST', runtime, '/api/companion/trigger', new URLSearchParams(),
    async () => ({ pairing, operationId: 'bad', kind: 'screen', imageBase64: 'fixture', targetId: target.targetId }), () => {}),
  (error: unknown) => error instanceof ManagementError && error.code === 'invalid_request');
  assert.equal(calls, 0);
});

test('RWR-10-06: renderer may only acknowledge the exact server-owned trigger reply scope', () => {
  const scope = { characterId: pairing.characterId, sessionId: 'session-1', turnId: 'turn-1', generation: 1 };
  assert.deepEqual(parseDesktopCommand({ type: 'acknowledge_companion_reply', triggerId: 'rwr10-trigger-Zml4dHVyZQ', scope }),
    { type: 'acknowledge_companion_reply', triggerId: 'rwr10-trigger-Zml4dHVyZQ', scope });
  assert.throws(() => parseDesktopCommand({ type: 'companion_trigger', triggerId: 'rwr10-trigger-evil', observationId: 'obs-fake' }), /Unsupported/);
  assert.throws(() => parseDesktopCommand({ type: 'acknowledge_companion_reply', triggerId: 'another-trigger', scope }), /Invalid companion reply acknowledgement/);
});
