// FIX61-04 / RWR-10-02: pointer button routing and local stroke planning for the desktop character.
//
// Why this is a separate module: the old handler was one line inside main.mjs
// (`onpointerup = () => { if (pointer && !pointer.moved) panel(!panelOpen); pointer = null; }`), which made
// every button open the chat drawer and made "stroke vs drag vs panel" untestable. Keeping the routing
// decision pure lets the real renderer call it while the tests drive the same production object.
//
// RWR-10-02 removed the right-click function panel and its `PANEL_ENTRIES` catalog along with it. The
// drawer's 「⋯」 menu (`desktop/main.mjs: drawerMenuEntries`) is now the single low-frequency entry point.

/** Movement below this many device-independent pixels is a tap, not a drag. */
export const TAP_SLOP_PX = 8;

export interface PointerSample {
  readonly button?: number;
  readonly pointerId?: number;
  readonly screenX?: number;
  readonly screenY?: number;
  readonly timeStamp?: number;
  readonly region?: 'head' | 'body';
  readonly target?: { readonly id?: string } | null;
}
export interface PointerHandlers {
  /** Toggle the chat drawer. The router owns only the routing decision, never the drawer state. */
  readonly panel: (open: boolean) => void;
  /** Local stroke feedback. Must never reach the backend, Memory or the model. */
  readonly stroke: (at: { readonly x: number; readonly y: number; readonly side: 'left' | 'right' }) => void;
  /** Window drag through the shell channel. */
  readonly drag: (dx: number, dy: number) => void;
  readonly dragEnd?: () => void;
  readonly gesture?: (kind:'petting'|'dragging',phase:'start'|'update'|'complete'|'cancel')=>void;
  /** Read the current drawer state so the right button toggles rather than always opening. */
  readonly panelOpen?: () => boolean;
}

const onCharacter = (target: PointerSample['target']): boolean => target?.id === 'character' || target?.id === 'model';

interface ActivePointer {
  readonly id: number | undefined;
  readonly startX: number;
  readonly startY: number;
  x: number;
  y: number;
  moved: boolean;
  readonly button: number;
  readonly startedAt:number;
  readonly head:boolean;
  petting:boolean;
}

/**
 * Routes pointer events on the character. The LEFT button strokes on a short tap and drags otherwise.
 *
 * RWR-10-02: the right button no longer opens anything. The old function panel is gone from the desktop
 * UI, so `contextMenu` only CONSUMES the event: no panel, no window drag, no stroke. Consumption is still
 * required — without it Chromium would show its own system context menu over the pet.
 */
export class CharacterPointerRouter {
  #pointer: ActivePointer | null = null;
  /** Set while a right press is being consumed, so its pointerup cannot produce a stroke. */
  #rightConsumed = false;
  // A plain field instead of a constructor parameter property: Node's strip-only TS loader and the
  // browser bundle both execute this module, and parameter properties are not strippable syntax.
  readonly handlers: PointerHandlers;
  constructor(handlers: PointerHandlers) { this.handlers = handlers; }

  pointerDown(event: PointerSample): void {
    const x = event.screenX ?? 0, y = event.screenY ?? 0;
    if(this.#pointer)this.pointerCancel();
    this.#pointer = { id: event.pointerId, startX: x, startY: y, x, y, moved: false, button: event.button ?? 0,startedAt:event.timeStamp??0,head:event.region==='head',petting:false };
    this.#rightConsumed = false;
  }

  pointerMove(event: PointerSample): void {
    const pointer = this.#pointer;
    if (!pointer || event.pointerId !== pointer.id) return;
    const x = event.screenX ?? pointer.x, y = event.screenY ?? pointer.y;
    const dx = x - pointer.x, dy = y - pointer.y;
    const fromStartX = x - pointer.startX, fromStartY = y - pointer.startY;
    const beyondTapSlop = Math.hypot(fromStartX, fromStartY) > TAP_SLOP_PX;
    if(pointer.button===0&&!pointer.moved&&pointer.head&&(pointer.petting||(event.timeStamp??0)-pointer.startedAt>=250)){
      this.handlers.gesture?.('petting',pointer.petting?'update':'start');pointer.petting=true;pointer.x=x;pointer.y=y;return;
    }
    if (beyondTapSlop || pointer.moved) {
      // RWR-10-02: a right-button drag is not a window drag either — the right button is inert.
      if (pointer.button === 0) { this.handlers.gesture?.('dragging',pointer.moved?'update':'start');pointer.moved = true; this.handlers.drag(dx, dy); }
      pointer.x = x; pointer.y = y;
    }
  }

  pointerCancel(event: PointerSample = {}): void {
    if (!this.#pointer || (event.pointerId !== undefined && event.pointerId !== this.#pointer.id)) return;
    if(this.#pointer.petting)this.handlers.gesture?.('petting','cancel');
    if(this.#pointer.moved)this.handlers.gesture?.('dragging','cancel');
    this.#pointer = null;
  }

  pointerUp(event: PointerSample): void {
    const pointer = this.#pointer;
    if(pointer&&event.pointerId!==undefined&&event.pointerId!==pointer.id)return;
    this.#pointer = null;
    if (!pointer) return;
    // RWR-10-02: a right press produces nothing — no panel, no drag, no stroke.
    if (pointer.button === 2 || this.#rightConsumed) { this.#rightConsumed = false; return; }
    if (pointer.petting) {this.handlers.gesture?.('petting','complete');return;}
    if (pointer.moved) { this.handlers.dragEnd?.(); this.handlers.gesture?.('dragging','complete');return; }
    // Only the primary button strokes. Middle/back/forward buttons stay inert.
    if (pointer.button !== 0) return;
    this.handlers.stroke({ x: event.screenX ?? pointer.x, y: event.screenY ?? pointer.y, side: 'left' });
  }

  /**
   * RWR-10-02: the right button is disabled on the desktop pet.
   *
   * It consumes the event and does nothing else. Chromium delivers `contextmenu` for the right press, so
   * consuming here is what keeps the system menu away; the press is also marked so the matching
   * `pointerup` cannot fall through to the stroke path.
   */
  contextMenu(event: PointerSample): void {
    if (!onCharacter(event.target)) return;
    this.#rightConsumed = true;
    this.#pointer = null;
  }
}

export interface StrokeCapabilities {
  readonly head?: boolean;
  readonly body?: boolean;
  readonly blink?: boolean;
  readonly reducedMotion?: boolean;
}
export interface StrokePlan {
  readonly applicable: boolean;
  readonly reason: string;
  readonly values: { readonly yaw: number; readonly pitch: number; readonly roll: number; readonly body: number };
}

/**
 * A model without the interaction parameters must not throw: it reports "not applicable" with a reason
 * so the UI can say why nothing moved. Reduced motion suppresses the movement entirely.
 */
export function strokePlan(capabilities: StrokeCapabilities): StrokePlan {
  const zero = { yaw: 0, pitch: 0, roll: 0, body: 0 };
  if (capabilities.reducedMotion) return { applicable: false, reason: '已开启减少动态效果，抚摸不产生动作。', values: zero };
  if (!capabilities.head && !capabilities.body) return { applicable: false, reason: '当前模型没有登记头部或身体参数，抚摸不产生动作。', values: zero };
  return { applicable: true, reason: '', values: {
    yaw: capabilities.head ? 1 : 0, pitch: capabilities.head ? 12 : 0, roll: capabilities.head ? 2 : 0, body: capabilities.body ? 1.8 : 0,
  } };
}

/**
 * A direct user tap is independent from autonomous presentation toggles. A rig may implement the
 * response as an authored TapBody motion even when it has no procedural head/body parameters.
 */
export function directStrokePlan(capabilities: StrokeCapabilities, hasAuthoredTapMotion = false): StrokePlan {
  const plan = strokePlan(capabilities);
  if (capabilities.reducedMotion || plan.applicable || !hasAuthoredTapMotion) return plan;
  return { ...plan, applicable: true, reason: '' };
}
