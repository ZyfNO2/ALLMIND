import type { ChatMessage, EntryRef } from './memory-book.js';

export interface PresetPrompt {
  identifier:string; name?:string; role?:ChatMessage['role']; content?:string; marker?:boolean;
  injection_position?:number; injection_depth?:number; injection_order?:number; injection_trigger?:string[];
  [key:string]:unknown;
}
export interface PresetDocument {
  prompts:PresetPrompt[];
  prompt_order:{character_id:number;order:{identifier:string;enabled:boolean}[]}[];
  temperature?:number;top_p?:number;frequency_penalty?:number;presence_penalty?:number;
  openai_max_tokens?:number;openai_max_context?:number;
  [key:string]:unknown;
}
/** The original is local authoring data, never a model request. Edits keep the original intact. */
export interface StoredPromptPreset {
  id:string;name:string;revision:number;original:string;document:PresetDocument;orderBlock:number;
}
export type PromptSlot='charDescription'|'charPersonality'|'personaDescription'|'scenario'|'worldInfoBefore'|'worldInfoAfter'|'dialogueExamples'|'chatHistory'|'allmindMemory'|'allmindMaterials'|'allmindDesktopContext';
export interface PromptSegment {id:string;slot:PromptSlot;content:string;refs?:EntryRef[]}
export interface PromptCompilation {
  documentHash:string;originalHash:string;
  presetId:string;presetRevision:number;orderBlock:number;estimatedTokens:number;inputBudget:number;
  currentMessageIndex:number;status:'assembled'|'consumed';transport:'messages'|'web-text';
  items:{identifier:string;role:ChatMessage['role'];index:number;depth:number|null}[];
  warnings:string[];omissions:{id:string;reason:string}[];
  parameters:Record<string,number>;
}
export const promptSlots:PromptSlot[]=['charDescription','charPersonality','personaDescription','scenario','worldInfoBefore','worldInfoAfter','dialogueExamples','chatHistory','allmindMemory','allmindMaterials','allmindDesktopContext'];
