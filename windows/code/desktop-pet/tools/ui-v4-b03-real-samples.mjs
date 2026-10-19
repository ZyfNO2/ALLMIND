// B03 §9 real-chain samples: 6 fixed queries x (per-turn short, per-turn detailed) = 12 single
// replies, plus 3 boundary samples (detailed + in-message cap 100, short + in-message floor 200,
// intra-message numeric conflict). Drives the NORMAL production chain over the already-authorized
// ChatGPT source with the CURRENT character (no project binding -> ordinary non-temporary chats,
// kept as identifiable test sessions). No config/binding/credential writes, no retries, no local
// history beyond the real chain's own saved turns.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { countReplyChars } from '../dist/core/reply-length.js';

const petRoot = resolve(process.cwd());
const dataDir = resolve(process.env.AIKI_BOOK_DATA ?? join(petRoot, '../../.local/memory-book'));
const stamp = Date.now().toString(36);
const evidenceDir = resolve(petRoot, '../../../docs/next/ui-rework/evidence/b03-real-samples-' + stamp);
mkdirSync(evidenceDir, { recursive: true });
const evidence = { startedAt: new Date().toISOString(), characterId: process.env.B03_CHARACTER ?? 'allmind-companion-v1', samples: [], notes: ['已授权来源上的真实单回复；全部使用可辨识合成测试会话；零配置/绑定/凭据写入；零重试。'] };
const characterId = evidence.characterId;
const sha16 = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 16);

const sessionUrl = () => {
  const session = JSON.parse(readFileSync(join(dataDir, 'management-session.json'), 'utf8'));
  if (typeof session.url !== 'string' || !session.url.includes('#token=')) throw Error('管理会话文件缺少有效 URL。');
  return session.url;
};
async function api(path, init = {}, url = sessionUrl()) {
  const token = new URLSearchParams(new URL(url).hash.slice(1)).get('token');
  const response = await fetch(new URL(path, url).href, { ...init, headers: { Authorization: 'Bearer ' + token, ...(init.body ? { 'Content-Type': 'application/json' } : {}) }, signal: AbortSignal.timeout(320_000) });
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${typeof body === 'object' ? body?.error?.code + ' ' + body?.error?.message : body}`);
  return body;
}

const QUERIES = [
  ['greeting', '你好'],
  ['acknowledgement', '好的，收到'],
  ['comfort', '今天有点累，想休息一下'],
  ['explanation', '为什么天空是蓝色的'],
  ['technical', '如何在 Windows 上配置 Python 环境变量'],
  ['comparison', '对比一下远程办公和办公室办公的优缺点'],
];
try {
  const runtime = await api('/api/memory-book/v1/runtime');
  const role = runtime.config.characters.find(role => role.id === characterId);
  if (!role) throw new Error('当前角色不存在');
  if (!runtime.config.mainModel || runtime.config.mainModel.kind !== 'chatgpt-web') throw new Error('主模型不是已授权的 ChatGPT 网页来源');
  record('baseline', { revision: runtime.config.revision, transport: runtime.config.chatgptWeb?.transport, conversationMode: runtime.config.chatgptWeb?.conversationMode, roleReplyStyle: role.replyStyle ?? 'natural(default)', roleRange: role.replyLength ?? null, projectBindingOnThisRole: Boolean((runtime.config.chatgptProjects ?? []).find(row => row.characterId === characterId && row.enabled)) });

  let index = 0;
  const send = async (label, turnStyle, text) => {
    const sessionId = `b03-style-${stamp}-${String(index).padStart(2, '0')}`;
    const startedAt = Date.now();
    const result = await api(`/api/memory-book/v1/chat?${new URLSearchParams({ characterId, sessionId, pairingId: 'local-user' })}`, { method: 'POST', body: JSON.stringify({ text, ...(turnStyle && turnStyle !== 'inherit' ? { replyStyle: turnStyle } : {}) }) });
    const turn = result.turn;
    const decision = turn.replyStyleDecision ?? null;
    const measured = countReplyChars(turn.assistant);
    evidence.samples.push({ label, sessionHash: sha16(sessionId), requestedStyle: turnStyle ?? 'inherit', query: text, selectedStyle: decision?.selectedStyle ?? null, source: decision?.source ?? null, intent: decision?.intent ?? null, targetChars: decision?.targetChars ?? null, effectiveRange: decision?.effectiveRange ?? null, constrained: decision?.constrained ?? null, requestConflict: decision?.requestConflict ?? null, serverReportedActual: turn.replyLength?.actualChars ?? null, localCount: measured, countsAgree: turn.replyLength?.actualChars === undefined || turn.replyLength.actualChars === measured, durationMs: Date.now() - startedAt, reply: turn.assistant });
    index++;
    const sample = evidence.samples.at(-1);
    console.log(`[B03] ${label}: style=${sample.selectedStyle} chars=${sample.localCount} source=${sample.source} intent=${sample.intent} ${sample.durationMs}ms`);
    writeFileSync(join(evidenceDir, 'samples.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  };

  for (const [label, query] of QUERIES) {
    await send(`${label}-short`, 'short', query);
    await send(`${label}-detailed`, 'detailed', query);
  }
  await send('boundary-detailed-cap100', 'detailed', '请详细介绍远程办公和办公室办公的优缺点，这次不超过100字');
  await send('boundary-short-floor200', 'short', '简单说说今天的心情就好，这次至少200字');
  await send('boundary-numeric-conflict', 'detailed', '这次不超过50字，而且这次至少100字');

  // §9 pairwise expectations, computed from the recorded samples.
  const pairs = {};
  for (const label of ['explanation', 'technical', 'comparison']) {
    const short = evidence.samples.find(sample => sample.label === `${label}-short`);
    const detailed = evidence.samples.find(sample => sample.label === `${label}-detailed`);
    pairs[label] = { shortChars: short?.localCount ?? 0, detailedChars: detailed?.localCount ?? 0, detailedLongerByHalf: Boolean(short && detailed && detailed.localCount >= short.localCount * 1.5) };
  }
  evidence.pairs = pairs;
  evidence.finishedAt = new Date().toISOString();
  console.log('[B03] pairs:', JSON.stringify(pairs));
} finally {
  writeFileSync(join(evidenceDir, 'samples.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(`evidence -> ${evidenceDir}`);
}
function record(name, payload) { evidence[name] = payload; console.log(`[B03] ${name} ${JSON.stringify(payload)}`); }
