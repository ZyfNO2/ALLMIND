import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import { Readable } from 'node:stream';
import { BookError } from '../contracts/memory-book.js';
import { RESOURCE_LIMITS, type ResourceFailureCode } from '../contracts/book-resources.js';

/**
 * W01 public-URL capture (SPEC §7 / contract §6).
 *
 * A URL is captured only when the *user* submits it. Nothing here crawls links, reuses ChatGPT
 * cookies or touches private address space: every hop is re-validated, and each failure keeps a
 * concrete reason instead of silently producing an empty document.
 */

const MAX_REDIRECTS = 5;
const USER_AGENT = 'AikaW01/1.0 (+local resource capture)';

export interface CapturedDocument {
  url: string;
  finalUrl: string;
  mime: string;
  bytes: Uint8Array;
  complete: boolean;
  omittedReason?: string;
}

function refuse(code: ResourceFailureCode, message: string): BookError {
  return new BookError(code === 'too_large' ? 'invalid_input' : 'unavailable', message, {
    cause: Object.assign(new Error(message), { code })
  });
}

function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (/^fe[89ab]/u.test(lower) || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('ff')) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(lower);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    const hexMapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/u.exec(lower);
    if (hexMapped) {
      const high = parseInt(hexMapped[1]!, 16), low = parseInt(hexMapped[2]!, 16);
      return isPrivateAddress(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`);
    }
    return false;
  }
  return true;
}

/** The target must be a public http(s) endpoint; loopback, private and link-local all fail closed. */
export async function assertPublicTarget(raw: string, resolveHost?: (hostname: string) => Promise<string[]>): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw refuse('invalid_content', '网址格式无效，未抓取。');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw refuse('invalid_content', '只支持 http 或 https 公开网址。');
  if (url.username || url.password) throw refuse('invalid_content', '网址不允许携带凭据。');
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw refuse('invalid_content', '不允许抓取本机或内网地址。');
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw refuse('invalid_content', '不允许抓取本机或内网地址。');
    return url;
  }
  let addresses: string[];
  try {
    addresses = resolveHost ? await resolveHost(host) : (await lookup(host, { all: true })).map(entry => entry.address);
  } catch {
    throw refuse('download_failed', `无法解析网址主机：${host}`);
  }
  if (!addresses.length) throw refuse('download_failed', `无法解析网址主机：${host}`);
  if (addresses.some(address => isPrivateAddress(address))) throw refuse('invalid_content', '不允许抓取本机或内网地址。');
  return url;
}

export interface CaptureOptions {
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  resolveHost?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
}

/** Validate the addresses at connection time too; fetch's second DNS lookup must not rebind privately. */
export function fetchPublicDocument(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input);
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? requestHttps : requestHttp)(url, {
      method: 'GET', headers,
      ...(init.signal ? { signal: init.signal } : {}),
      lookup(hostname, options, callback) {
        void lookup(hostname, { all: true }).then(addresses => {
          if (!addresses.length || addresses.some(row => isPrivateAddress(row.address))) {
            callback(new Error('连接目标解析为内网地址，已拒绝。'), [], undefined as never);
            return;
          }
          if (options.all) callback(null, addresses, undefined as never);
          else callback(null, addresses[0]!.address, addresses[0]!.family);
        }, error => callback(error, [], undefined as never));
      }
    }, incoming => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status: incoming.statusCode ?? 502, headers }));
    });
    request.on('error', reject);
    request.end();
  });
}

/**
 * Fetches one public page, following redirects manually so that each hop is re-validated and the
 * byte budget cannot be bypassed by a redirect chain.
 */
export async function capturePublicDocument(rawUrl: string, signal: AbortSignal, options: CaptureOptions = {}): Promise<CapturedDocument> {
  const timeoutMs = options.timeoutMs ?? RESOURCE_LIMITS.fetchTimeoutMs;
  const doFetch = options.fetch ?? fetchPublicDocument;
  let current = await assertPublicTarget(rawUrl, options.resolveHost);
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([signal, deadline]);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response: Response;
    try {
      response = await doFetch(current, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        headers: { accept: 'text/markdown, text/html, text/plain;q=0.9, */*;q=0.1', 'user-agent': USER_AGENT },
        signal: combined
      });
    } catch (cause) {
      if (signal.aborted) throw refuse('cancelled', '取文已取消。');
      const reason = cause instanceof Error ? cause.message : String(cause);
      if (/timeout|aborted/iu.test(reason)) throw refuse('download_failed', `取文超时（${Math.round(timeoutMs / 1000)} 秒）：${current.host}`);
      throw refuse('download_failed', `取文失败：${reason}`);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw refuse('download_failed', `重定向缺少目标（HTTP ${response.status}）。`);
      if (hop === MAX_REDIRECTS) throw refuse('download_failed', '重定向次数超过上限，未抓取。');
      current = await assertPublicTarget(new URL(location, current).toString(), options.resolveHost);
      continue;
    }
    if (!response.ok) throw refuse('download_failed', `取文失败：HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > RESOURCE_LIMITS.textBytes) {
      throw refuse('too_large', '网页内容超过 2 MiB 上限，已拒绝。');
    }
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (contentType && !/^text\/|^application\/(?:xhtml\+xml|xml|json)$/u.test(contentType)) {
      throw refuse('unsupported', `不支持的网页内容类型：${contentType}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw refuse('download_failed', '网页响应没有正文。');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > RESOURCE_LIMITS.textBytes) { await reader.cancel(); throw refuse('too_large', '网页内容超过 2 MiB 上限，已拒绝。'); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const buffer = new Uint8Array(Buffer.concat(chunks));
    const complete = !declared || declared <= buffer.byteLength;
    return {
      url: rawUrl,
      finalUrl: current.toString(),
      mime: contentType === 'application/xhtml+xml' ? 'text/html' : contentType === 'text/html' ? 'text/html' : contentType === 'text/markdown' ? 'text/markdown' : 'text/plain',
      bytes: buffer,
      complete,
      ...(complete ? {} : { omittedReason: '响应未按声明长度完整接收。' })
    };
  }
  throw refuse('download_failed', '重定向次数超过上限，未抓取。');
}
