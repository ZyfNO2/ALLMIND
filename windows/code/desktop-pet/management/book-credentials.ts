import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync, readFileSync, renameSync, lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { BookError } from '../contracts/memory-book.js';
import { validateIdentity } from '../memory/book-validation.js';
import { isPrivateFileSync, restrictPrivatePathSync } from '../core/platform-files.js';

/** Separate from exportable Book/config; credentials never appear in read APIs or traces. */
export class BookCredentials {
  constructor(private readonly directory: string) {}
  private file(id: string): string { validateIdentity(id, 'credentialId'); return join(this.directory, `key-${createHash('sha256').update(id).digest('hex')}.txt`); }
  save(id: string, value: string): void {
    if(id==='local-no-auth')throw new BookError('invalid_input','免凭据连接不能保存密钥。');
    if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\r\n\0]/.test(value)) throw new BookError('invalid_input', '凭据格式无效。');
    mkdirSync(this.directory, { recursive: true }); const file = this.file(id), temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, value, { flag: 'wx', mode: 0o600 }); restrictPrivatePathSync(temporary); renameSync(temporary, file);
  }
  status(id:string):{state:'ready'|'missing'|'invalid'|'not-required'}{
    const file=this.file(id);if(id==='local-no-auth')return {state:'not-required'};
    if(!existsSync(file))return {state:'missing'};
    const stat=lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||!isPrivateFileSync(file)||stat.size<1||stat.size>4096)return {state:'invalid'};
    return {state:'ready'};
  }
  revoke(id:string):void{
    const file=this.file(id);if(id==='local-no-auth')throw new BookError('invalid_input','免凭据连接没有可撤销的密钥。');
    if(!existsSync(file))return;
    if(lstatSync(file).isSymbolicLink()||!lstatSync(file).isFile())throw new BookError('conflict','凭据文件身份异常，未删除。');
    unlinkSync(file);
  }
  async get(id: string): Promise<string> {
    if (id === 'local-no-auth') return '';
    const file = this.file(id);
    if (!existsSync(file)) throw new BookError('unavailable', '绑定的凭据尚未保存。');
    if (this.status(id).state!=='ready') throw new BookError('unavailable', '凭据文件权限或格式无效，请重新授权。');
    return readFileSync(file, 'utf8');
  }
}
