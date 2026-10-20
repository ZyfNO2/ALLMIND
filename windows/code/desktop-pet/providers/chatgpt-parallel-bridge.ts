import { ChatgptBackgroundBridge, type ChatgptPageHost } from './chatgpt-background-bridge.js';
import type { ChatgptWebAskOptions, ChatgptWebAskResult } from './chatgpt-web-bridge.js';
import { BookError } from '../contracts/memory-book.js';

type Options = ConstructorParameters<typeof ChatgptBackgroundBridge>[0];

/** Each embedded lane owns its page and durable receipt; uncertain sends keep their lane. */
export class ChatgptParallelBridge extends ChatgptBackgroundBridge {
  private readonly lanes: ChatgptBackgroundBridge[];
  private readonly leases = new Map<ChatgptBackgroundBridge, string>();
  private readonly sourceConfig: Options['config'];
  constructor(options: Options & { pageHostForLane: (lane: number) => ChatgptPageHost }) {
    const { pageHostForLane, ...base } = options;
    super({ ...base, pageHost: pageHostForLane(0) });
    this.sourceConfig = base.config;
    this.lanes = [1, 2, 3].map(lane => new ChatgptBackgroundBridge({ ...base, prewarm: false, pageHost: pageHostForLane(lane), ...(base.receiptPath ? {receiptPath:base.receiptPath + '.lane-' + lane} : {}) }));
  }
  private all() { return [this as ChatgptBackgroundBridge, ...(this.lanes ?? [])]; }
  private status(lane: ChatgptBackgroundBridge, id: string): ReturnType<ChatgptBackgroundBridge['requestStatus']> { return lane === this ? super.requestStatus(id) : lane.requestStatus(id); }
  private owner(id: string): ChatgptBackgroundBridge | undefined { return this.all().find(lane => this.status(lane, id)); }
  private current(lane: ChatgptBackgroundBridge): ReturnType<ChatgptBackgroundBridge['currentRequest']> { return lane === this ? super.currentRequest() : lane.currentRequest(); }
  override currentRequest(): ReturnType<ChatgptBackgroundBridge['currentRequest']> { return this.all().map(lane => this.current(lane)).find(Boolean) ?? null; }
  override requestStatus(id: string): ReturnType<ChatgptBackgroundBridge['requestStatus']> { const lane = this.owner(id); return lane ? this.status(lane, id) : null; }
  override async ask(input: ChatgptWebAskOptions): Promise<ChatgptWebAskResult> {
    if (this.sourceConfig().transport !== 'embedded') return super.ask(input);
    const known = this.owner(input.requestId);
    const lane = known ?? this.all().find(row => !this.current(row) && !this.leases.has(row));
    if (!lane || this.leases.has(lane)) return { kind: 'failed', code: 'busy', submitted: 'no', message: '4 个独立网页通道均在生成、接收文件或等待核对；本次未发送。', durationMs: 0 };
    this.leases.set(lane, input.requestId);
    let retain = false;
    try {
      const result = await (lane === this ? super.ask(input) : lane.ask(input));
      retain = result.kind === 'completed' && input.captureArtifacts === true;
      return result;
    } finally { if (!retain) this.leases.delete(lane); }
  }
  releaseRequest(id: string) { for (const [lane, requestId] of this.leases) if (requestId === id) this.leases.delete(lane); }
  override resume(id: string, timeoutMs: number): ReturnType<ChatgptBackgroundBridge['resume']> { const lane = this.owner(id); return lane && lane !== this ? lane.resume(id, timeoutMs) : super.resume(id, timeoutMs); }
  override cancel(id: string): ReturnType<ChatgptBackgroundBridge['cancel']> { const lane = this.owner(id); return lane && lane !== this ? lane.cancel(id) : super.cancel(id); }
  override listArtifacts(id: string, options?: Parameters<ChatgptBackgroundBridge['listArtifacts']>[1]): ReturnType<ChatgptBackgroundBridge['listArtifacts']> { const lane = this.owner(id); return lane && lane !== this ? lane.listArtifacts(id, options) : super.listArtifacts(id, options); }
  override readArtifact(input: Parameters<ChatgptBackgroundBridge['readArtifact']>[0], signal: AbortSignal): Promise<Uint8Array> {
    const lane = input.requestId ? this.owner(input.requestId) : undefined;
    if (!lane && this.lanes.some(row => row.currentRequest())) throw new BookError('invalid_input', '并行网页文件读取必须提供可核验的请求身份。');
    return lane && lane !== this ? lane.readArtifact(input, signal) : super.readArtifact(input, signal);
  }
  override forgetCompleted(ids: string[]) { super.forgetCompleted(ids); for (const lane of this.lanes ?? []) lane.forgetCompleted(ids); }
}
