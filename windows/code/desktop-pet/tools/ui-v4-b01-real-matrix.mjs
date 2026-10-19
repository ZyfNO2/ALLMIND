// B01 real-chain acceptance matrix: drives the NORMAL production chain (management HTTP API
// -> BookRuntime -> ChatgptWebModel -> embedded bridge -> logged-in ChatGPT project) against
// the user's own running instance. Sends only identifiable synthetic content in NEW test
// sessions; never modifies config, bindings, or existing history.
//
//   node tools/ui-v4-b01-real-matrix.mjs [--skip-restart]
//
// Evidence is written to docs/next/ui-rework/evidence/b01-real-matrix-<stamp>/matrix.json.
// Raw project/thread ids are hashed; the plain mapping stays only in the local evidence dir
// and never enters the delivery report.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const petRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // windows/code/desktop-pet
const dataDir = resolve(process.env.AIKI_BOOK_DATA ?? join(petRoot, '../../.local/memory-book'));
const stamp = Date.now().toString(36);
const evidenceDir = resolve(petRoot, '../../../docs/next/ui-rework/evidence', 'b01-real-matrix-' + stamp);
const receiptPath = join(dataDir, 'chatgpt-web-requests.json');
const sessionPath = join(dataDir, 'management-session.json');
const skipRestart = process.argv.includes('--skip-restart');
const sha16 = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
const sleep = ms => new Promise(done => setTimeout(done, ms));

const evidence = { startedAt: new Date().toISOString(), dataDirHash: sha16(dataDir), steps: [], map: {} };
const record = (name, payload) => { evidence.steps.push({ name, at: new Date().toISOString(), ...payload }); process.stdout.write(`[B01] ${name} ${JSON.stringify(payload)}\n`); };
const fail = (name, message, payload = {}) => { evidence.steps.push({ name, at: new Date().toISOString(), failed: true, message, ...payload }); writeFileSync(join(evidenceDir, 'matrix.json'), JSON.stringify(evidence, null, 2) + '\n'); throw new Error(`${name}: ${message}`); };

function sessionUrl() {
  if (!existsSync(sessionPath)) throw Error('管理会话文件不存在，后端未就绪。');
  const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
  if (typeof session.url !== 'string' || !session.url.includes('#token=')) throw Error('管理会话文件缺少有效 URL。');
  return session.url;
}
async function api(path, init = {}, url = sessionUrl()) {
  const token = new URLSearchParams(new URL(url).hash.slice(1)).get('token');
  const response = await fetch(new URL(path, url).href.replace(/#.*$/, ''), { ...init, headers: { Authorization: 'Bearer ' + token, ...(init.body ? { 'Content-Type': 'application/json' } : {}) }, signal: AbortSignal.timeout(320_000) });
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${typeof body === 'object' ? body?.error?.code + ' ' + body?.error?.message : body}`);
  return body;
}
function receiptState() {
  if (!existsSync(receiptPath)) return { used: 0, threads: 0 };
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  return { used: (receipt.used ?? []).length, threads: (receipt.threads ?? []).length, active: receipt.active?.id ?? null, activeSubmitted: receipt.active?.submitted ?? null };
}
async function waitBackend(afterStamp, note) {
  const deadline = Date.now() + 120_000;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const stat = statSync(sessionPath);
      if (stat.mtimeMs > afterStamp) {
        const url = sessionUrl();
        const runtime = await api('/api/memory-book/v1/runtime', {}, url);
        last = { urlHash: sha16(url), revision: runtime.config.revision };
        return { url, runtime };
      }
    } catch (error) { last = String(error); }
    await sleep(1500);
  }
  throw new Error(`后端未在 120 秒内回来（${note}）：${last}`);
}

mkdirSync(evidenceDir, { recursive: true });
const marker = `B01-${stamp}-${sha16('marker' + stamp).slice(0, 4).toUpperCase()}`;
let characterId = process.env.B01_CHARACTER;
const sessionOne = `b01-matrix-${stamp}-a`;
const sessionTwo = `b01-matrix-${stamp}-b`;
const chatUrl = sid => `/api/memory-book/v1/chat?${new URLSearchParams({ characterId, sessionId: sid, pairingId: 'local-user' })}`;
const threadUrl = sid => `/api/memory-book/v1/chatgpt-web/projects/thread?${new URLSearchParams({ characterId, sessionId: sid })}`;

try {
  // 0. baseline: the instance must be the embedded source with an enabled binding
  const runtime = await api('/api/memory-book/v1/runtime');
  const config = runtime.config;
  const candidates = (config.chatgptProjects ?? []).filter(row => row.enabled && row.pairingId === 'local-user');
  const binding = characterId
    ? candidates.find(row => row.characterId === characterId)
    : candidates.find(row => row.characterId === config.currentCharacterId) ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!binding) fail('baseline', '没有启用的项目绑定');
  characterId = binding.characterId;
  if (!config.characters.some(row => row.id === characterId)) fail('baseline', '绑定角色不存在，未发送');
  if (config.companion?.autoMemory) fail('baseline', '自动记忆已开启；本工具不修改配置或把合成测试写为事实，未发送');
  if (config.chatgptWeb?.transport !== 'embedded') fail('baseline', '来源不是独立页面');
  if (config.mainModel?.kind !== 'chatgpt-web') fail('baseline', '主模型不是 ChatGPT 网页来源');
  if ((await api('/api/memory-book/v1/chatgpt-web/status')).activeRequest) fail('baseline', '当前有未决请求，未导航或发送');
  const beforeRun = receiptState();
  const configHash = sha16(JSON.stringify(config));
  record('baseline', { revision: config.revision, characterHash: sha16(binding.characterId), projectHash: sha16(binding.projectId), accountHash: sha16(binding.account), transport: config.chatgptWeb.transport, thinkingLevel: config.chatgptWeb.thinkingLevel, conversationMode: config.chatgptWeb.conversationMode, marker });
  evidence.map.projectId = binding.projectId;

  // 1. zero-message project check on the already-authorized project
  const beforeCheck = receiptState();
  const checked = await api('/api/memory-book/v1/chatgpt-web/projects/check', { method: 'POST', body: JSON.stringify({ url: `https://chatgpt.com/g/${binding.projectId}/project` }) });
  const afterCheck = receiptState();
  if (checked.projectId !== binding.projectId || checked.account !== binding.account) fail('check', '检查返回的项目或账号与绑定不一致', { returnedHash: sha16(checked.projectId) });
  if (afterCheck.used !== beforeCheck.used || afterCheck.threads !== beforeCheck.threads) fail('check', '零消息检查改动了请求回执', { beforeCheck, afterCheck });
  record('check', { zeroMessage: true, nameMatches: checked.name === binding.name, memory: checked.memory, used: afterCheck.used, threads: afterCheck.threads });

  // 2. round 1 in a NEW test session -> creates the project thread through the normal chain
  const round1 = await api(chatUrl(sessionOne), { method: 'POST', body: JSON.stringify({ text: `这是 B01 验收合成消息，不是真实经历。请记住暗号「${marker}」，只回复“已记住”。` }) });
  if (!String(round1.turn?.assistant ?? '').trim()) fail('round-1', '回复为空');
  const thread1 = (await api(threadUrl(sessionOne))).thread;
  if (!thread1 || thread1.projectId !== binding.projectId) fail('round-1', '会话没有确认到项目线程', { threadHash: thread1 ? sha16(thread1.conversationId) : null });
  if (thread1.targetChanged) fail('round-1', '目标被标记为已变化');
  evidence.map.threadOne = thread1.conversationId;
  record('round-1', { turnId: round1.turn.id, replyLength: round1.turn.assistant.length, threadHash: sha16(thread1.conversationId), projectHash: sha16(thread1.projectId) });

  // 3. Confirm the same thread independently of marker recall. Project/account-side
  //    context may also know the marker; local continuation context carries systems only.
  const round2 = await api(chatUrl(sessionOne), { method: 'POST', body: JSON.stringify({ text: '只输出我上一条让你记住的暗号本身，不要任何其他文字。' }) });
  const thread2 = (await api(threadUrl(sessionOne))).thread;
  const echo = String(round2.turn?.assistant ?? '').includes(marker);
  if (!thread2 || thread2.conversationId !== thread1.conversationId) fail('round-2', '第二轮没有续接同一线程', { before: sha16(thread1.conversationId), after: thread2 ? sha16(thread2.conversationId) : null });
  record('round-2', { sameThread: true, markerEchoed: echo, reply: String(round2.turn?.assistant ?? '').slice(0, 120) });
  if (!echo) fail('round-2', '第二轮没有确认第一轮合成暗号（同线程归属证据不足）');

  if (skipRestart) {
    record('restart', { skipped: true, reason: '--skip-restart' });
  } else {
    // 4. real backend restart through the product's own console endpoint
    const restartStamp = statSync(sessionPath).mtimeMs;
    const beforePid = JSON.parse(readFileSync(sessionPath, 'utf8')).pid;
    let restartError = null;
    try { await api('/api/memory-book/v1/chatgpt-web/backend/restart', { method: 'POST', body: '{}' }); } catch (error) { restartError = String(error); }
    const back = await waitBackend(restartStamp, 'restart');
    if (back.runtime.config.revision !== config.revision) fail('restart', '重启改变了配置修订', { before: config.revision, after: back.runtime.config.revision });
    if (back.runtime.config.chatgptProjects?.find(row => row.enabled)?.projectId !== binding.projectId) fail('restart', '重启改变了绑定');
    const afterRestart = receiptState();
    if (afterRestart.threads < 1) fail('restart', '重启后线程映射丢失');
    const afterPid = JSON.parse(readFileSync(sessionPath, 'utf8')).pid;
    if (!Number.isInteger(beforePid) || !Number.isInteger(afterPid) || beforePid === afterPid) fail('restart', '后端进程未证明发生更替');
    record('restart', { restarted: true, backendPidChanged: true, requestFailedAsExpected: restartError !== null, revisionStable: true, threads: afterRestart.threads, urlHash: sha16(back.url) });

    // 5. round 3 after restart continues the same confirmed thread
    const round3 = await api(chatUrl(sessionOne), { method: 'POST', body: JSON.stringify({ text: '刚重启完。只输出之前那个暗号本身，不要任何其他文字。' }) }, back.url);
    const thread3 = (await api(threadUrl(sessionOne), undefined, back.url)).thread;
    if (!thread3 || thread3.conversationId !== thread1.conversationId) fail('round-3', '重启后没有续接原线程', { before: sha16(thread1.conversationId), after: thread3 ? sha16(thread3.conversationId) : null });
    const echo3 = String(round3.turn?.assistant ?? '').includes(marker);
    record('round-3', { sameThreadAfterRestart: true, markerEchoed: echo3, reply: String(round3.turn?.assistant ?? '').slice(0, 120) });
    if (!echo3) fail('round-3', '重启后没有回显第一轮暗号');
  }

  // 6. A NEW local session must use a NEW thread. Project/account-side context can
  // still expose the marker: report that observation without guessing its mechanism.
  const round4 = await api(chatUrl(sessionTwo), { method: 'POST', body: JSON.stringify({ text: `新会话开始。如果你在更早的对话里见过一个 B01 验收暗号，请原样输出它；如果没有，只回复“没有”。` }) });
  const thread4 = (await api(threadUrl(sessionTwo))).thread;
  if (!thread4 || thread4.projectId !== binding.projectId) fail('new-session', '新会话没有落入目标项目', { threadHash: thread4 ? sha16(thread4.conversationId) : null });
  if (thread4.conversationId === thread1.conversationId) fail('new-session', '新会话错误复用了旧线程');
  const leak = String(round4.turn?.assistant ?? '').includes(marker);
  evidence.map.threadTwo = thread4.conversationId;
  record('new-session', { newThread: true, projectHash: sha16(thread4.projectId), threadHash: sha16(thread4.conversationId), markerKnownAcrossSessions: leak, reply: String(round4.turn?.assistant ?? '').slice(0, 120) });

  // 7. A denied incognito call must not create a request or a private-session file.
  const beforePrivate = receiptState();
  let privateFailure = null;
  try { await api(chatUrl('b01-private-' + stamp), { method: 'POST', body: JSON.stringify({ text: 'B01 合成无痕拒发测试', incognito: true }) }); }
  catch (error) { privateFailure = String(error.message); }
  if (!privateFailure?.startsWith('HTTP 409: conflict ')) fail('incognito-refused', '没有在发送前收到预期409拒绝');
  const afterPrivate = receiptState();
  if (JSON.stringify(beforePrivate) !== JSON.stringify(afterPrivate)) fail('incognito-refused', '拒发仍改变了网页请求回执');
  const privateScope = { characterId, pairingId: 'local-user', sessionId: 'b01-private-' + stamp };
  const privateHash = createHash('sha256').update(JSON.stringify(privateScope)).digest('hex');
  if (existsSync(join(dataDir, 'session-' + privateHash + '.jsonl'))) fail('incognito-refused', '拒发后出现了持久会话文件');
  record('incognito-refused', { httpStatus: 409, receiptUnchanged: true, persistentSessionCreated: false });

  const finalConfig = (await api('/api/memory-book/v1/runtime')).config;
  if (sha16(JSON.stringify(finalConfig)) !== configHash) fail('final-state', '配置在验收期间改变，需核对');
  const afterRun = receiptState(), expectedRequests = skipRestart ? 3 : 4;
  if (afterRun.active || afterRun.used - beforeRun.used !== expectedRequests || afterRun.threads - beforeRun.threads !== 2) fail('final-state', '请求或线程增量不符预期，不宣称零重发', { beforeRun, afterRun });
  record('final-state', { configUnchanged: true, requestDelta: expectedRequests, threadDelta: 2, activeRequest: false });

  record('done', { steps: evidence.steps.length });
} finally {
  writeFileSync(join(evidenceDir, 'matrix.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(`evidence -> ${evidenceDir}/matrix.json\n`);
}
