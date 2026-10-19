import type { CompanionRelationship } from '../../../../core/companion-relationship'
import type { BookSnapshot } from '../../../../contracts/memory-book'
export default function RelationshipPanel({relationship,book,revoke}:{relationship:CompanionRelationship|null|undefined;book:BookSnapshot|null;revoke:(id:string)=>void}){
  if(!relationship)return <p>关系依据尚为空；不会凭问候或离线时长推断信任。</p>
  return <><div className="mb-relationship-overview"><div><span>熟悉度</span><strong>{relationship.familiarity}/100</strong><meter aria-label="熟悉度" min={0} max={100} value={relationship.familiarity}/><small>{relationship.familiarity/2} 组去重有效依据</small></div><div><span>明确共同经历</span><strong>{relationship.commonExperiences} 项</strong><small>仅按有效来源记录</small></div><div><span>信任反馈</span><strong>{relationship.trust===null?'尚未提供':relationship.trust+'/100'}</strong></div></div><p>角色回应基调：{relationship.emotion?relationship.emotion.kind==='happy'?'温和庆祝':'温和关心':'暂无有效事件情绪'}{relationship.emotion&&<small>依据：{book?.entries.find(entry=>entry.id===relationship.emotion!.entryId)?.fact?.quote??'来源正在刷新'}</small>}</p><details><summary>关系与相处依据 · r{relationship.revision}</summary>
    <p>熟悉度 {relationship.familiarity}/100（每组去重的有效依据 2 点，上限 100）；信任 {relationship.trust===null?'未提供明确反馈':`${relationship.trust}/100（仅明确正向反馈）`}；明确共同经历 {relationship.commonExperiences} 项。</p>
    <p>这些是可追溯规则状态，不能代表人的心理测量。离线、未回应和拒绝不扣关系值；事件情绪在两小时内恢复到中性。</p>
    {relationship.preferences.map(pref=><p key={pref.entryId}>沟通偏好：{pref.predicate} · {pref.value}</p>)}
    {relationship.interests.map(interest=><p key={interest.entryId}>用户兴趣：{interest.value}</p>)}
    <small>角色自主兴趣与核心人格继续由角色设定持有，关系学习不改写它们。</small>
    <details><summary>查看关系来源并撤销</summary>{relationship.basisRefs.slice(-32).map(ref=>{const entry=book?.entries.find(entry=>entry.id===ref.entryId);return <article key={ref.entryId}><b>{entry?.body??ref.entryId}</b><small>r{ref.revision} · 原文：{entry?.fact?.quote??'来源正在刷新'}</small><button disabled={!entry} onClick={()=>revoke(ref.entryId)}>撤销此关系依据</button></article>})}</details>
  </details></>
}
