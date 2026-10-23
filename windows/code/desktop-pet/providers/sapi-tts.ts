// Windows SAPI TTS: real offline synthesis through the OS Speech API (System.Speech) — no
// credentials, no network. Text rides through a temp file so quoting and command-length limits
// cannot corrupt it; output is 16 kHz 16-bit mono PCM WAV validated by inspectPcmWav before it
// reaches the media store. Used by the 06-F real replay; cloud providers stay behind their own
// adapters.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaStorePort, TtsProvider, TtsRequest, TtsResult } from '../contracts/index.js';
import { checkAbort } from '../media/scope.js';
import { inspectPcmWav } from '../media/wav.js';

export interface SapiSynthesisJob {
  readonly textPath: string;
  readonly outPath: string;
  /** Exact installed voice name (e.g. 'Microsoft Huihui Desktop'); OS default when omitted. */
  readonly voiceName?: string;
}

export interface SapiTtsOptions {
  readonly voiceName?: string;
  /** Overridable for unit tests; the default executes the job with Windows PowerShell. */
  readonly execute?: (job: SapiSynthesisJob) => Promise<void>;
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function renderSapiScript(job: SapiSynthesisJob): string {
  const selectVoice = job.voiceName
    ? `  $installed = $speaker.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }\n  if ($installed -notcontains ${psQuote(job.voiceName)}) { throw ${psQuote(`voice not installed: ${job.voiceName}`)} }\n  $speaker.SelectVoice(${psQuote(job.voiceName)})\n`
    : '';
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Speech',
    '$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    'try {',
    `  $text = Get-Content -LiteralPath ${psQuote(job.textPath)} -Raw -Encoding UTF8`,
    selectVoice +
    `  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)`,
    `  $speaker.SetOutputToWaveFile(${psQuote(job.outPath)}, $format)`,
    '  $speaker.Speak($text)',
    '} finally {',
    '  $speaker.Dispose()',
    '}',
    ''
  ].join('\r\n');
}

/** One PowerShell process per synthesis; rejects with a stderr tail when the job fails. */
export function runSapiJob(job: SapiSynthesisJob, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolveJob, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', renderSapiScript(job)], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8192); });
    const onAbort = () => { child.kill(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', error => { signal?.removeEventListener('abort', onAbort); reject(error); });
    child.on('close', code => {
      signal?.removeEventListener('abort', onAbort);
      if(signal?.aborted)reject(new DOMException('Turn cancelled','AbortError'));
      else if (code === 0) resolveJob();
      else reject(new Error(`SAPI synthesis failed (exit ${code}): ${stderr.trim().slice(-400)}`));
    });
    if(signal?.aborted)onAbort();
  });
}

/** Shared offline WAV synthesis; transport and media-store ownership stay with the caller. */
export async function synthesizeSapiWav(text:string,signal:AbortSignal,options:SapiTtsOptions={}):Promise<{bytes:Buffer;durationMs:number}>{
  checkAbort(signal);
  if(!text.trim())throw new Error('Cannot synthesize empty reply');
  const dir=await mkdtemp(join(tmpdir(),'next-sapi-'));
  try{
    const job:SapiSynthesisJob={textPath:join(dir,'text.txt'),outPath:join(dir,'speech.wav'),...(options.voiceName?{voiceName:options.voiceName}:{})};
    await writeFile(job.textPath,text,'utf8');checkAbort(signal);
    if(options.execute)await options.execute(job);else await runSapiJob(job,signal);
    checkAbort(signal);const bytes=await readFile(job.outPath),wav=inspectPcmWav(bytes);
    return {bytes,durationMs:wav.durationMs};
  }finally{await rm(dir,{recursive:true,force:true});}
}

export class SapiTtsProvider implements TtsProvider {
  constructor(private readonly store:MediaStorePort,private readonly options:SapiTtsOptions={}){}
  async synthesize(input:TtsRequest,signal:AbortSignal):Promise<TtsResult>{
    const {bytes,durationMs}=await synthesizeSapiWav(input.text,signal,this.options);checkAbort(signal);
    const audio=await this.store.put(input.scope,bytes,'audio/wav');
    return {scope:input.scope,audio,expression:input.expression,durationMs,synchronization:'none'};
  }
}
