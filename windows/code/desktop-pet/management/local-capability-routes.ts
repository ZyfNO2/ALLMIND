// RWR-05 / CONTRACTS §4: the read-only local capability query.
//
//   GET /api/roles/local-capabilities -> LocalCapabilityReport
//
// The route is deliberately thin: it resolves the CONTROLLED resource directory the runtime already
// knows about and hands it to the detector. It never accepts a path, a model name, or a directory from
// the request — an HTTP caller cannot make the backend read an arbitrary file.
import { ManagementError } from '../contracts/management.js';
import {
  detectLocalCapabilities, LOCAL_CAPABILITIES_API_VERSION,
  type LocalCapabilityReport,
} from '../providers/local-capabilities.js';

export { LOCAL_CAPABILITIES_API_VERSION, type LocalCapabilityReport };

/** What the route needs from the composition root: the controlled model directory, if one is configured. */
export interface LocalCapabilityProbe {
  readonly sherpaDirectory?: string | undefined;
  readonly now?: (() => string) | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * `/api/roles/local-capabilities` — enumerate and verify the LOCAL voice sources on this machine.
 *
 * A detection failure is NOT an error response: "this machine has no Sherpa package" is a normal,
 * reportable state. The route answers 503 only when the capability cannot be probed at all, which
 * keeps a missing local source from looking like a broken backend.
 */
export async function localCapabilitiesRoute(
  method: string | undefined,
  pathname: string,
  probe: LocalCapabilityProbe | undefined,
): Promise<unknown> {
  if (pathname !== '/api/roles/local-capabilities') return undefined;
  if (method !== 'GET') throw new ManagementError('not_found', '没有这个本地能力操作。');
  if (!probe) throw new ManagementError('unavailable', '当前实例尚未接入本地能力检测。');
  const report = await detectLocalCapabilities({
    ...(probe.sherpaDirectory === undefined ? {} : { sherpaDirectory: probe.sherpaDirectory }),
    ...(probe.now ? { now: probe.now } : {}),
    ...(probe.timeoutMs === undefined ? {} : { timeoutMs: probe.timeoutMs }),
  });
  return { apiVersion: LOCAL_CAPABILITIES_API_VERSION, ...report };
}
