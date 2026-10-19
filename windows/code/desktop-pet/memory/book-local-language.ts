/** Small transparent lexical expansion, not inferred facts. All returned hits still need evidence. */
const topics: [string,RegExp][] = [
  ['address',/称呼|称为|叫我|叫你|名字/], ['drink',/饮品|饮料|热饮|咖啡|拿铁|美式|卡布奇诺|茶|果汁|牛奶/],
  ['job',/求职|面试|面谈|招聘|找工作/], ['pet',/宠物|小动物|毛孩子|喵星人|汪星人|猫|狗/],
  ['friend',/朋友|伙伴|好友|逛展|看展|展览/],
  ['film',/电影|影片|观影/], ['travel',/旅行|旅游|出游/],
  ['project',/项目|工程|开发|实现/], ['focus',/工作时|忙的时候|忙时|忙着|干活|赶工|插话|专注|安静陪伴/],
  ['experience',/共同经历|共同回忆|(?:一起|共同).*(?:重要事情|重要的事|重要经历)|(?:重要事情|重要的事|重要经历).*(?:一起|共同)/],
];
export function bookTopics(text:string):string[]{return topics.filter(([,pattern])=>pattern.test(text)).map(([topic])=>topic);}
export function localLanguageTerms(text:string):string[]{
  const terms=bookTopics(text).map(topic=>`topic:${topic}`);
  for(const match of text.matchAll(/(?:\d{4}[-年])?(\d{1,2})\s*[-月]\s*(\d{1,2})(?:\s*日)?/g))terms.push(`month-day:${Number(match[1])}-${Number(match[2])}`);
  if(/最爱|最喜欢|最喜爱/.test(text))terms.push('preference:favorite');
  return terms;
}
export function explicitBookNames(text:string):string[]{
  return [...text.matchAll(/(?:昵称|英文别名|别名|又名|猫叫|狗叫)\s*[：:]?\s*([\p{Script=Han}a-zA-Z][\p{Script=Han}a-zA-Z0-9_-]{1,19})(?=[，。；、\s]|$)/gu)].map(match=>match[1]!);
}
export function supportsLocalQuestion(query:string,text:string,origin:string,type:string,explicitName=false):boolean {
  // Explicit third-party user labels cannot be answered by another person's generic "用户" facts.
  const owners=query.match(/用户\s*[a-z][a-z0-9_-]*/gi)??[];
  if(owners.some(owner=>!text.replace(/\s+/g,'').toLowerCase().includes(owner.replace(/\s+/g,'').toLowerCase())))return false;
  if(/另一个角色|其他角色/.test(query)&&!text.includes('另一个角色')&&!text.includes('其他角色'))return false;
  if(/真实|现实|实际|真的/.test(query)&&origin==='authored'&&['story','lore'].includes(type))return false;
  const requested=bookTopics(query),provided=bookTopics(text);
  if(!explicitName&&requested.length&&provided.length&&!requested.some(topic=>provided.includes(topic)))return false;
  // An explicitly unknown outcome is useful context but not evidence answering a result question.
  if(/通过|结果|成功了吗|成败|赢了吗/.test(query)&&!/有.*(?:确定|消息)|确定.*消息/.test(query)&&/尚未知道|不知道结果|结果未知|未公布|尚未确定/.test(text))return false;
  return true;
}
