import type { BookEntry, RuntimeCharacter } from '../../../../contracts/memory-book'

export function CharacterKnowledge({ role, update }: { role: RuntimeCharacter; update: (role: RuntimeCharacter) => void }) {
  const view = role.knowledgeView
  return <details><summary>角色知识视角</summary><p>限定作品、分支与已知章节；带知情边界的事实会在检索前过滤。</p>
    <label><input type="checkbox" checked={!!view} onChange={e => { if (e.target.checked) update({ ...role, knowledgeView: { worldId: 'world', branch: 'main', cutoff: 0 } }); else { const { knowledgeView: _view, ...rest } = role; update(rest) } }} />启用角色知识视角</label>
    {view && <>{(['worldId', 'branch'] as const).map(key => <label key={key}>{key === 'worldId' ? '作品 ID' : '分支 ID'}<input value={view[key]} onChange={e => update({ ...role, knowledgeView: { ...view, [key]: e.target.value } })} /></label>)}<label>已知章节截止点<input type="number" min="0" value={view.cutoff} onChange={e => update({ ...role, knowledgeView: { ...view, cutoff: Number(e.target.value) } })} /></label></>}
  </details>
}
export function EntryKnowledge({ entry, update }: { entry: BookEntry; update: (entry: BookEntry) => void }) {
  const boundary = entry.knowledge
  return <><label><input type="checkbox" disabled={entry.type === 'memory' || !!entry.fact || !!entry.state || !!entry.event} checked={entry.pairingId !== null} onChange={e => update({ ...entry, pairingId: e.target.checked ? 'local-user' : null })} />仅当前用户与角色</label>
    <details><summary>事实与设定的知情范围</summary><label><input type="checkbox" checked={!!boundary} onChange={e => { if (e.target.checked) update({ ...entry, knowledge: { worldId: 'world', branch: 'main', chapter: 0, awareness: 'heard' } }); else { const { knowledge: _knowledge, ...rest } = entry; update(rest) } }} />限制角色知情范围</label>
    {boundary && <>{(['worldId', 'branch'] as const).map(key => <label key={key}>{key === 'worldId' ? '所属作品 ID' : '所属分支 ID'}<input value={boundary[key]} onChange={e => update({ ...entry, knowledge: { ...boundary, [key]: e.target.value } })} /></label>)}<label>发生章节<input type="number" min="0" value={boundary.chapter} onChange={e => update({ ...entry, knowledge: { ...boundary, chapter: Number(e.target.value) } })} /></label><label>角色知情<select value={boundary.awareness} onChange={e => update({ ...entry, knowledge: { ...boundary, awareness: e.target.value as typeof boundary.awareness } })}><option value="experienced">亲历</option><option value="heard">听闻</option><option value="unknown">未知</option></select></label></>}
    {entry.fact && <p>事实依据：{entry.fact.quote} · {entry.fact.status}</p>}
    </details></>
}
