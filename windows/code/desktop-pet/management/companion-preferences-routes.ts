import { ManagementError } from '../contracts/management.js';
import { confirmedInvitationPolicy } from '../companion/invitations.js';
import type { PairingScope } from '../contracts/character-pack.js';
import type { CompanionAutomationPreferencesRecord } from '../contracts/companion-mode.js';
import type { CompanionModeRuntime } from '../core/companion-mode-runtime.js';
import type { ScreenGrantRuntime } from './screen-grant-runtime.js';

const PATCH_KEYS = new Set(['screen', 'observationIntervalMs', 'replyCooldownMs', 'dailyMax', 'timezone', 'dndStartHour', 'dndEndHour', 'greetingRules']);
const SCREEN_KEYS = new Set(['enabled', 'targetId', 'targetRevision', 'recognitionRoute', 'destination']);

export async function companionPreferencesRoute(
  method: string | undefined,
  runtime: CompanionModeRuntime | undefined,
  screen: ScreenGrantRuntime | undefined,
  pathname: string,
  query: URLSearchParams,
  body: () => Promise<Record<string, unknown>>,
  send: (value: unknown) => void,
  /** CK-13: the installed periodic scheduler. Absent leaves the section honestly unavailable. */
  automation?: { view(): { state: string; reason: string | null; nextEligibleAt: string | null } },
): Promise<boolean> {
  if (pathname !== '/api/companion/preferences') return false;
  if (!runtime) throw new ManagementError('unavailable', '当前实例未装配陪伴偏好 owner。');
  const pairing = runtime.getPolicy().pairing;

  if (method === 'GET') {
    const requested = queryPairing(query);
    assertPairing(pairing, requested);
    send(view(runtime.getAutomationPreferences(), pairing, screen, automation?.view()));
    return true;
  }
  if (method === 'PUT') {
    const value = await body();
    exactKeys(value, new Set(['pairing', 'expectedRevision', 'operationId', 'patch']), 'request');
    assertPairing(pairing, parsePairing(value.pairing));
    if (!Number.isSafeInteger(value.expectedRevision) || typeof value.operationId !== 'string' || !value.operationId.trim() || value.operationId.length > 200) {
      throw new ManagementError('invalid_request', 'expectedRevision 或 operationId 无效。');
    }
    const patch = parsePatch(value.patch);
    try {
      const receipt = await runtime.setAutomationPreferences({ expectedRevision: value.expectedRevision as number, operationId: value.operationId, patch },
        () => assertTargetReference(patch, pairing, screen));
      send(view(receipt, pairing, screen, automation?.view()));
    } catch (error) {
      if (error instanceof ManagementError) throw error;
      const code = (error as { code?: string })?.code;
      if (code === 'version_conflict' || code === 'operation_conflict' || ((error as Error).message === 'Operation ID reused with conflicting body.'))
        throw new ManagementError('version_conflict', '陪伴设置已更新或操作编号冲突；请刷新后重试。');
      throw new ManagementError('invalid_request', (error as Error).message || '陪伴偏好无效。');
    }
    return true;
  }
  return false;
}

function queryPairing(query: URLSearchParams): PairingScope {
  const userId = query.get('userId'), characterId = query.get('characterId'), characterInstanceId = query.get('characterInstanceId');
  if (!userId || !characterId || !characterInstanceId) throw new ManagementError('invalid_request', '必须显式提供 userId、characterId 和 characterInstanceId。');
  return { userId, characterId, characterInstanceId };
}
function parsePairing(value: unknown): PairingScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ManagementError('invalid_request', 'pairing 无效。');
  const pairing = value as Record<string, unknown>;
  exactKeys(pairing, new Set(['userId', 'characterId', 'characterInstanceId']), 'pairing');
  if (![pairing.userId, pairing.characterId, pairing.characterInstanceId].every(item => typeof item === 'string' && !!item.trim())) {
    throw new ManagementError('invalid_request', 'pairing 无效。');
  }
  return pairing as unknown as PairingScope;
}
function assertPairing(expected: PairingScope, actual: PairingScope): void {
  if (expected.userId !== actual.userId || expected.characterId !== actual.characterId || expected.characterInstanceId !== actual.characterInstanceId) {
    throw new ManagementError('forbidden', '陪伴偏好不属于当前运行角色。');
  }
}
function parsePatch(value: unknown): Parameters<CompanionModeRuntime['setAutomationPreferences']>[0]['patch'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ManagementError('invalid_request', 'patch 无效。');
  const patch = value as Record<string, unknown>;
  exactKeys(patch, PATCH_KEYS, 'patch');
  if (Object.hasOwn(patch, 'screen')) {
    if (!patch.screen || typeof patch.screen !== 'object' || Array.isArray(patch.screen)) throw new ManagementError('invalid_request', 'screen 偏好无效。');
    exactKeys(patch.screen as Record<string, unknown>, SCREEN_KEYS, 'screen');
  }
  return patch as Parameters<CompanionModeRuntime['setAutomationPreferences']>[0]['patch'];
}
function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  if (Object.keys(value).some(key => !allowed.has(key))) throw new ManagementError('invalid_request', `${label} 包含不允许的字段。`);
}
function assertTargetReference(
  patch: Parameters<CompanionModeRuntime['setAutomationPreferences']>[0]['patch'],
  pairing: PairingScope,
  screen: ScreenGrantRuntime | undefined,
): void {
  if (!patch.screen || patch.screen.targetId === undefined) return;
  if (patch.screen.targetId === null) {
    if (patch.screen.targetRevision !== undefined && patch.screen.targetRevision !== null) throw new ManagementError('invalid_request', '清除目标时 targetRevision 必须为空。');
    return;
  }
  if (!screen) throw new ManagementError('unavailable', '屏幕目标管理未装配。');
  const state = screen.getGrants(pairing) as { target?: { targetId?: string; targetRevision?: number } | null };
  if (!state.target || state.target.targetId !== patch.screen.targetId || state.target.targetRevision !== patch.screen.targetRevision) {
    throw new ManagementError('forbidden', '目标引用必须来自当前宿主已选择的屏幕目标；保存不会签发授权。');
  }
}
function view(
  record: CompanionAutomationPreferencesRecord,
  pairing: PairingScope,
  screen: ScreenGrantRuntime | undefined,
  automation?: { readonly state: string; readonly reason: string | null; readonly nextEligibleAt: string | null },
) {
  const grants = screen?.getGrants(pairing) as { target?: { targetId?: string; targetRevision?: number } | null; capabilities?: Record<string, boolean>; grants?: Array<{ purpose?: string; grant?: Record<string, unknown> }>; missingReasons?: string[] } | undefined;
  const selected = !!grants?.target && grants.target.targetId === record.saved.screen.targetId
    && grants.target.targetRevision === record.saved.screen.targetRevision;
  const continuous = !!grants?.grants?.some(item => item.purpose === 'capture-continuous' && item.grant?.state === 'active'
    && item.grant.targetId === record.saved.screen.targetId && item.grant.targetRevision === record.saved.screen.targetRevision
    && item.grant.destination === 'local' && Date.parse(String(item.grant.expiry ?? '')) > Date.now());
  const routeAvailable = record.saved.screen.recognitionRoute === 'local-ocr'
    ? grants?.capabilities?.localOcr === true
    : grants?.capabilities?.cloudVlm === true;
  // CK-13: the scheduler's real state replaces the hard-coded `false`. When no scheduler is wired
  // the answer stays `false` — but now that is an honest "not installed" rather than a placeholder
  // that could never become true.
  const schedulerAvailable = automation !== undefined;
  const screenEffective = record.saved.screen.enabled && selected && continuous && grants?.capabilities?.capture === true && routeAvailable && schedulerAvailable;
  const reason = !record.saved.screen.enabled ? 'disabled'
    : !selected ? 'screen_target_not_selected'
      : !continuous ? 'continuous_screen_grant_required'
        : grants?.capabilities?.capture !== true ? 'real_screen_capture_unavailable'
          : !routeAvailable ? (record.saved.screen.recognitionRoute === 'local-ocr' ? 'pixel_ocr_unavailable' : 'cloud_vlm_unavailable')
            : !schedulerAvailable ? 'automatic_scheduler_unavailable'
              : (automation?.reason ?? null);
  const sharedPolicy = confirmedInvitationPolicy(record.saved.timezone);
  const effective = {
    ...record.saved,
    screen: { ...record.saved.screen, enabled: screenEffective },
    replyCooldownMs: Math.max(record.saved.replyCooldownMs, sharedPolicy.minIntervalMs),
    dailyMax: Math.min(record.saved.dailyMax, sharedPolicy.dailyMax),
  };
  const greetingEnabled = record.saved.greetingRules.some(rule => rule.enabled);
  const enabled = record.saved.screen.enabled || greetingEnabled;
  const authorizationMissing = record.saved.screen.enabled && (!selected || !continuous);
  // CK-13: runState and nextEligibleAt come from the real scheduler when one is installed.
  const runState = automation?.state
    ?? (!enabled ? 'paused' : authorizationMissing ? 'needs-authorization' : 'unavailable');
  return {
    revision: record.revision,
    pairing,
    saved: record.saved,
    effective,
    capabilityStatus: {
      targetSelected: selected,
      continuousGrant: continuous,
      capture: grants?.capabilities?.capture === true,
      localOcr: grants?.capabilities?.localOcr === true,
      cloudVlm: grants?.capabilities?.cloudVlm === true,
      missingReasons: grants?.missingReasons ?? ['screen_target_management_unavailable'],
    },
    runState,
    reason: record.saved.screen.enabled ? reason : greetingEnabled ? 'greeting_scheduler_unavailable' : 'disabled',
    // CK-13: no longer a hard-coded null — it is the scheduler's real next due time.
    nextEligibleAt: automation?.nextEligibleAt ?? null,
  };
}
