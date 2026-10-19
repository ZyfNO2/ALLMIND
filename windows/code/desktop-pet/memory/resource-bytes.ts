import { BookError } from '../contracts/memory-book.js';
import {
  IMAGE_MIMES,
  RESOURCE_LIMITS,
  type ResourceFailureCode,
  type ResourceKind,
  kindOfMime
} from '../contracts/book-resources.js';

/**
 * W01 byte layer: everything here works on bytes we actually hold. A name hint or a model's
 * claim never decides a mime — only content does (SPEC §7 "媒体 MIME/扩展名与实际内容校验").
 */

export interface DetectedMedia { mime: string; kind: ResourceKind }

function invalid(message: string, code: ResourceFailureCode = 'invalid_content'): BookError {
  return new BookError('invalid_input', message, { cause: Object.assign(new Error(message), { code }) });
}

function asBuffer(bytes: Uint8Array | Buffer): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function startsWith(buffer: Buffer, signature: number[]): boolean {
  if (buffer.length < signature.length) return false;
  return signature.every((value, index) => buffer[index] === value);
}

/** PNG IHDR / JPEG SOF / WebP VP8(X|L) header parsing; no third-party image dependency. */
export function imageSize(mime: string, bytes: Uint8Array | Buffer): { width: number; height: number } | null {
  const buffer = asBuffer(bytes);
  if (mime === 'image/png') {
    if (buffer.length < 24 || !startsWith(buffer, [0x89, 0x50, 0x4e, 0x47])) return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mime === 'image/jpeg') {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer.readUInt8(offset) !== 0xff) { offset += 1; continue; }
      const marker = buffer.readUInt8(offset + 1);
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) return null;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        if (offset + 9 > buffer.length) return null;
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
    return null;
  }
  if (mime === 'image/webp') {
    if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      const width = 1 + (buffer.readUInt8(24) | (buffer.readUInt8(25) << 8) | (buffer.readUInt8(26) << 16));
      const height = 1 + (buffer.readUInt8(27) | (buffer.readUInt8(28) << 8) | (buffer.readUInt8(29) << 16));
      return { width, height };
    }
    if (chunk === 'VP8 ') {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }    if (chunk === 'VP8L') {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  return null;
}

/** Only raster formats are accepted; SVG and everything else stays unsupported in W01. */
export function detectMedia(bytes: Uint8Array | Buffer, hint?: { mime?: string | null; name?: string | null }): DetectedMedia {
  const buffer = asBuffer(bytes);
  if (!buffer.length) throw invalid('资源内容为空。');
  const declaredImage = (hint?.mime ?? '').split(';')[0]!.toLowerCase();
  if (IMAGE_MIMES.includes(declaredImage)) {
    const actual = startsWith(buffer,[0x89,0x50,0x4e,0x47]) ? 'image/png' : startsWith(buffer,[0xff,0xd8,0xff]) ? 'image/jpeg' : buffer.toString('ascii',8,12)==='WEBP' ? 'image/webp' : '';
    if (actual !== declaredImage) throw invalid('图片内容与声明的类型不一致，已拒绝。');
  }
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', kind: 'image' };
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', kind: 'image' };
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', kind: 'image' };
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buffer, [0x50, 0x4b, 0x05, 0x06]) || startsWith(buffer, [0x50, 0x4b, 0x07, 0x08])) {
    return { mime: 'application/zip', kind: 'zip' };
  }
  const declared = ((hint?.mime ?? '').toLowerCase().split(';')[0] ?? '').trim();
  if (IMAGE_MIMES.includes(declared)) throw invalid('图片内容与声明的类型不一致，已拒绝。');
  if (buffer.includes(0)) throw invalid('资源内容不是可读取的文本。');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw invalid('资料必须使用 UTF-8 编码。');
  }
  const name = (hint?.name ?? '').toLowerCase();
  if (/^\s*(?:<!doctype\s+html|<html[\s>])/iu.test(text) || declared === 'text/html') return { mime: 'text/html', kind: 'html' };
  if (declared === 'text/markdown' || /\.(?:md|markdown)$/u.test(name)) return { mime: 'text/markdown', kind: 'markdown' };
  return { mime: 'text/plain', kind: 'text' };
}

export function assertWithinLimit(kind: ResourceKind, bytes: number): void {
  const limit = kind === 'image' ? RESOURCE_LIMITS.imageBytes : kind === 'zip' ? RESOURCE_LIMITS.bundleBytes : RESOURCE_LIMITS.textBytes;
  if (bytes > limit) {
    throw new BookError('invalid_input', `资源超过 ${Math.floor(limit / (1024 * 1024))} MiB 上限，已拒绝。`, {
      cause: Object.assign(new Error('too_large'), { code: 'too_large' satisfies ResourceFailureCode })
    });
  }
}

/** Reject oversized rasters before they ever reach the model or the UI. */
export function assertImagePixels(mime: string, bytes: Uint8Array | Buffer): void {
  const size = imageSize(mime, bytes);
  if (!size || !size.width || !size.height) throw invalid('图片结构无法识别，已拒绝。');
  if (size.width * size.height > RESOURCE_LIMITS.imagePixels) throw invalid('图片像素超过 4000 万上限，已拒绝。');
}

export interface ExtractedText { text: string; complete: boolean; omittedReason?: string }

const SCRIPT_STYLE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"')
    .replace(/&#39;|&apos;/gu, "'").replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&');
}

/**
 * HTML is turned into plain text for use as *material*: scripts and styles are dropped, tags are
 * stripped and entities decoded. Raw HTML never enters the message DOM (SPEC §6).
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(SCRIPT_STYLE, ' ')
      .replace(/<!--[\s\S]*?-->/gu, ' ')
      .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/giu, '\n')
      .replace(/<[^>]+>/gu, ' ')
  )
    .replace(/[ \t\u00a0]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/**
 * Text extraction keeps a bounded, honest slice. When the material exceeds the per-turn material
 * budget the result is marked incomplete with a reason instead of silently truncating.
 */
export function extractText(kind: ResourceKind, raw: string, budget = RESOURCE_LIMITS.materialBytes): ExtractedText {
  const source = kind === 'html' ? htmlToText(raw) : raw;
  const encoded = Buffer.byteLength(source, 'utf8');
  if (encoded <= budget) return { text: source, complete: true };
  const slice = Buffer.from(source, 'utf8').subarray(0, budget).toString('utf8');
  const text = slice.slice(0, Math.max(0, slice.length - 3));
  return { text, complete: false, omittedReason: `资料正文超过 ${Math.round(budget / 1024)} KiB，仅保留开头部分。` };
}

export function mimeForKind(kind: ResourceKind): string | null {
  if (kind === 'image') return null;
  if (kind === 'zip') return 'application/zip';
  if (kind === 'markdown') return 'text/markdown';
  if (kind === 'html') return 'text/html';
  if (kind === 'text') return 'text/plain';
  return null;
}

export { kindOfMime };
