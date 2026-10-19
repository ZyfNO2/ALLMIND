import { BookError, type BookScope } from './memory-book.js';

/** Private instance configuration; never an author template. */
export interface ChatgptProjectBinding {
  id: string; characterId: string; pairingId: string; enabled: boolean;
  projectId: string; name: string; account: string;
  memory: 'unverified' | 'user-confirmed-project-only';
}
export interface ChatgptProjectTarget {
  binding: ChatgptProjectBinding; scope: BookScope;
  localTurnId: string | null; nextTurnId: string | null;
}
export const PROJECT_ID = /^g-p-[a-f0-9]{32}$/;
export const CONVERSATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/;
export function projectIdFromUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new BookError('invalid_input', '请填写完整 ChatGPT 项目链接。'); }
  const match = /^\/g\/(g-p-[a-f0-9]{32})(?:-[a-zA-Z0-9-]+)?\/project\/?$/.exec(url.pathname);
  if (url.origin !== 'https://chatgpt.com' || url.username || url.password || url.search || url.hash || !match) throw new BookError('invalid_input', '仅接受 chatgpt.com 的项目链接，不接受 GPT、聊天或外部链接。');
  return match[1]!;
}
export function validateProjectBinding(value: ChatgptProjectBinding): void {
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['id','characterId','pairingId','enabled','projectId','name','account','memory'].includes(key))) throw new BookError('invalid_input','项目绑定字段无效。');
  for (const key of ['id','characterId','pairingId'] as const) if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value[key])) throw new BookError('invalid_input','项目实例标识无效。');
  if (typeof value.enabled !== 'boolean' || !PROJECT_ID.test(value.projectId) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200 || !/^[a-f0-9]{64}$/.test(value.account) || !['unverified','user-confirmed-project-only'].includes(value.memory)) throw new BookError('invalid_input','项目绑定、账号或记忆状态无效。');
}
