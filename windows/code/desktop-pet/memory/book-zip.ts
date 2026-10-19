import { createHash } from 'node:crypto';
import { fromBuffer } from 'yauzl';
import type { Readable } from 'node:stream';
import { BookError, type KnowledgeView } from '../contracts/memory-book.js';
import { validateIdentity } from './book-validation.js';
import { draftCharacterPack } from './draft-character-pack.js';

const MiB = 1024 * 1024;
const invalid = (message: string) => new BookError('invalid_input', 'ZIP 导入：' + message);
function safePath(name: string): void {
  const parts = name.replace(/\/$/, '').split('/');
  if (!name || name.length > 200 || /[\\:\0]/u.test(name) || parts.some(p => !p || p === '.' || p === '..')) throw invalid('包内路径无效。');
}
async function readArchive(bytes: Buffer): Promise<Map<string, Buffer>> {
  if (!Buffer.isBuffer(bytes) || bytes.length > MiB || bytes.length < 22) throw invalid('ZIP 文件必须不超过 1 MiB，且为有效压缩包。');
  return new Promise((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, archive) => {
      if (error) { reject(invalid(error.message)); return; }
      const files = new Map<string, Buffer>(), names = new Set<string>(); let total = 0, settled = false, active: Readable | undefined;
      const fail = (failure: unknown) => {
        if (settled) return; settled = true; active?.destroy(); archive.close();
        reject(failure instanceof BookError ? failure : invalid(failure instanceof Error ? failure.message : String(failure)));
      };
      archive.on('error', fail);
      archive.on('end', () => { if (!settled) { settled = true; archive.close(); resolve(files); } });
      if (archive.entryCount > 64) { fail(invalid('包内条目超过 64。')); return; }
      archive.on('entry', entry => { void (async () => {
        safePath(entry.fileName);
        if (names.has(entry.fileName.toLowerCase())) throw invalid('包内包含重复文件名。'); names.add(entry.fileName.toLowerCase());
        if (entry.generalPurposeBitFlag & 1 || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw invalid('不接受加密文件或符号链接。');
        if (entry.uncompressedSize > MiB || total + entry.uncompressedSize > 8 * MiB) throw invalid('解压文件超过 1 MiB 或总量超过 8 MiB。');
        if (entry.fileName.endsWith('/')) { if (entry.uncompressedSize !== 0) throw invalid('目录包含异常数据。'); archive.readEntry(); return; }
        const stream = await new Promise<Readable>((done, failed) => archive.openReadStream(entry, (err, value) => err ? failed(err) : done(value!)));
        active = stream; let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          size += chunk.length; total += chunk.length;
          if (size > MiB || total > 8 * MiB) throw invalid('实际解压数据超过限额。'); chunks.push(Buffer.from(chunk));
        }
        active = undefined;
        if (size !== entry.uncompressedSize) throw invalid('解压长度与 ZIP 声明不一致。');
        files.set(entry.fileName, Buffer.concat(chunks)); archive.readEntry();
      })().catch(fail); });
      archive.readEntry();
    });
  });
}
function utf8(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw invalid('资料必须使用 UTF-8。'); }
}
export async function unpackBookZip(bytes: Buffer): Promise<{ text: string; bookFile: string; excludedFiles: string[]; knowledgeView?: KnowledgeView }> {
  const files = await readArchive(bytes);
  const manifests = [...files.keys()].filter(name => name.split('/').at(-1) === 'manifest.json');
  if (manifests.length > 1) throw invalid('存在多个 manifest.json。');
  let knowledgeView: KnowledgeView | undefined;
  if (manifests.length) {
    const manifestFile = manifests[0]!, prefix = manifestFile.slice(0, -'manifest.json'.length);
    let manifest;
    try { manifest = JSON.parse(utf8(files.get(manifestFile)!)); } catch (cause) { throw invalid('manifest.json 无效。'); }
    if(manifest?.schema==='aiki.character-pack.draft/1'){
      const converted=draftCharacterPack(manifest,prefix,files);
      return {text:converted.text,bookFile:manifestFile,excludedFiles:[...files.keys()].filter(name=>name!==manifestFile&&!converted.used.includes(name))};
    }
    if (manifest?.schema !== 'aiki-delivery/v1' || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 64) throw invalid('只接受 aiki-delivery/v1 交付清单。');
    const listed = new Set<string>();
    for (const item of manifest.files) {
      if (!item || typeof item.file !== 'string') throw invalid('清单文件记录无效。'); safePath(item.file);
      const name = prefix + item.file, body = files.get(name);
      if (listed.has(name) || !body || !Number.isSafeInteger(item.bytes) || item.bytes !== body.length || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256) || createHash('sha256').update(body).digest('hex') !== item.sha256) throw invalid('清单文件缺失、重复或 SHA256 / 长度不匹配：' + item.file);
      listed.add(name);
    }
    if ([...files.keys()].some(name => name !== manifestFile && !listed.has(name))) throw invalid('存在未列入清单的文件。');
    if (manifest.knowledgeView !== undefined) {
      const view = manifest.knowledgeView;
      if (!view || !Number.isSafeInteger(view.cutoff) || view.cutoff < 0 || view.cutoff > 1000000) throw invalid('推荐知识视角无效。');
      validateIdentity(view.worldId, 'worldId'); validateIdentity(view.branch, 'branch');
      knowledgeView = { worldId: view.worldId, branch: view.branch, cutoff: view.cutoff };
    }
  }
  const candidates = [...files.keys()].filter(name => !name.split('/').some(p => p.toLowerCase() === 'optional') && !/\/(?:__MACOSX)\//u.test('/' + name) && !name.endsWith('manifest.json') && /\.(?:json|md|markdown)$/iu.test(name) && !/(?:^|\/)README\.md$/iu.test(name));
  if (candidates.length !== 1) throw invalid('需要且只能包含一份正式 Book JSON / .aiki.md；可选包请放 optional/。');
  const bookFile = candidates[0]!;
  return { text: utf8(files.get(bookFile)!), bookFile, excludedFiles: [...files.keys()].filter(name => name !== bookFile), ...(knowledgeView ? { knowledgeView } : {}) };
}
