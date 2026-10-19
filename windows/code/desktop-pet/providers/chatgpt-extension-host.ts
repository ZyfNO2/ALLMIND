import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { chatgptPageScript, type ChatgptPageHost } from './chatgpt-background-bridge.js';

/** Extension transport inspired by DrA1ex/chatgpt-bridge (MIT, 0ffdae9).
 * A local authenticated long poll replaces CLI/CDP. No browser launch or GPT token export.
 * Delivered commands are never replayed after a disconnect, including submit.
 */
export class ChatgptExtensionHost implements ChatgptPageHost {
  private server: Server | null = null;
  private starting: Promise<void> | null = null;
  private client: { id: string; seen: number } | null = null;
  private waiter: { response: ServerResponse; timer: NodeJS.Timeout } | null = null;
  private command: Record<string, unknown> | null = null;
  private pending: { id: string; resolve: (value: Record<string, any>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null;
  private token: string;
  private port = 0;
  private closed = false;
  constructor(private options: { keyPath?: string; port?: number; timeoutMs?: number; reconnectMs?: number } = {}) {
    this.token = options.keyPath && existsSync(options.keyPath) ? readFileSync(options.keyPath, 'utf8').trim() : randomBytes(32).toString('hex');
    if (!/^[a-f0-9]{64}$/.test(this.token)) throw new Error('本地 bridge 配对记录损坏。');
    if (options.keyPath && !existsSync(options.keyPath)) writeFileSync(options.keyPath, this.token + '\n', { mode: 0o600, flag: 'wx' });
    if (options.keyPath && existsSync(options.keyPath + '.client')) {
      const id = readFileSync(options.keyPath + '.client', 'utf8').trim();
      if (id && !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('本地 bridge 浏览器绑定损坏。');
      if (id) this.client = { id, seen: 0 };
    }
  }
  private async start() {
    if (this.closed) throw new Error('本地 bridge 已停止。');
    if (!this.starting) this.starting = new Promise<void>((resolve, reject) => {
      const server = createServer((request, response) => { void this.route(request, response).catch(() => { if (!response.headersSent) response.writeHead(400); response.end(); }); });
      this.server = server;
      server.once('error', reject);
      server.listen(this.options.port ?? 17643, '127.0.0.1', () => { this.port = (server.address() as AddressInfo).port; resolve(); });
    });
    await this.starting;
  }
  async pairing() { await this.start(); return { url: `http://127.0.0.1:${this.port}`, code: this.token, connected: Boolean(this.client && Date.now() - this.client.seen < 15000) }; }
  async resetPairing() {
    if (this.pending) throw new Error('bridge 动作未结束，不能更换浏览器。');
    this.token = randomBytes(32).toString('hex'); this.client = null;
    if (this.options.keyPath) {
      writeFileSync(this.options.keyPath, this.token + '\n', { mode: 0o600 });
      // Empty binding is persisted without removing or touching a browser profile.
      writeFileSync(this.options.keyPath + '.client', '', { mode: 0o600 });
    }
    if (this.waiter) { clearTimeout(this.waiter.timer); this.finish(this.waiter.response, 401, { error: 'repaired' }); this.waiter = null; }
    return this.pairing();
  }
  private finish(response: ServerResponse, status: number, value: unknown) { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); }
  private async route(request: IncomingMessage, response: ServerResponse) {
    const origin = request.headers.origin;
    if (!origin || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin) || request.headers.host !== `127.0.0.1:${this.port}`) return this.finish(response, 403, { error: 'origin' });
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('vary', 'Origin');
    if (request.method === 'OPTIONS') {
      response.setHeader('access-control-allow-headers', 'Authorization, Content-Type');
      response.setHeader('access-control-allow-methods', 'POST');
      response.writeHead(204); response.end(); return;
    }
    const supplied = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (supplied.length !== this.token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(this.token))) return this.finish(response, 401, { error: 'pairing' });
    if (request.method !== 'POST' || !['/pull', '/result'].includes(request.url ?? '')) return this.finish(response, 404, { error: 'route' });
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of request) { length += chunk.length; if (length > 4 * 1024 * 1024) return this.finish(response, 413, { error: 'size' }); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body.client !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(body.client)) return this.finish(response, 400, { error: 'client' });
    if (this.client && this.client.id !== body.client) return this.finish(response, 409, { error: 'another_extension' });
    if (!this.client && this.options.keyPath) writeFileSync(this.options.keyPath + '.client', body.client + '\n', { mode: 0o600 });
    this.client = { id: body.client, seen: Date.now() };
    if (request.url === '/result') {
      if (!this.pending || body.id !== this.pending.id) return this.finish(response, 409, { error: 'stale_command' });
      const pending = this.pending; this.pending = null; this.command = null; clearTimeout(pending.timer);
      if (typeof body.error === 'string') pending.reject(new Error(body.error.slice(0, 1500)));
      else if (body.value && typeof body.value === 'object' && !Array.isArray(body.value)) pending.resolve(body.value);
      else pending.reject(new Error('扩展返回了无效动作结果。'));
      this.finish(response, 200, { ok: true }); return;
    }
    if (this.waiter) return this.finish(response, 409, { error: 'poll_in_progress' });
    if (this.command) { const command = this.command; this.command = null; this.finish(response, 200, command); return; }
    const timer = setTimeout(() => { if (this.waiter?.response === response) this.waiter = null; this.finish(response, 200, { idle: true }); }, 8000);
    this.waiter = { response, timer };
    response.once('close', () => { if (this.waiter?.response === response) { clearTimeout(timer); this.waiter = null; } });
  }
  private async dispatch(action: string, input: Record<string, unknown> = {}) {
    await this.start();
    // An existing binding survives a backend restart. Wait for the extension's
    // reconnect alarm; an unpaired instance still fails immediately.
    const reconnectUntil = Date.now() + (this.options.reconnectMs ?? 35000);
    while (this.client && Date.now() - this.client.seen >= 15000 && Date.now() < reconnectUntil && !this.closed) await new Promise(resolve => setTimeout(resolve, 100));
    if (!this.client || Date.now() - this.client.seen >= 15000) throw new Error('Chat bridge 尚未配对或扩展已断开；请在模型设置完成扩展配对。不会启动 CLI 或新浏览器。');
    if (this.pending) throw new Error('Chat bridge 动作仍在等待确认。');
    const id = randomUUID();
    return new Promise<Record<string, any>>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending = null; this.command = null; reject(new Error('Chat bridge 动作超时；不自动重放，提交结果需接续核对。')); }, this.options.timeoutMs ?? 60000);
      this.pending = { id, resolve, reject, timer };
      const command = { id, action, input };
      if (this.waiter) { const waiter = this.waiter; this.waiter = null; clearTimeout(waiter.timer); this.finish(waiter.response, 200, command); }
      else this.command = command;
    });
  }
  async execute(action: string, input: { id?: string; text?: string; temporary?: boolean; model?: string }) { chatgptPageScript(action, input); return this.dispatch(action, input); }
  async navigate(temporary: boolean) { await this.dispatch('navigate', { temporary }); }
  async login() { await this.dispatch('login'); }
  async close() {
    this.closed = true;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error('Chat bridge 已停止；不自动重放。')); this.pending = null; }
    if (this.waiter) { clearTimeout(this.waiter.timer); this.finish(this.waiter.response, 503, { error: 'closed' }); this.waiter = null; }
    this.command = null;
    if (this.server) { const server = this.server; await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
  }
}
