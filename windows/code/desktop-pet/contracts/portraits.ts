/** W02 static portraits. A set only references SkinStore ids; it never stores image bytes. */
export interface PortraitVariant {
  id: string;
  name: string;
  skinId: string;
  assetFingerprint: string;
  origin: 'user_import' | 'web_generated' | 'user_supplied';
  generationId?: string;
}
export interface PortraitSet {
  schemaVersion: 'allmind-portraits/v1';
  characterId: string;
  revision: number;
  variants: PortraitVariant[];
  selectedVariantId: string | null;
  /** Skin to restore when the last portrait of this character is removed. */
  fallbackSkinId: string | null;
  framing: 'full' | 'bust';
  stateBindings?: Partial<Record<'neutral' | 'happy' | 'sad' | 'angry', string>>;
}
export interface OutfitReference { resourceId: string; sha256: string; resourceRevision: number }
export interface OutfitRequest {
  /** Explicit per-job choice; omission follows the configured webpage privacy mode. */
  conversationMode?:'temporary'|'regular';
  operationId: string;
  expectedAppearanceRevision: number;
  references: OutfitReference[];
  instruction: string;
}
export type OutfitPhase = 'preparing' | 'submitted' | 'receiving' | 'ready' | 'failed' | 'submission_unknown' | 'cancelled' | 'applied';
export interface OutfitImageNote { resourceId: string; sha256: string; mime: string; width: number; height: number; minAlpha: number; maxAlpha: number; warning: string | null }
export interface OutfitJob {
  conversationMode?:'temporary'|'regular';
  id: string;
  operationId: string;
  scope: { characterId: string; pairingId: string; sessionId: string };
  revision: number;
  phase: OutfitPhase;
  inputFingerprint: string;
  sourceFingerprint: string;
  expectedAppearanceRevision: number;
  references: OutfitReference[];
  instruction: string;
  requestId: string | null;
  conversationId: string | null;
  messageId: string | null;
  outputResourceIds: string[];
  images: OutfitImageNote[];
  error: string | null;
  selectedResourceId: string | null;
  appliedVariantId: string | null;
  applyFingerprint?:string;
  submitted: 'no' | 'yes' | 'unknown';
}
