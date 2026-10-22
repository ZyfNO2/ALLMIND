import type {BookEntry, BookScope, ModelBinding, RuntimeCharacter, WikiSource} from './memory-book.js';
import type {StoredPromptPreset} from './prompt-preset.js';

/** Locally reviewed data, never a credential-bearing desktop RuntimeConfig. */
export interface ChannelPublication {
  schemaVersion:'allmind-channel-publication/v1';
  id:string; revision:number; hash:string;
  sourceScope:BookScope;
  sourceFingerprint:string;
  character:Pick<RuntimeCharacter,'id'|'name'|'intro'>;
  preset:StoredPromptPreset|null;
  entries:BookEntry[];
  sources:WikiSource[];
}

export interface QqConversation {
  connectorId:string;
  selfId:string;
  kind:'private'|'group';
  targetId:string;
  /** Required for group identity. Private chats are already keyed by their peer. */
  senderId?:string;
}

export interface QqIncomingMessage extends QqConversation {
  messageId:string;senderId:string;senderName:string;text:string;
  eventKey:string;mentionsSelf:boolean;hasUnsupportedMedia:boolean;
}

export interface QqChannelConfig {
  revision:number;enabled:boolean;connectorId:string;selfId:string;port:number;
  privateIds:string[];groupIds:string[];publicationId:string;epoch:string;
  conversationEpochs?:Record<string,string>;
  /** Explicit channel binding. Never follows later desktop model changes. */
  model:ModelBinding|null;tokenCredentialId:string|null;
}

export interface ChannelDelivery {
  event:QqIncomingMessage;scope:BookScope;publicationHash:string;turnId:string;receivedAt:number;
  state:'queued'|'generating'|'generated'|'sent'|'failed'|'unknown'|'cancelled';
  parts:{text:string;state:'pending'|'intent'|'sent'|'unknown';messageId:string|null;confirmation?:'platform'|'local'}[];
  error:string|null;
}

export interface PublicationSelection {
  id:string;revision:number;scope:BookScope;entryIds:string[];sourceIds:string[];
  /** Explicitly reviewed strings; no implicit desktop intro/userName selection. */
  name:string;intro:string;presetId:string|null;
}
