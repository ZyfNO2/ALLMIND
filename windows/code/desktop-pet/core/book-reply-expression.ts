import type { ExpressionIntent } from '../contracts/index.js';
/** Bounded delivery of the character's own words; never infers a user's mood or edits Persona. */
export function bookReplyExpression(text: string): ExpressionIntent {
  const happy=/恭喜|太好了|很开心|谢谢|祝你/.test(text);
  return { emotion:happy?'happy':'neutral', intensity:happy?0.35:0,delivery:'',gesture:null };
}
