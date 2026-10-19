import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BookError, type ChatgptWebSourceConfig } from '../contracts/memory-book.js';

/**
 * ChatGPT web bridge (RPD_CHAT_WIKI §2.3 route 2): wraps the two allowlisted CLI tools
 * (`chatgpt-use` ≥0.0.11, `chrome-use` ≥1.5.190) that the user installs. Failure semantics
 * are inherited from chatgpt-use ecb204d: one JSON envelope per ask, `submitted`
 * no/yes/unknown, receipts via `--request-id`, cancel confirmed only by the server record.
 * AIKI never owns or kills the user's browser; it only runs these tools against it.
 */

export type ChatgptWebProgram = 'chatgpt-use' | 'chrome-use';

export interface ChatgptToolRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ChatgptToolOptions { timeoutMs: number; binDir: string | null; stdin?: string }

/** Program not installed / not resolvable from PATH or binDir. */
export class ChatgptToolMissingError extends Error {
  constructor(public readonly program: ChatgptWebProgram) { super(`未找到 ${program} 可执行文件（未安装或不在 PATH/binDir 上）。`); }
}

export type ChatgptToolRunner = (program: ChatgptWebProgram, args: readonly string[], options: ChatgptToolOptions) => Promise<ChatgptToolRun>;

const STDOUT_CAP_BYTES = 4 * 1024 * 1024;
const STDERR_CAP_BYTES = 256 * 1024;
const IS_WINDOWS = process.platform === 'win32';

/** Real runner: node:child_process, no shell, windowsHide, capped drains, timeout kill. */
export const createNodeToolRunner = (): ChatgptToolRunner => {
  const runOnce = async (program: ChatgptWebProgram, args: readonly string[], options: ChatgptToolOptions, candidate: string): Promise<ChatgptToolRun> => {
    const child = spawn(candidate, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    if (child.stdin) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(options.stdin !== undefined ? options.stdin : undefined, 'utf8');
    }
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    let stdoutBytes = 0; let stderrBytes = 0;
    child.stdout?.on('data', (chunk: Buffer) => { if (stdoutBytes < STDOUT_CAP_BYTES) { stdout.push(chunk); stdoutBytes += chunk.length; } });
    child.stderr?.on('data', (chunk: Buffer) => { if (stderrBytes < STDERR_CAP_BYTES) { stderr.push(chunk); stderrBytes += chunk.length; } });
    return await new Promise<ChatgptToolRun>((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, Math.max(1, options.timeoutMs));
      child.on('error', error => {
        clearTimeout(timer);
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') reject(new ChatgptToolMissingError(program));
        else reject(error);
      });
      child.on('close', exitCode => {
        clearTimeout(timer);
        resolve({ exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), timedOut });
      });
    });
  };
  return async (program, args, options) => {
    // binDir takes precedence when given, PATH remains the fallback: the two tools install to
    // different default directories (chrome-use → Programs\chrome-use, chatgpt-use → chrome-tools),
    // so an explicit binDir must not hide the other tool when it is only on PATH.
    const binDirCandidates = options.binDir
      ? (IS_WINDOWS ? [join(options.binDir, `${program}.exe`), join(options.binDir, program)] : [join(options.binDir, program)])
      : [];
    const pathCandidates = IS_WINDOWS ? [program, `${program}.exe`] : [program];
    let lastMissing: ChatgptToolMissingError | null = null;
    for (const candidate of [...binDirCandidates, ...pathCandidates]) {
      try { return await runOnce(program, args, options, candidate); }
      catch (error) {
        if (error instanceof ChatgptToolMissingError) { lastMissing = error; continue; }
        throw error;
      }
    }
    throw lastMissing ?? new ChatgptToolMissingError(program);
  };
};

export type ChatgptWebSubmitted = 'no' | 'yes' | 'unknown';

export type ChatgptWebFailureCode =
  | 'tool_missing' | 'login_required' | 'rate_limited' | 'busy' | 'session_unavailable' | 'page_blocked'
  | 'not_submitted' | 'submit_unknown' | 'incomplete' | 'duplicate' | 'timeout' | 'bad_output' | 'failed';

export type ChatgptWebAskResult =
  | { kind: 'completed'; text: string; conversationId: string | null; durationMs: number;
      /** W01: verified terminal identity of THIS submission (was previously dropped at this boundary). */
      messageId?: string | null; modelSlug?: string | null;
      /** W01: receipts proving each image was attached to the composer BEFORE submit. */
      uploads?: { resourceId: string; sha256: string; mime: string; bytes: number; name: string }[] }
  | { kind: 'failed'; code: ChatgptWebFailureCode; message: string; submitted: ChatgptWebSubmitted; durationMs: number }
  | { kind: 'cancelled'; confirmed: boolean; message: string; durationMs: number };

export type ChatgptWebBridgeState = 'tool-missing' | 'cooldown' | 'not-connected' | 'signed-out' | 'signed-in' | 'unknown';

export interface ChatgptWebProbe {
  activeRequest?: { requestId: string; submitted: ChatgptWebSubmitted };
  state: ChatgptWebBridgeState;
  detail?: string;
  cooldownLeftMs?: number;
  /** The page is currently showing a "too many requests" notice (observed, not authoritative). */
  rateLimited?: boolean;
  checkedAt: string;
}

export interface ChatgptWebAskOptions {
  requiredThinking?: 'high'; taskArchive?: {bytes:Uint8Array;sha256:string};
  onPrepared?: (receipt:{thinking?:{level:number;label:string};taskArchiveSha256?:string;requestId:string})=>void;
  recoverableCompletion?:boolean;
  captureArtifacts?:boolean;
  project?: import('../contracts/chatgpt-project.js').ChatgptProjectTarget;
  /** System context only when continuing a verified project thread. */
  continuationContext?: string;
  /** Require temporary mode at the actual submission boundary (background bridge). */
  temporary?: boolean;
  /** argv positional prompt (the final user message). */
  prompt: string;
  /** Everything before the final message (system/history) — sent via stdin to stay under the ~32K argv limit. */
  context?: string;
  requestId: string;
  /** Whole-turn wall budget for the chatgpt-use call itself (bridge adds connect overhead). */
  timeoutMs: number;
  /** chatgpt-use effort label from the binding's model profile; 'auto'/'current' leaves the account default. */
  model?: string;
  /**
   * W01: images that must be attached through the source's native file input BEFORE the prompt is
   * submitted. The bridge proves each attachment and refuses to submit if the page does not confirm.
   */
  images?: { resourceId: string; sha256: string; mime: string; bytes: Uint8Array }[];
  signal?: AbortSignal;
}

const CONNECT_OVERHEAD_MS = 90_000;
const CANCEL_COMMAND_TIMEOUT_MS = 120_000;
const CANCEL_SETTLE_WAIT_MS = 10_000;
const PROBE_TIMEOUT_MS = 20_000;
const OPEN_LOGIN_TIMEOUT_MS = 60_000;
const VERSION_TIMEOUT_MS = 15_000;
const STATUS_TIMEOUT_MS = 15_000;
/** `/api/auth/session` eval 的预算。 */
const TOKEN_TIMEOUT_MS = 20_000;
/** token 内存缓存：5 分钟（expires 字段是会话寿命不是 token 的，别信它）。 */
const TOKEN_CACHE_MS = 5 * 60_000;
/** argv stays comfortably under the Windows 32K-character command-line limit; larger prompts move to stdin. */
const ARGV_SAFE_CHARS = 12_000;
const STDIN_FALLBACK_PROMPT = '请阅读附加材料，并完成其中描述的任务。';

/**
 * Login-state probe, eval-only: no message is sent and no page is loaded (RPD §3.1).
 * Adapted from chatgpt-use ecb204d `JS_WANTS_LOGIN` + `JS_COMPOSER`: login needs positive
 * evidence; the composer covers both the ProseMirror and Lexical editors and skips hidden
 * app-shell pages; the rate-limit dialog matcher covers the UI languages observed in the wild.
 */
const PROBE_JS = `(() => {
  const login = /\\/auth\\/|auth\\.openai\\.com/.test(location.href)
    || !!document.querySelector('[data-testid="login-button"],[data-testid="signup-button"]');
  const hidden = (n) => {
    for (let p = n.closest('[data-app-shell-page-surface]'); p;
         p = p.parentElement && p.parentElement.closest('[data-app-shell-page-surface]')) {
      if (getComputedStyle(p).display === 'none') return true;
    }
    return !!n.closest('[hidden], [aria-hidden="true"], [inert]');
  };
  const all = [...document.querySelectorAll(
    '#prompt-textarea, [data-testid="prompt-textarea"], '
    + '[contenteditable="true"][data-lexical-editor="true"], '
    + 'form[data-chatgpt-composer] [contenteditable="true"][role="textbox"], '
    + 'form [data-composer-markdown][contenteditable="true"][role="textbox"]')]
    .filter(n => !hidden(n) && !n.closest('[data-turn-key], [data-message-author-role], .markdown'));
  const live = all.filter(n => !all.some(o => o !== n && n.contains(o)));
  const composer = live.length === 1;
  const dlg = [...document.querySelectorAll('[role="dialog"]')].map(d => d.textContent || '').join(' ');
  const limited = /too many requests|requests too quickly|太多请求|太多要求|过于频繁|過於頻繁|リクエストが多すぎます|リクエストの頻度が高すぎます|요청이 너무 많습니다|너무 많은 요청|요청을 너무 빠르게/i.test(dlg);
  return JSON.stringify({ host: location.hostname, login, composer, limited });
})()`;

function parseEnvelopeLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
      return null;
    } catch { return null; }
  }
  return null;
}

/** chrome-use eval prints the page's `JSON.stringify(value)` JSON-encoded once more. */
function parseEvalOutput(stdout: string): Record<string, unknown> | null {
  const lines = stdout.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      const outer: unknown = JSON.parse(line);
      if (typeof outer === 'string') {
        try {
          const inner: unknown = JSON.parse(outer);
          return inner && typeof inner === 'object' && !Array.isArray(inner) ? inner as Record<string, unknown> : null;
        } catch { return null; }
      }
      return outer && typeof outer === 'object' && !Array.isArray(outer) ? outer as Record<string, unknown> : null;
    } catch { return null; }
  }
  return null;
}

function stringOf(value: unknown): string | null { return typeof value === 'string' ? value : null; }

function submittedOf(env: Record<string, unknown>): ChatgptWebSubmitted {
  const raw = (env.error && typeof env.error === 'object') ? (env.error as Record<string, unknown>).submitted : undefined;
  return raw === 'no' || raw === 'yes' ? raw : 'unknown';
}

function messageOf(env: Record<string, unknown>, fallback: string): string {
  const error = env.error && typeof env.error === 'object' ? env.error as Record<string, unknown> : null;
  const message = error && stringOf(error.message);
  return message && message.trim() ? message : fallback;
}

function conversationIdOf(env: Record<string, unknown>): string | null {
  const id = stringOf(env.conversation_id);
  return id && id ? id : null;
}

/** envelope status/error.kind → bridge failure code; kind first, then status, then exit code. */
function failureCodeOf(env: Record<string, unknown> | null, run: ChatgptToolRun): ChatgptWebFailureCode {
  if (!env) {
    if (run.timedOut) return 'timeout';
    switch (run.exitCode) {
      case 3: case 4: case 8: return 'bad_output';
      case 5: return 'incomplete';
      case 7: return 'busy';
      case 9: return 'duplicate';
      case 10: return 'submit_unknown';
      default: return 'bad_output';
    }
  }
  const status = stringOf(env.status) ?? '';
  const error = env.error && typeof env.error === 'object' ? env.error as Record<string, unknown> : null;
  const kind = error ? stringOf(error.kind) : null;
  switch (kind) {
    case 'login_required': return 'login_required';
    case 'rate_limited': return 'rate_limited';
    case 'session_unavailable': return 'session_unavailable';
    case 'page_blocked': return 'page_blocked';
    case 'not_submitted': return 'not_submitted';
    case 'submit_unknown': return 'submit_unknown';
    case 'busy': return 'busy';
    case 'incomplete': return 'incomplete';
    case 'duplicate': case 'duplicate_request': return 'duplicate';
    case 'unknown_request': return 'not_submitted';
    case 'unparseable': return 'bad_output';
    default: break;
  }
  switch (status) {
    case 'incomplete': return 'incomplete';
    case 'busy': return 'busy';
    case 'duplicate': return 'duplicate';
    case 'submission_unknown': return 'submit_unknown';
    case 'unavailable': return 'failed';
    default: return 'failed';
  }
}

function stderrTail(stderr: string, maxChars = 300): string {
  const trimmed = stderr.trim();
  return trimmed ? trimmed.slice(-maxChars) : '';
}

export interface ChatgptWebBridgeOptions {
  runner?: ChatgptToolRunner;
  /** Live source-config reader (composition passes a repository-backed function). */
  config: () => ChatgptWebSourceConfig;
  /** Injectable for tests. */
  cooldownPath?: () => string;
  now?: () => number;
  /** Bounded wait for the ask process to wind down after cancel (tests shrink it). */
  cancelSettleWaitMs?: number;
}

export class ChatgptWebBridge {
  private readonly runner: ChatgptToolRunner;
  private readonly config: () => ChatgptWebSourceConfig;
  private readonly cooldownPath: () => string;
  private readonly now: () => number;
  private readonly cancelSettleWaitMs: number;
  /** Source-level single active generation (RPD §5): one account, one in-flight ask. */
  private inFlight: string | null = null;
  /** 内存 token 缓存（5 分钟）；不落盘、不进日志。 */
  private tokenCache: { token: string; until: number } | null = null;

  constructor(options: ChatgptWebBridgeOptions) {
    this.runner = options.runner ?? createNodeToolRunner();
    this.config = options.config;
    this.cooldownPath = options.cooldownPath ?? (() => join(homedir(), '.chatgpt-use', 'throttle.json'));
    this.now = options.now ?? Date.now;
    this.cancelSettleWaitMs = options.cancelSettleWaitMs ?? CANCEL_SETTLE_WAIT_MS;
  }

  private tool(program: ChatgptWebProgram, args: readonly string[], timeoutMs: number, stdin?: string): Promise<ChatgptToolRun> {
    const config = this.config();
    return this.runner(program, args, { timeoutMs, binDir: config.binDir, ...(stdin !== undefined ? { stdin } : {}) });
  }

  /** Account cooldown from chatgpt-use's own throttle file (read-only). */
  cooldownLeftMs(): number | null {
    try {
      if (!existsSync(this.cooldownPath())) return null;
      const parsed = JSON.parse(readFileSync(this.cooldownPath(), 'utf8')) as { until?: unknown };
      if (typeof parsed.until !== 'number' || !Number.isFinite(parsed.until)) return null;
      const left = parsed.until * 1000 - this.now();
      return left > 0 ? left : null;
    } catch { return null; }
  }

  private channelArgs(): string[] {
    const config = this.config();
    return ['--profile', config.profile, '--session', config.session];
  }

  /** chrome-use takes `--profile` as a global flag BEFORE the subcommand; auto/relay pass none. */
  private chromeGlobalArgs(): string[] {
    const profile = this.config().profile.trim();
    if (!profile || profile === 'auto' || profile === 'relay') return [];
    return ['--profile', profile];
  }

  private mapEnvelope(run: ChatgptToolRun, startedAt: number): ChatgptWebAskResult {
    const durationMs = Math.max(0, this.now() - startedAt);
    const env = parseEnvelopeLine(run.stdout);
    if (!env) {
      const tail = stderrTail(run.stderr);
      return {
        kind: 'failed',
        code: failureCodeOf(null, run),
        message: run.timedOut
          ? `桥接进程超时被终止${tail ? `：${tail}` : ''}；提交状态未知，不得自动重发，请用回执接续或重开新尝试。`
          : `chatgpt-use 未返回可解析的结果（exit=${run.exitCode ?? 'null'}${tail ? `：${tail}` : ''}）。`,
        submitted: 'unknown',
        durationMs,
      };
    }
    const status = stringOf(env.status) ?? '';
    if (status === 'completed') {
      const result = env.result && typeof env.result === 'object' ? env.result as Record<string, unknown> : null;
      const text = result ? stringOf(result.text) : null;
      if (text === null) {
        return { kind: 'failed', code: 'bad_output', message: 'chatgpt-use 报告完成但缺少回复文本，不冒充成功。', submitted: 'yes', durationMs };
      }
      return { kind: 'completed', text, conversationId: conversationIdOf(env), durationMs };
    }
    if (status === 'cancelled' || status === 'cancel_requested') {
      return { kind: 'cancelled', confirmed: status === 'cancelled', message: messageOf(env, status), durationMs };
    }
    return { kind: 'failed', code: failureCodeOf(env, run), message: messageOf(env, `chatgpt-use 请求以状态 ${status || 'unknown'} 结束。`), submitted: submittedOf(env), durationMs };
  }

  private async runCancel(requestId: string): Promise<{ confirmed: boolean; status: string; message: string }> {
    const startedAt = this.now();
    let outcome: { confirmed: boolean; status: string; message: string };
    try {
      const run = await this.tool('chatgpt-use', ['cancel', requestId, ...this.channelArgs(), '--timeout', '90'], CANCEL_COMMAND_TIMEOUT_MS);
      const env = parseEnvelopeLine(run.stdout);
      if (!env) outcome = { confirmed: false, status: 'unknown', message: `cancel 命令未返回回执（exit=${run.exitCode ?? 'null'}）。` };
      else {
        const status = stringOf(env.status) ?? '';
        const kind = env.error && typeof env.error === 'object' ? stringOf((env.error as Record<string, unknown>).kind) : null;
        // No receipt ⇒ nothing was ever registered/submitted; already_finished ⇒ the reply beat the stop.
        const confirmed = status === 'cancelled' || status === 'already_finished'
          || (status === 'failed' && (kind === 'unknown_request' || kind === 'error'));
        outcome = { confirmed, status: status || 'unknown', message: messageOf(env, status || 'unknown') };
      }
    } catch (error) {
      outcome = { confirmed: false, status: error instanceof ChatgptToolMissingError ? 'tool_missing' : 'unknown', message: error instanceof Error ? error.message : String(error) };
    }
    void startedAt;
    return outcome;
  }

  /**
   * One ask through the logged-in web conversation. Aborts by running `chatgpt-use cancel`
   * first and settling on its receipt; the late ask envelope is discarded either way.
   */
  async ask(options: ChatgptWebAskOptions): Promise<ChatgptWebAskResult> {
    if (options.requiredThinking || options.taskArchive) return { kind: 'failed', code: 'failed', submitted: 'no', message: '本任务要求可核验High与资料附件，请使用独立页面来源；CLI未提交。', durationMs: 0 };
    const startedAt = this.now();
    const duration = () => Math.max(0, this.now() - startedAt);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.requestId)) {
      throw new BookError('invalid_input', `非法 requestId：${options.requestId}`);
    }
    if (this.inFlight) {
      return { kind: 'failed', code: 'busy', message: `ChatGPT 网页来源正被请求 ${this.inFlight} 占用（单活动生成）。`, submitted: 'no', durationMs: duration() };
    }
    const cooldownLeft = this.cooldownLeftMs();
    if (cooldownLeft !== null) {
      return { kind: 'failed', code: 'rate_limited', message: `chatgpt.com 对本账号限流，冷却剩 ${Math.ceil(cooldownLeft / 60000)} 分钟；期间不自动重试。`, submitted: 'no', durationMs: duration() };
    }
    // Claim the lease synchronously before any await (RPD §5 single active generation).
    this.inFlight = options.requestId;
    let onAbort: (() => void) | null = null;
    const abortPromise = options.signal
      ? new Promise<'aborted'>(resolve => {
        onAbort = () => resolve('aborted');
        if (options.signal?.aborted) resolve('aborted');
        else options.signal?.addEventListener('abort', onAbort as () => void, { once: true });
      })
      : null;
    try {
      const config = this.config();
      let argvPrompt = options.prompt;
      let stdinContent = options.context;
      if (argvPrompt.length > ARGV_SAFE_CHARS) {
        stdinContent = stdinContent ? `${stdinContent}\n\n---\n${argvPrompt}` : argvPrompt;
        argvPrompt = STDIN_FALLBACK_PROMPT;
      }
      const model = options.model?.trim() ?? '';
      const args = [
        'ask', argvPrompt, '--json',
        stdinContent !== undefined ? '--stdin' : '--no-stdin',
        '--request-id', options.requestId,
        ...this.channelArgs(),
        '--project', '',
        '--timeout', String(Math.max(5, Math.ceil(options.timeoutMs / 1000))),
        '--busy', 'wait',
        ...(model && model !== 'auto' && model !== 'current' && model !== 'default' ? ['--model', model] : []),
      ];
      const runPromise = this.tool('chatgpt-use', args, options.timeoutMs + CONNECT_OVERHEAD_MS, stdinContent);
      const race = abortPromise
        ? Promise.race([runPromise.then(run => ({ kind: 'run' as const, run })), abortPromise.then(() => ({ kind: 'aborted' as const, run: null }))])
        : runPromise.then(run => ({ kind: 'run' as const, run }));
      const winner = await race;
      if (winner.kind === 'run') return this.mapEnvelope(winner.run, startedAt);
      const cancel = await this.runCancel(options.requestId);
      await Promise.race([
        runPromise.then(() => undefined, () => undefined),
        new Promise<void>(resolve => { setTimeout(resolve, this.cancelSettleWaitMs); }),
      ]);
      return {
        kind: 'cancelled',
        confirmed: cancel.confirmed,
        message: cancel.confirmed
          ? '已取消：云端回执确认生成已停止（或从未提交）。'
          : `停止未确认：${cancel.message}；云端可能仍在生成，请稍后重试或改用其他来源。`,
        durationMs: duration(),
      };
    } catch (error) {
      const code: ChatgptWebFailureCode = error instanceof ChatgptToolMissingError ? 'tool_missing' : 'failed';
      return { kind: 'failed', code, message: error instanceof Error ? error.message : String(error), submitted: 'no', durationMs: duration() };
    } finally {
      this.inFlight = null;
      if (onAbort && options.signal) options.signal.removeEventListener('abort', onAbort);
    }
  }

  /** Receipt-only status; never touches the browser. */
  async requestStatus(requestId: string): Promise<{ state: string; submitted: ChatgptWebSubmitted; outcome: string | null } | null> {
    const run = await this.tool('chatgpt-use', ['status', requestId], STATUS_TIMEOUT_MS);
    const env = parseEnvelopeLine(run.stdout);
    const state = env ? stringOf(env.state) : null;
    if (!state) return null;
    const submittedRaw = env ? stringOf(env.submitted) : null;
    const outcome = env ? stringOf(env.outcome) : null;
    return {
      state,
      submitted: submittedRaw === 'no' || submittedRaw === 'yes' ? submittedRaw : 'unknown',
      outcome: outcome ?? null,
    };
  }

  /** Pick up a lost request's reply from the server record without re-sending anything. */
  async resume(requestId: string, timeoutMs: number): Promise<ChatgptWebAskResult> {
    const startedAt = this.now();
    try {
      const run = await this.tool('chatgpt-use', ['resume', requestId, ...this.channelArgs(), '--timeout', String(Math.max(5, Math.ceil(timeoutMs / 1000)))], timeoutMs + CONNECT_OVERHEAD_MS);
      return this.mapEnvelope(run, startedAt);
    } catch (error) {
      const code: ChatgptWebFailureCode = error instanceof ChatgptToolMissingError ? 'tool_missing' : 'failed';
      return { kind: 'failed', code, message: error instanceof Error ? error.message : String(error), submitted: 'unknown', durationMs: Math.max(0, this.now() - startedAt) };
    }
  }

  /** eval-only login probe: no message, no page load. Success never guarantees the next ask. */
  async probe(): Promise<ChatgptWebProbe> {
    const checkedAt = new Date().toISOString();
    const cooldownLeft = this.cooldownLeftMs();
    if (cooldownLeft !== null) {
      return { state: 'cooldown', cooldownLeftMs: cooldownLeft, detail: `账号限流冷却中，剩 ${Math.ceil(cooldownLeft / 60000)} 分钟。`, checkedAt };
    }
    try {
      await this.tool('chatgpt-use', ['--version'], VERSION_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof ChatgptToolMissingError) return { state: 'tool-missing', detail: 'chatgpt-use 未安装或不在 PATH/binDir 上。', checkedAt };
      return { state: 'unknown', detail: `chatgpt-use --version 失败：${error instanceof Error ? error.message : String(error)}`, checkedAt };
    }
    try {
      const run = await this.tool('chrome-use', [...this.chromeGlobalArgs(), 'eval', PROBE_JS, '--session', this.config().session], PROBE_TIMEOUT_MS);
      if (run.exitCode !== 0) {
        return { state: 'not-connected', detail: `chrome-use 会话不可用（exit=${run.exitCode ?? 'null'}${stderrTail(run.stderr) ? `：${stderrTail(run.stderr)}` : ''}）。`, checkedAt };
      }
      const value = parseEvalOutput(run.stdout);
      if (!value) return { state: 'not-connected', detail: 'chrome-use eval 输出无法解析（会话可能没有标签页）。', checkedAt };
      const host = stringOf(value.host) ?? '';
      if (!/(^|\.)chatgpt\.com$/.test(host)) {
        return { state: 'unknown', detail: `会话标签页不在 chatgpt.com（host=${host || '未知'}），探测无法确认登录状态。`, checkedAt };
      }
      if (value.login === true) return { state: 'signed-out', detail: '页面显示登录入口，需要登录。', checkedAt };
      if (value.composer === true) {
        const limited = value.limited === true;
        return { state: 'signed-in', ...(limited ? { rateLimited: true, detail: '已登录，但页面正在显示限流提示。' } : {}), checkedAt };
      }
      return { state: 'unknown', detail: '页面可读但既无登录按钮也无输入框，状态不可判读。', checkedAt };
    } catch (error) {
      if (error instanceof ChatgptToolMissingError) return { state: 'tool-missing', detail: 'chrome-use 未安装或不在 PATH/binDir 上。', checkedAt };
      return { state: 'not-connected', detail: error instanceof Error ? error.message : String(error), checkedAt };
    }
  }

  /**
   * Open the chatgpt.com login page once; the user completes login in their own browser.
   * `standalone: true` asks chrome-use for a fresh isolated window (`--launch`) instead of
   * relaying into the user's running Chrome — useful for a first-time dedicated login.
   */
  async openLoginPage(options: { standalone?: boolean } = {}): Promise<void> {
    const args = [...this.chromeGlobalArgs()];
    if (options.standalone) args.push('--launch');
    args.push('open', 'https://chatgpt.com/', '--session', this.config().session);
    const run = await this.tool('chrome-use', args, OPEN_LOGIN_TIMEOUT_MS);
    if (run.exitCode !== 0) {
      throw new Error(`chrome-use open 失败（exit=${run.exitCode ?? 'null'}${stderrTail(run.stderr) ? `：${stderrTail(run.stderr)}` : ''}）。`);
    }
  }

  /**
   * Open a temporary-chat page (`?temporary-chat=true`) in the session tab — test/debug
   * requests land there instead of the account's chat history. One page load on an
   * explicit action (mirrors openLoginPage's cost).
   */
  async openTemporaryChat(): Promise<void> {
    const args = [...this.chromeGlobalArgs(), 'open', 'https://chatgpt.com/?temporary-chat=true', '--session', this.config().session];
    const run = await this.tool('chrome-use', args, OPEN_LOGIN_TIMEOUT_MS);
    if (run.exitCode !== 0) {
      throw new Error(`chrome-use open 临时聊天失败（exit=${run.exitCode ?? 'null'}${stderrTail(run.stderr) ? `：${stderrTail(run.stderr)}` : ''}）。`);
    }
  }

  /**
   * The session's bearer token, read from the logged-in page (`/api/auth/session`) —
   * the same credential the web chat itself uses. Eval-only: no message, no submit.
   * Cached for five minutes (chatgpt-use JS_TOKEN_PRELUDE's cap: the payload's `expires`
   * is the SESSION lifetime, not the token's); invalidate() forces a refresh after a 401.
   */
  async getSessionToken(): Promise<string | null> {
    const cached = this.tokenCache;
    if (cached && cached.until > this.now()) return cached.token;
    const js = `(() => fetch('/api/auth/session', {credentials: 'include'}).then(r => r.json()).then(s => JSON.stringify({token: (s && s.accessToken) || null})).catch(() => JSON.stringify({token: null})))()`;
    const run = await this.tool('chrome-use', ['eval', js, '--session', this.config().session], TOKEN_TIMEOUT_MS);
    if (run.exitCode !== 0) return null;
    const value = parseEvalOutput(run.stdout);
    const token = value ? stringOf(value.token) : null;
    if (token) {
      this.tokenCache = { token, until: this.now() + TOKEN_CACHE_MS };
      return token;
    }
    return null;
  }

  /** Drop the cached token (a 401 from a conversation call proves it stale). */
  invalidateToken(): void {
    this.tokenCache = null;
  }
}
