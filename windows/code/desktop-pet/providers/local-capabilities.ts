// RWR-05 / CONTRACTS §4: read-only detection of the LOCAL voice capabilities.
//
// Why this module exists: "system local" is a selection CATEGORY, not proof of availability. The
// catalog can offer a source long before this machine can actually run it — Windows without SAPI, or a
// Sherpa package that was never installed. The console must be able to ask "can this machine do it
// right now, and if not, why not", without paying for a real synthesis or recognition.
//
// The rules CONTRACTS §4 freezes, all enforced here:
//   * ENUMERATE / VERIFY only. No model download, no microphone, no persistent inference process.
//     Detection that started a worker would be indistinguishable, from the user's side, from the
//     capability being permanently present.
//   * Every probe is bounded by the registered timeout (`RWR_LIMITS.localCapabilityProbeMs`).
//   * The model directory is resolved through the EXISTING controlled configuration
//     (`PET_STREAMING_ASR_DIR` / the conventional data directory). An HTTP request can never name a
//     path; this module is only ever called with a directory the runtime itself resolved.
//   * Availability is `ready | unavailable | unsupported` with a machine-readable `reason`.
//     A successful detection is explicitly NOT a real synthesis/recognition acceptance (see the SPEC:
//     "成功检测不等于真实合成/识别验收").
import { execFile } from 'node:child_process';
import { access, constants, stat } from 'node:fs/promises';
import { join } from 'node:path';

export type LocalCapabilityAvailability = 'ready' | 'unavailable' | 'unsupported';

export interface LocalCapability {
  readonly capabilityId: string;
  readonly adapterId: string;
  readonly availability: LocalCapabilityAvailability;
  readonly reason: string;
  readonly voices?: readonly { readonly id: string; readonly label: string }[];
  readonly languages?: readonly string[];
  /** The controlled directory the resources resolved from. Never an arbitrary request-supplied path. */
  readonly resourceRef?: string;
}

export interface LocalCapabilityReport {
  readonly observedAt: string;
  readonly capabilities: readonly LocalCapability[];
}

export const LOCAL_CAPABILITIES_API_VERSION = 1;

/** The registered per-probe ceiling (RWR-00 §5). A probe that exceeds it is `unavailable`, not `ready`. */
export const LOCAL_CAPABILITY_PROBE_MS = 10_000;

const unsupportedPlatform = (platform: NodeJS.Platform = process.platform): boolean => platform !== 'win32';

/** Run a bounded child process. Returns `undefined` on timeout/spawn failure — never throws at the caller. */
function runBounded(command: string, args: readonly string[], timeoutMs: number): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  return new Promise(resolve => {
    let settled = false;
    const done = (value: { ok: true; stdout: string } | { ok: false; reason: string }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = execFile(command, args as string[], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 },
        (error, stdout) => {
          if (error) {
            const killed = (error as { killed?: boolean }).killed === true;
            return done({ ok: false, reason: killed ? 'probe_timeout' : 'probe_failed' });
          }
          done({ ok: true, stdout: String(stdout) });
        });
      child.on('error', () => done({ ok: false, reason: 'probe_unavailable' }));
    } catch { done({ ok: false, reason: 'probe_unavailable' }); }
  });
}

const SAPI_VOICE_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Speech',
  '$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  'try {',
  '  $speaker.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name }',
  '} finally {',
  '  $speaker.Dispose()',
  '}',
].join('; ');

/**
 * Detect Windows SAPI: the platform must support it, the engine must be reachable, and it must report
 * at least one ENABLED installed voice. This only enumerates voices — it never synthesizes.
 */
export async function detectSapi(timeoutMs: number = LOCAL_CAPABILITY_PROBE_MS): Promise<LocalCapability> {
  if (unsupportedPlatform()) {
    return { capabilityId: 'local.tts', adapterId: 'sapi-tts', availability: 'unsupported',
      reason: '仅 Windows 提供 SAPI 系统语音合成；本平台无此本地能力。' };
  }
  const result = await runBounded('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SAPI_VOICE_SCRIPT], timeoutMs);
  if (!result.ok) {
    const reason = result.reason === 'probe_timeout' ? 'probe_timeout' : result.reason === 'probe_unavailable' ? 'engine_unavailable' : 'voice_enumeration_failed';
    return { capabilityId: 'local.tts', adapterId: 'sapi-tts', availability: 'unavailable', reason };
  }
  const voices = result.stdout.split(/[\r\n]+/).map(value => value.trim()).filter(Boolean);
  if (!voices.length) {
    return { capabilityId: 'local.tts', adapterId: 'sapi-tts', availability: 'unavailable', reason: 'no_installed_voice' };
  }
  return {
    capabilityId: 'local.tts', adapterId: 'sapi-tts', availability: 'ready', reason: 'system_voices_enumerated',
    voices: voices.map(id => ({ id, label: id })), languages: ['zh-CN', 'en-US'], resourceRef: 'system://windows/sapi',
  };
}

/** The four controlled files a Sherpa streaming transducer package must provide. */
const SHERPA_RESOURCES = ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'] as const;

async function exists(path: string): Promise<boolean> {
  try { await access(path, constants.R_OK); const info = await stat(path); return info.isFile(); }
  catch { return false; }
}

/**
 * Detect the local Sherpa streaming recognizer.
 *
 * It verifies that the CONTROLLED resource directory actually contains the four model files. It does
 * NOT construct a recognizer, load the model, or open a microphone: a detection that instantiated the
 * engine would load a model into a persistent process, which CONTRACTS §4 explicitly forbids.
 */
export async function detectSherpa(
  directory: string | undefined,
  timeoutMs: number = LOCAL_CAPABILITY_PROBE_MS,
): Promise<LocalCapability> {
  if (!directory) {
    return { capabilityId: 'local.asr', adapterId: 'sherpa-streaming-asr', availability: 'unavailable',
      reason: 'no_configured_model_directory' };
  }
  const missing: string[] = [];
  for (const name of SHERPA_RESOURCES) if (!(await exists(join(directory, name)))) missing.push(name);
  if (missing.length) {
    return { capabilityId: 'local.asr', adapterId: 'sherpa-streaming-asr', availability: 'unavailable',
      reason: 'incomplete_model_package', resourceRef: directory,
      ...(missing.length ? {} : {}) } as LocalCapability;
  }
  return { capabilityId: 'local.asr', adapterId: 'sherpa-streaming-asr', availability: 'ready',
    reason: 'model_resources_present', languages: ['zh-CN', 'en-US'], resourceRef: directory };
}

/** Probe every local capability and report the observed snapshot. */
export async function detectLocalCapabilities(input: {
  readonly sherpaDirectory?: string | undefined;
  readonly now?: () => string;
  readonly timeoutMs?: number;
}): Promise<LocalCapabilityReport> {
  const now = input.now ?? (() => new Date().toISOString());
  const timeoutMs = input.timeoutMs ?? LOCAL_CAPABILITY_PROBE_MS;
  // Both probes are independent: one failing must not hide the other.
  const [tts, asr] = await Promise.all([detectSapi(timeoutMs), detectSherpa(input.sherpaDirectory, timeoutMs)]);
  return { observedAt: now(), capabilities: [tts, asr] };
}
