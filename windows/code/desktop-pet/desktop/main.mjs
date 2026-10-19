import {WakeController} from './wake-controller.mjs';
import { COMPANION_LABEL, isCharacterId } from '../contracts/character.ts';
import { CaptureFeedback } from './capture-feedback.mjs';
import { WorkRecords } from './work-records.mjs';
import { WorkCard } from './work-card.mjs';
import { installDisplayControls } from './display-controls.mjs';
import { toDeviceFailure, deviceFailureMessage } from '../media/capture-errors.ts';
import { PressToTalk, validVoiceKey } from './press-to-talk.ts';
import { DesktopChatLog } from './chat-log.ts';
import { renderRubyText } from '../core/ruby-text.ts';
import { DesktopViewState, DesktopConnectionState, scopeEquals } from './view-state.ts';
import { CharacterPointerRouter } from './pointer-router.ts';
import { JellyfishRenderer } from './cubism-renderer.mjs';
import { SpriteRenderer } from './sprite-renderer.mjs';
import { CharacterStateMachine } from '../contracts/character-state.ts';
const characterState = new CharacterStateMachine();
// RUX-04: with no startup preload there is nothing to gate — appearance messages process in
// arrival order as soon as this module is evaluated.
let appearanceQueue = Promise.resolve();
import { BrowserPlaybackDriver } from '../media/browser-playback.ts';
import { DesktopPlaybackController } from './playback-controller.ts';
import { BrowserCaptureDriver } from '../media/browser-capture.ts';
import { DESKTOP_BRIDGE_VERSION } from '../contracts/desktop-bridge.ts';
import { PcmFrameAggregator } from '../media/voice-input-session.ts';
import { installMicrophoneTest } from './mic-test-panel.mjs';
import { LocalGreetingScheduler } from './local-greeting.ts';
import { ThinkingTimeout } from './thinking-timeout.mjs';
import { companionBubblePosition } from './companion-layout.mjs';
import { arbitrateCompanionPresentation, validateCompanionLife } from '../core/companion-behavior.ts';
import { startPetAction, advancePetAction } from '../core/local-pet-action.ts';
import {resolveLocalPetSlot} from '../contracts/local-pet.ts';
import {replyLengthNotice} from '../core/reply-length.ts';
import {replyStyleSummary} from '../core/reply-style.ts';
import { createInvitationAutoDismiss } from './invitation-auto-dismiss.mjs';
const $ = id => document.getElementById(id);
const native = (name, value) => window.desktopHost ? window.desktopHost.postMessage(name, value) : window.webkit?.messageHandlers[name]?.postMessage(value);
const report = value => native('diagnostic', value);
const connection = new DesktopConnectionState();
const send = (value, generation = connection.generation) => {
  if (connection.current(generation) && connection.connected) native('desktop', { generation, message: value });
};
const view = new DesktopViewState();
let companionLife = null, companionHidden = false, companionPointerActive = false, companionPresentation = null;
let companionRelationship = null, companionFocus = false, companionFocusTimer = null;
let companionCapabilityNotes = [], companionLastStep = 0;
let companionSequence = -1;
let companionDelivery=null;
let localPetAction=null,localPetChase=false,localPetSequence=0,localPetEnvironment=null,localPetMotionMode=null,localPetSuspended=false,localPetActivity=null;
let localPetSpatial=false;
const localPetTransitions=[];
function traceLocalPet(action,phase){localPetTransitions.push({id:action.id,kind:action.kind,phase,at:Date.now(),presentation:action.presentation});if(localPetTransitions.length>32)localPetTransitions.shift();}
function localPetAvailable(kind){return !!companionManifest&&resolveLocalPetSlot(companionManifest.localInteractions??null,companionManifest,kind).availability==='available';}
function favoriteLocalPet(){const kinds=['petting','feeding','gifting','playing'];return kinds.filter(localPetAvailable).map(kind=>({kind,count:(companionLife?.localHistory??[]).filter(row=>row.kind===kind).length})).filter(row=>row.count>0).sort((a,b)=>b.count-a.count)[0];}
function beginLocalPet(kind,presentation='missing'){
  if(!memoryBookMode||!connection.connected||!appearanceReady||companionHidden||document.hidden||companionFocus||companionLife?.quiet||!companionLife?.enabled||['listening','thinking','speaking'].includes(view.state))return;
  const slot=resolveLocalPetSlot(companionManifest?.localInteractions??null,companionManifest,kind);
  if(slot.availability!=='available')return;
  const next=startPetAction(localPetAction,kind,`local.${Date.now()}.${++localPetSequence}`,Date.now(),presentation),fresh=next.id!==localPetAction?.id;
  Object.assign(next,{skinId:companionManifest.skinId,assetFingerprint:companionManifest.assetFingerprint,appearanceRequestId:companionAppearanceRequestId});
  if(fresh&&slot.target)next.presentation='loading';
  if(fresh){if(localPetAction){traceLocalPet(localPetAction,'cancel');if(companionAnimation?.id===localPetAction.id)stopCompanionAnimation(localPetAction.id);}traceLocalPet(next,'enter');}localPetAction=next;
  if(fresh&&slot.target){
    next.presentation='loading';
    void playCompanionInteraction({action:'play',kind,characterId:view.characterId,pairingId:'local-user',generation:connection.generation,id:next.id,target:slot.target,skinId:companionManifest.skinId,assetFingerprint:companionManifest.assetFingerprint,revision:companionLife?.revision??0,until:next.until},true).then(()=>{if(localPetAction?.id===next.id)localPetAction.presentation='played';}).catch(error=>{
      if(localPetAction?.id!==next.id)return;localPetAction.presentation='failed';report({type:'local-pet-resource-failed',kind,message:String(error)});showToast('角色交互资源加载失败：'+String(error));finishLocalPet(true);
    });
  }
}
function finishLocalPet(cancelled=false){
  if(!localPetAction)return;
  const result=advancePetAction(localPetAction,Math.max(Date.now(),localPetAction.until),cancelled);const id=localPetAction.id;localPetAction=null;if(companionAnimation?.id===id)stopCompanionAnimation(id);
  if(result.completed)traceLocalPet(result.completed,'complete');if(result.cancelled)traceLocalPet(result.cancelled,'cancel');
  if(result.completed&&['petting','dragging','feeding','gifting','playing','chasing','jumping'].includes(result.completed.kind))send({channel:'local_pet_complete',characterId:view.characterId,pairingId:'local-user',id:result.completed.id,kind:result.completed.kind,presentation:result.completed.presentation,skinId:result.completed.skinId,assetFingerprint:result.completed.assetFingerprint,appearanceRequestId:result.completed.appearanceRequestId});
}
let companionManifest=null,companionAnimation=null,companionAppearanceRequestId=null;
function stopCompanionAnimation(id){
  if(id&&companionAnimation?.id!==id)return;
  const previous=companionAnimation;companionAnimation=null;renderer?.stopInteraction?.();if(previous?.timer)clearTimeout(previous.timer);
  if(previous?.reject)previous.reject(Error('互动已停止、过期或被对话取代。'));
}
function interactionPlayable(manual=false){return memoryBookMode&&connection.connected&&appearanceReady&&!companionHidden&&!document.hidden&&(!companionPointerActive||manual)&&!awaitingTextTurn&&!['listening','thinking','speaking'].includes(view.state);}
async function playCompanionInteraction(value,manual=false){
  if(!value||value.characterId!==view.characterId||value.pairingId!=='local-user'||!connection.current(value.generation))throw Error('互动不属于当前角色或连接。');
  if(value.action==='stop'){stopCompanionAnimation(value.id);return {stopped:true};}
  if(value.action!=='play'||!interactionPlayable(manual)||typeof value.id!=='string'||!value.id||value.id.length>128||value.skinId!==companionManifest?.skinId||value.assetFingerprint!==companionManifest?.assetFingerprint||!Number.isSafeInteger(value.until)||value.until<=Date.now()||value.until>Date.now()+5000)throw Error('当前桌面、资源或互动窗口不可用。');
  const target=value.target;
  const petKind=({touch:'petting',feed:'feeding',gift:'gifting'})[value.kind]??value.kind;
  const declaration=resolveLocalPetSlot(companionManifest.localInteractions??null,companionManifest,petKind).target;
  if(!declaration||declaration.kind!==target?.kind||declaration.targetId!==target?.targetId)throw Error('角色未声明此互动或对应动作已变化。');
  const allowed=target?.kind==='sprite'?companionManifest.type==='sprite'&&['idle','working','happy','sleeping'].includes(target.targetId)&&!!companionManifest.sprite?.clips?.[target.targetId]
    :target?.kind==='preset'&&companionManifest.type!=='sprite'&&companionManifest.catalog.items.some(item=>item.id===target.targetId&&item.previewable&&item.availability!=='unavailable'&&['model-expression','model-motion'].includes(item.source)&&item.category!=='appearance');
  if(!allowed||typeof renderer?.startInteraction!=='function')throw Error('当前资源没有所选互动动作。');
  stopCompanionAnimation();const active={id:value.id,target,until:value.until,revision:value.revision,ready:false,manual};companionAnimation=active;
  try{
    const started=await renderer.startInteraction(target.targetId);
    if(!started||companionAnimation!==active||!interactionPlayable(manual)||Date.now()>=active.until)throw Error('互动加载已取消或过期。');
    active.ready=true;
    const snapshot=await new Promise((resolve,reject)=>{active.resolve=resolve;active.reject=reject;active.timer=setTimeout(()=>{if(companionAnimation===active)stopCompanionAnimation(active.id)},Math.max(1,active.until-Date.now()))});
    return {played:true,id:active.id,skinId:value.skinId,assetFingerprint:value.assetFingerprint,snapshot};
  }catch(error){if(companionAnimation===active)stopCompanionAnimation(active.id);throw error;}
}
let bookTakeoverReady=false;
let bookGreetingInheritance=null;
const companionSeen=new Set();
function companionAction(action, enabled) {
  send({ channel: 'companion_action', characterId: view.characterId, pairingId: 'local-user', action, ...(enabled === undefined ? {} : { enabled }) });
}
const invitationAutoDismiss = createInvitationAutoDismiss({
  onFadeStart:id=>{if(view.invitation?.id===id)$('invitation-card').classList.add('is-dismissing');},
  onTimeout:id=>{
    if(view.invitation?.id!==id)return;
    $('invitation-card').classList.remove('is-dismissing');
    view.invitation=null;renderUI();
    command({type:'ignore_invitation',invitationId:id});
  },
});
const cancelInvitationAutoDismiss = id => {
  invitationAutoDismiss.cancel(id);
  $('invitation-card')?.classList.remove('is-dismissing');
};
const workSpeechView=new DesktopViewState();
let workNotice=null,workSpeechBlocked=false,backendSessionId=null;
const spokenNotices=new Set();
const chat = new DesktopChatLog();
const captureFeedback=new CaptureFeedback($);let captureFeedbackToken;
let wakeFeedbackToken,wakeRequestId=null,wakeUI={phase:'off',enabled:false};
const wakeLabels={connecting:'连接中',waiting:'等待唤醒',listening:'正在听',submitting:'正在提交',replying:'等待唤醒'};
const wake=new WakeController({
 createCapture:async options=>{const module=await import('../media/wake/browser-capture.ts');return new module.BrowserWakeCapture({...options,workletModuleUrl:new URL('./wake-recorder-worklet.js',import.meta.url)});},send,
 onState:state=>{wakeUI=state;const label=wakeLabels[state.phase];if(state.enabled&&label){const mode={label,phase:state.phase,keepLabel:true};if(wakeFeedbackToken===undefined||!captureFeedback.active)wakeFeedbackToken=captureFeedback.start(mode);else captureFeedback.configure(wakeFeedbackToken,mode);}else{if(wakeFeedbackToken!==undefined)captureFeedback.stop(wakeFeedbackToken);wakeFeedbackToken=undefined;}Promise.resolve().then(()=>renderUI());},
 onLevel:level=>{if(wakeFeedbackToken!==undefined)captureFeedback.level(wakeFeedbackToken,level);},
 onWake:wakeHit=>command({type:'start_voice',wakeHit},{wakeInput:true}),
 onFinish:()=>command({type:'finish_voice'},{wakeInput:true}),
 onCancel:()=>{if(wakeRequestId){wakeRequestId=null;command({type:'cancel'},{wakeInput:true});}}
});
const records=new WorkRecords({get:$,action:a=>work.action(a),onClose:()=>markVisibleWork(),onSelect:id=>work.focusRecord(id)});
const work = new WorkCard({get:$,send,open:()=>panel(true),onState:s=>records.receive(s),onRecords:origin=>records.show(origin),onToggle:()=>{markVisibleWork();restoreSelectedSource();requestedSourceFocus=true;lastUI='';renderUI();}});
let companionRoute = null;
let inputScope = null, awaitingTranscript = false;
let lastInputRow = null, lastWorkOpen = false, preserveReading = false, requestedSourceFocus=false,lastSourceId=null;
const expandedInputs=new Set();
let textRequestId = null;
// B03: the per-turn reply style only affects the next submit; success resets it to inherit, a
// failure keeps it for retry, and another character never inherits it.
let turnReplyStyle = 'inherit', turnReplyStyleCharacter = null;
let stylePreviewRequest=null,stylePreviewTimer=null;
const textRetries=new Map();
const textRetryKey=()=>JSON.stringify([view.characterId,backendSessionId,desktopIncognito]);
function restoreTextRetry(){
  const request=memoryBookMode?textRetries.get(textRetryKey()):null;
  if(request&&!chat.draft(view.characterId))chat.setDraft(view.characterId,request.text);
  $('text').value=chat.draft(view.characterId);previewReplyStyle();
}
function previewReplyStyle(){
  clearTimeout(stylePreviewTimer);stylePreviewRequest=null;
  const target=$('reply-style-preview');if(target)target.textContent='';
  if(!memoryBookMode||!connection.connected||!backendSessionId||!$('text').value.trim())return;
  stylePreviewTimer=setTimeout(()=>{
    stylePreviewRequest=crypto.randomUUID();
    send({channel:'book_reply_style',requestId:stylePreviewRequest,characterId:view.characterId,sessionId:backendSessionId,text:$('text').value,replyStyle:turnReplyStyle});
  },150);
}
let thinkingRequestId=null,thinkingTimer=null,thinkingData=null;
function requestThinking(level){
  if(textRequestId||thinkingRequestId||!connection.connected)return;
  thinkingRequestId=crypto.randomUUID();
  const message={channel:'book_thinking',requestId:thinkingRequestId,characterId:view.characterId,sessionId:backendSessionId};
  if(level!==undefined){message.level=level;message.expectedRevision=thinkingData?.revision;message.operationId=crypto.randomUUID();}
  send(message);renderUI();renderThinkingPanel('正在读取或确认网页选项…');
  thinkingTimer=setTimeout(()=>{thinkingRequestId=null;thinkingTimer=null;renderUI();renderThinkingPanel('网页设置状态未确认，请刷新；不会代你重发消息。');},45000);
}
function renderThinkingPanel(status=''){
  const panel=$('thinking-panel');if(!panel)return;
  panel.replaceChildren();const title=document.createElement('strong');title.textContent='ChatGPT 思考强度';panel.append(title);
  const note=document.createElement('p');note.textContent=status||'读取当前账号可用选项；额度由 ChatGPT 账号决定。';panel.append(note);
  for(const option of thinkingData?.options??[]){const button=document.createElement('button');button.type='button';button.textContent=option.label.replace(/[,，].*$/,'');button.setAttribute('aria-pressed',String(option.level===thinkingData.level));button.disabled=!!thinkingRequestId||!!textRequestId;button.onclick=()=>requestThinking(option.level);panel.append(button);}
  const refresh=document.createElement('button');refresh.type='button';refresh.textContent='刷新选项';refresh.disabled=!!thinkingRequestId||!!textRequestId;refresh.onclick=()=>requestThinking();panel.append(refresh);
  const close=document.createElement('button');close.type='button';close.textContent='关闭';close.onclick=()=>{panel.remove();publishInteractiveRegions();};panel.append(close);publishInteractiveRegions();
}
function openThinkingPanel(){
  if(textRequestId||thinkingRequestId){showToast('生成或设置操作中，请等待完成。');return;}
  $('thinking-panel')?.remove();thinkingData=null;
  const panel=document.createElement('section');panel.id='thinking-panel';panel.setAttribute('aria-label','ChatGPT 思考强度');$('drawer').append(panel);requestThinking();
}
function resetThinking(){clearTimeout(thinkingTimer);thinkingTimer=null;thinkingRequestId=null;thinkingData=null;$('thinking-panel')?.remove();}
let bookBackendInstanceId = null;
// Request-scoped read-only recovery. A missing display event never causes a model resend.
setInterval(() => {
  if (memoryBookMode && connection.connected && textRequestId && backendSessionId)
    send({channel:'book_turn_status',clientRequestId:textRequestId,characterId:view.characterId,sessionId:backendSessionId});
}, 1000);
let inputFocusEpoch=0, interactionFocusEpoch=0, routeFocusEpoch=0;
let composing = false;
let presentationPolicy=null;
function applyPresentationPolicy(){
  if(!renderer?.ready)return;
  const policy=presentationPolicy??{modelId:'disconnected',revision:0,enabledIds:[]};
  const applied=renderer.setAutomaticPolicy(policy);
  if(presentationPolicy)report({type:'presentation-policy',modelId:policy.modelId,revision:policy.revision,enabledCount:policy.enabledIds.length,applied:applied===true});
}
let renderer, capturing, captureAllowed = false, voicePhase = 'idle';
const pcmFrames=new PcmFrameAggregator();
let voiceRequestId = null, invitationPending = false, voiceRequestAt = 0, inputEventTiming=null;
function timedVoiceInput(at,source,run){const previous=inputEventTiming;inputEventTiming={at,source};try{return run();}finally{inputEventTiming=previous;}}
let introduction = null, introductionEpoch = 0, introductionFramePending = false;
let panelOpen = false, panelEpoch = 0, panelAnimation, panelCloseTimer;
let lastUI = '';
// RWR-08 (E1/F02): the running role's display name arrives on backend_ready; it titles the chat card,
// labels assistant rows and fills the input placeholder. It is presentation only.
let runningRoleLabel = '';
// RUX-04 (user direction, 2026-10-10): while the model loads NOTHING is displayed — no cover text
// pressed over the character, and no default model is preloaded. The canvas stays empty until the
// backend delivers the appearance of the character it actually selected; only that renderer's
// first successful frame becomes visible. Failures never press text onto the window either: they
// surface through the drawer status line and a toast, and chat keeps working without a model.
let appearanceReady = false, previewAppearanceless = false, appearanceFailure = null, appearanceWatchdog = null;
let memoryBookMode = false, desktopIncognito=false, privacyPending=false;
let startupAppearanceRestored = false;
function clearAppearanceWatchdog() { clearTimeout(appearanceWatchdog); appearanceWatchdog = null; }
function noteAppearanceFailure(reason) {
  appearanceFailure = reason;
  report({ type: 'appearance-failed', reason });
  showToast('角色形象没有加载出来；对话不受影响，仍可以继续。');
  renderUI();
}
/**
 * RUX-04 (user follow-up, 2026-10-10): during load the pet shows the LAST SHOWN character. The host
 * republishes the previous session's acknowledged appearance under the stable `skin-assets/last/`
 * prefix and delivers it here before the backend is up, so the pet is visible from the first
 * frames instead of an empty window. This is NOT a default model — it is exactly what was on
 * screen last time; the backend's authoritative appearance still swaps in when it arrives, and a
 * remembered model that fails to load now simply leaves the canvas empty (still no text pressed
 * over the model).
 */
function restoreCachedAppearance(value) {
  const manifest = value?.manifest, assetBase = value?.assetBase;
  if (!manifest || (manifest.type !== 'sprite' && manifest.type !== 'live2d') || typeof assetBase !== 'string' || !assetBase.startsWith('pet://app/skin-assets/last/')) return;
  const original = $('model'), canvas = original.cloneNode(false);
  canvas.id = 'appearance-candidate'; canvas.style.visibility = 'hidden'; canvas.style.position = 'absolute'; canvas.style.inset = '0'; original.parentNode.append(canvas);
  const candidate = manifest.type === 'sprite' ? new SpriteRenderer(canvas, report, { assetBase }) : new JellyfishRenderer(canvas, report, { assetBase });
  candidate.bindSkin(manifest);
  candidate.load().then(() => {
    if (renderer) { candidate.dispose(); canvas.remove(); return; } // a real appearance already won
    canvas.id = 'model'; canvas.style.visibility = original.style.visibility; original.replaceWith(canvas); renderer = candidate;
    candidate.setFraming(display.mode); applyPresentationPolicy();
    startupAppearanceRestored = true;
    report({ type: 'startup-appearance-restored', basis: 'host-remembered-appearance' });
  }, error => {
    candidate.dispose(); canvas.remove();
    report({ type: 'startup-appearance-restore-failed', reason: error.message });
  });
}
function applyRunningRoleIdentity() {
  const name = memoryBookMode&&view.characterId==='aika'&&/^(Aika|AIKI)$/i.test(runningRoleLabel)?'ALLMIND':runningRoleLabel || 'ALLMIND';
  const titleNode = $('drawer-role-name');
  if (titleNode) titleNode.textContent = name;
  const input = $('text');
  if (input) input.placeholder = `和${name}说话…`;
  const statusLine = $('drawer-status-line');
  if (statusLine) {
    statusLine.textContent = !connection.connected ? (connection.state === 'connecting' ? '连接中…' : '连接已断开')
      : view.error ? '出了点问题'
      : ['listening', 'thinking', 'speaking'].includes(view.state) ? '正在回应你…'
      : appearanceFailure ? '角色形象未加载，对话仍可用'
      : previewAppearanceless ? '离线预览：未加载角色形象'
      : companionFocus ? '专注陪伴 · 自主活动与主动打扰已暂停'
      : companionLife?.quiet ? '免打扰 · 安静陪伴'
      : companionLife?.activity==='walking' ? '陪在你身边 · 散步'
      : companionLife?.activity==='resting' ? '陪在你身边 · 休息'
      : '陪在你身边';
  }
}
let awaitingTextTurn = false;
let invitationTextPending = false, lastPresenceKey = '';
// RWR-10-02: the in-dialog hotkey binding UI is gone, so the renderer no longer has a "waiting for a key"
// state. `bindingKey` is removed rather than left as a dead flag; the console owns the binding now.
let bindingKey = false;
// RWR-10-02: `managementOpening` guards against double-clicking the console entry. It is armed by
// `requestManagement` and cleared by `managementResult`. The window-blur path also clears it, because
// opening the console hands focus to the browser: without that, a reply that is lost while the pet window
// is hidden would wedge every later console entry forever.
let managementOpening = false, managementSource = 'top', managementOpeningTimer = null;

// RP75-07: Floating speech bubble & 40s thinking state machine
const THINKING_TIMEOUT_MS = 40000;
let bubbleTimer = null;
let currentBubbleState = 'idle';
const thinkingTimeout = new ThinkingTimeout({ timeoutMs: THINKING_TIMEOUT_MS });
const localGreeting = new LocalGreetingScheduler({ idleAfterMs: 45 * 60 * 1000, cooldownMs: 6 * 60 * 60 * 1000 });
let localGreetingEnabled = true;

/**
 * RUX-06 (round-2 direction, 2026-10-10): the bubble lives at the character's FEET — the exact slot
 * the removed chat entry used to occupy — so it can never cover the face.
 * Placement is horizontally centred on the measured model/pet area, vertically sitting
 * on the pet area's bottom edge; the tail points UP at the model. Everything is measured from live
 * rects, so model size, full/half mode and DPI are already accounted for.
 */
function positionBubble() {
  const bubble = $('speech-bubble');
  if (!bubble || bubble.hidden) return;
  const hostWidth = document.documentElement.clientWidth;
  const hostHeight = document.documentElement.clientHeight;
  bubble.style.left = '-9999px';
  bubble.style.top = '-9999px';
  const bubbleRect = bubble.getBoundingClientRect();
  if (!bubbleRect.width) return;
  if (memoryBookMode) {
    const petRect = $('pet').getBoundingClientRect();
    const placed = companionBubblePosition({ width: hostWidth, height: hostHeight }, $('character').getBoundingClientRect(), bubbleRect);
    bubble.style.left = `${Math.round(placed.left - petRect.left)}px`;
    bubble.style.top = `${Math.round(placed.top - petRect.top)}px`;
    bubble.style.right = 'auto'; bubble.dataset.side = placed.side;
    bubble.style.setProperty('--tail-x', `${Math.round(bubbleRect.width / 2)}px`);
    return;
  }
  const petRect = $('pet').getBoundingClientRect();
  const slotLeft = petRect.left, slotWidth = petRect.width, feetBottom = petRect.bottom;
  const margin = 6;
  let left = slotLeft + slotWidth / 2 - bubbleRect.width / 2;
  let top = Math.min(feetBottom, hostHeight - margin) - bubbleRect.height;
  left = Math.max(margin, Math.min(left, hostWidth - bubbleRect.width - margin));
  top = Math.max(margin, Math.min(top, hostHeight - bubbleRect.height - margin));
  // The bubble's absolute containing block is #pet (it is position:absolute), so the stylesheet
  // values are #pet-relative while the clamp above runs in viewport coordinates — convert, or the
  // bubble flies off-window whenever the drawer pushes #pet away from the window origin.
  const offsetX = petRect.left, offsetY = petRect.top;
  bubble.style.left = `${Math.round(left - offsetX)}px`;
  bubble.style.top = `${Math.round(top - offsetY)}px`;
  bubble.style.right = 'auto';
  bubble.dataset.side = 'below';
  // Final correction in the VIEWPORT system — the ground truth for "never clipped by an edge": any
  // remaining offset from the containing block, a running entrance animation or a fractional layout
  // is absorbed here, so the painted rect is measured (not derived) to be inside the window.
  const painted = bubble.getBoundingClientRect();
  if (painted.width && painted.height) {
    const overRight = painted.left + painted.width - (hostWidth - margin);
    const overBottom = painted.bottom - (hostHeight - margin);
    const overLeft = margin - painted.left;
    const overTop = margin - painted.top;
    if (overRight > 0) bubble.style.left = `${parseFloat(bubble.style.left) - overRight}px`;
    else if (overLeft > 0) bubble.style.left = `${parseFloat(bubble.style.left) + overLeft}px`;
    if (overBottom > 0) bubble.style.top = `${parseFloat(bubble.style.top) - overBottom}px`;
    else if (overTop > 0) bubble.style.top = `${parseFloat(bubble.style.top) + overTop}px`;
  }
  // The tail points up at the character standing right above the slot (bubble-local coordinate).
  const anchorX = slotLeft + slotWidth / 2;
  const tailX = Math.max(10, Math.min(anchorX - left, bubbleRect.width - 10));
  bubble.style.setProperty('--tail-x', `${Math.round(tailX)}px`);
}

function showBubble(text, state = 'speaking', customDwellMs = null) {
  const bubble = $('speech-bubble');
  const bubbleText = $('speech-bubble-text');
  if (!bubble || !bubbleText) return;

  clearTimeout(bubbleTimer);
  bubbleTimer = null;
  currentBubbleState = state;
  bubble.dataset.state = state;
  renderRubyText(bubbleText, text);
  if (memoryBookMode && panelOpen) { dismissBubble(); return; }
  bubble.hidden = false;
  // RUX-06: measure and place AFTER the content is set; two frames so layout has settled and the
  // measured size is the painted size, not a transition intermediate. A background-throttled window
  // can freeze rAF entirely, so a timer fallback places the bubble even then (placement is idempotent).
  bubble.style.left = '-9999px';
  $('pet')?.classList.add('bubble-active');
  let placed = false;
  const place = () => { if (placed) return; placed = true; positionBubble(); };
  requestAnimationFrame(() => requestAnimationFrame(place));
  setTimeout(place, 120);

  if (state === 'greeting' || state === 'speaking' && !memoryBookMode) {
    const dwellMs = customDwellMs ?? Math.max(6000, Math.min(10000, text.length * 150 + 4500));
    bubbleTimer = setTimeout(() => {
      dismissBubble();
    }, dwellMs);
  } else if (state === 'error') {
    bubbleTimer = setTimeout(() => {
      dismissBubble();
    }, customDwellMs ?? 6000);
  }
}

function dismissBubble() {
  const bubble = $('speech-bubble');
  if (!bubble) return;
  clearTimeout(bubbleTimer);
  bubbleTimer = null;
  bubble.hidden = true;
  currentBubbleState = 'idle';
  $('pet')?.classList.remove('bubble-active');
}

function startThinking() {
  const requestId = textRequestId;
  const scope = view.scope;
  showBubble('想一想… ✦', 'thinking');
  thinkingTimeout.start(
    () => currentBubbleState === 'thinking'
      && (requestId ? textRequestId === requestId : scopeEquals(scope, view.scope)),
    () => {
    // The timeout is a real turn cancellation. The request id/scope check above prevents an old
    // timer from cancelling a newer turn, and command(cancel) makes late provider output stale.
    command({ type: 'cancel' });
    view.error = '模型思考超时';
    showBubble('哎呀，想太久有点走神啦，请再问我一次吧～', 'error', 6000);
    renderUI();
    },
  );
}

function stopThinking() {
  thinkingTimeout.stop();
}
function requestManagement(path, source = 'top') {
  // RWR-10-02: the guard exists to stop ONE click from opening the console twice. It is only needed for
  // the legacy header button, which stays visibly disabled while opening. A 「⋯」 menu entry removes
  // itself the moment it is clicked, so there is nothing left to double-click and holding the guard would
  // make the menu depend on the host's reply — a second entry clicked while that reply is in flight would
  // be silently ignored.
  if (source !== 'menu' && managementOpening) return;
  managementOpening = true;
  managementSource = source;
  // A bounded watchdog: if the host's reply never arrives, release the guard instead of wedging the menu.
  clearTimeout(managementOpeningTimer);
  managementOpeningTimer = setTimeout(() => { managementOpening = false; }, 20_000);
  managementOpeningTimer.unref?.();
  if (source === 'top') {
    // RWR-08 (E1): the header 「控制台」button moved into the ⋯ menu; null-guard both surfaces.
    const topButton = $('management');
    if (topButton) { topButton.disabled = true; topButton.textContent = '打开中…'; }
    $('management-notice').hidden = true;
  }
  // RWR-10-02: the old `#function-notice` status line is gone with the panel. Opening from the ⋯ menu
  // needs no second status surface: the entry itself is removed while the request is in flight.
  native('shell', { type:'open_management', ...(path ? { path } : {}) });
}
function managementResult(result) {
  if (!managementOpening || typeof result?.ok !== 'boolean') return;
  const source = managementSource;
  managementOpening = false;
  clearTimeout(managementOpeningTimer);
  if (source === 'top') {
    const topButton = $('management');
    if (topButton) { topButton.disabled = false; topButton.textContent = '控制台'; }
    $('management-notice').hidden = result.ok;
    $('management-notice').textContent = result.ok ? '' : '暂时无法打开控制台，请确认桌宠服务已启动后重试。';
    if (!result.ok) showToast('控制台暂不可用，请启动真实桌宠服务后重试。');
  } else if (result.ok) {
    closeDrawerMenu();
  } else {
    const message = '当前为离线预览，控制台暂不可用；请启动真实桌宠服务后重试。';
    showToast(message);
  }
}
{
  // RWR-08 (E1): the legacy top-right console button may be absent (the ⋯ menu owns the entry now).
  const legacyTopButton = $('management');
  if (legacyTopButton) legacyTopButton.onclick = () => requestManagement('', 'top');
}
const display = installDisplayControls({ get: $, shell: value => native('shell', value), setFraming: mode => renderer?.setFraming(mode) });
// RWR-10-02: the header keeps only role + status + ⋯ + close. The ⋯ menu implementation
// (toggleDrawerMenu / renderDrawerMenu / drawerMenuEntries) is defined further down with the other menu
// actions, so there is exactly one menu and one set of handlers. The previous inline block here had its
// own 3-entry menu whose "调整大小" only showed a toast and whose body-mode entry passed a partial object
// that `display.receive()` always rejected.
// The size panel toggles from the menu; `toggleSizePanel` is defined with the display actions.
function toggleSizePanel() { const open=display.togglePanel();$('drawer-appearance')?.setAttribute('aria-expanded',String(open));publishInteractiveRegions(); }
function setDisplayMode(mode) { display.setMode(mode); if (!$('speech-bubble')?.hidden) requestAnimationFrame(() => requestAnimationFrame(positionBubble)); }
const hold = new PressToTalk({
  start() {
    // A fresh physical hold supersedes pending generation, output or capture cleanup.
    if (!connection.connected) return false;
    command({ type: 'start_voice' }); return true;
  },
  finish() { command({ type: 'finish_voice' }); },
  cancel(early) {
    command({ type: 'cancel' });
    view.error = early ? '录音尚未开始，已取消，未发送。请按住直到提示正在听。' : '按键录音已取消，未发送。'; renderUI();
  }
});
function hotkeyConfig(value) {
  const code = value && typeof value === 'object' ? value.code ?? null : value;
  if (!hold.configure(code)) return;
}
function hotkeyEvent(event) {
  if (memoryBookMode) return;
  const receivedAt=performance.now();
  if (event.type === 'cancel') { hold.cancel(); return; }
  if (bindingKey || composing) return;
  if (event.type === 'down') timedVoiceInput(receivedAt,'native-hotkey',()=>hold.down(event.code,event.repeat));
  else if (event.type === 'up') hold.up(event.code);
}
// RWR-10-02: the in-dialog hotkey strip (`#hotkey-settings`) is gone. Setting/changing/clearing the key
// and its conflict/effective status now live in the console's global "快捷键与语音" section, which writes
// through the host preferences API added in RWR-10-01. The renderer only APPLIES the stored key it
// receives on `hotkeyConfig`; it no longer owns the binding UI.

const reconnect = document.createElement('button'); reconnect.id = 'reconnect'; reconnect.type = 'button'; reconnect.textContent = '重新连接'; reconnect.hidden = true;
$('status').after(reconnect);
reconnect.onclick = () => { if (connection.canRetry && !connection.active) { reconnect.disabled = true; native('shell', { type: 'reconnect' }); } };
// FIX61-03: startup stays cancelable and its phase is visible while the backend is launching.
const startupCancel = document.createElement('button'); startupCancel.id = 'startup-cancel'; startupCancel.type = 'button'; startupCancel.textContent = '取消启动'; startupCancel.hidden = true;
reconnect.after(startupCancel);
startupCancel.onclick = () => { if (connection.state === 'connecting') { startupCancel.disabled = true; native('shell', { type: 'cancel_startup' }); } };
// Startup events are sparse: elapsedMs is the last event's age, not a live clock.
// Do not present a frozen duration or plugin count as current progress.
const connectionText = () => {
  if (connection.state === 'connecting') return '正在连接…';
  if (connection.state === 'disconnected') return '对话服务已断开';
  // Startup failures name their reason so a visible wait is distinguishable from a broken install.
  const startupReason = { ready_timeout: '对话服务启动超时', stalled: '对话服务启动停滞，无进展', launch: '对话服务无法启动', exit: '对话服务启动后退出' }[connection.reason];
  if (connection.state === 'failed') return startupReason ?? '对话服务连接失败';
  return undefined;
};
const features = { type: 'features', secureContext: isSecureContext, mediaDevices: !!navigator.mediaDevices?.getUserMedia, audioWorklet: typeof AudioWorkletNode !== 'undefined', userAgent: navigator.userAgent, origin: location.origin };
report(features);
function renderUI() {
  wake.observe({busy:!!capturing||voicePhase!=='idle'||awaitingTextTurn||awaitingTranscript||['listening','thinking','speaking'].includes(view.state)||workSpeechView.state==='speaking',playing:playback.busy});
  sendPresence();
  const uiKey = JSON.stringify([privacyPending,desktopIncognito,!!thinkingRequestId,companionLife?.activity, companionLife?.enabled, companionLife?.quiet, Math.round(companionLife?.mood ?? 50), wakeUI.phase,wakeUI.detail,awaitingTextTurn, awaitingTranscript, work.expanded,work.state?.sourceInput?.draftId,workSpeechView.state, voicePhase, chat.revision, view.reply, view.error, view.state, view.characterId, view.invitation?.id, view.invitation?.text, connection.state, connection.reason, connection.canRetry, connection.phase, connection.sequence, connection.completed, connection.total, connection.elapsedMs, introduction?.id, introduction?.text]);
  if (uiKey === lastUI) return;
  lastUI = uiKey;
  const rows = chat.rows(view.characterId).map(row => {
    const item = document.createElement('div'); item.className = `chat-row ${row.kind}`;item.dataset.rowId=String(row.id);
    const label = document.createElement('span'); label.className = 'chat-label';
    label.textContent = row.kind === 'user' ? `${row.sourceLabel??'你'}${row.status === 'sending' ? ' · 发送中' : row.status === 'failed' ? ' · 未送达' : ''}` : (runningRoleLabel || COMPANION_LABEL);
    const text = document.createElement('div'); if (row.kind === 'assistant') renderRubyText(text, row.text); else text.textContent = row.text;
    item.append(label, text);
    if(row.kind==='assistant'&&Number.isSafeInteger(row.attachmentCount)&&row.attachmentCount>0&&row.scope){const files=document.createElement('button');files.type='button';files.textContent=`本轮 ${row.attachmentCount} 个文件 · 打开完整聊天`;files.onclick=()=>openConsole('/chat?'+new URLSearchParams({characterId:row.scope.characterId,sessionId:row.scope.sessionId,messageId:row.scope.turnId}));item.append(files);}
    if(row.kind==='user'&&row.text.length>140){const expanded=expandedInputs.has(row.id);text.className=expanded?'input-original':'input-original input-original-preview';const more=document.createElement('button');more.type='button';more.className='input-full-toggle';more.textContent=expanded?'收起全文':'查看输入全文';more.setAttribute('aria-expanded',String(expanded));more.onclick=()=>{if(expanded)expandedInputs.delete(row.id);else expandedInputs.add(row.id);preserveReading=true;lastUI='';renderUI();};item.append(more);}
    return item;
  });
  if (introduction) {
    const opening = document.createElement('section'); opening.id = 'introduction'; opening.className = 'introduction';
    const label = document.createElement('span'); label.className = 'introduction-label'; label.textContent = '开场 · 虚构设定';
    const text = document.createElement('div'); text.textContent = introduction.text; opening.append(label, text); rows.unshift(opening);
  }
  const log = $('reply'),scroller=$('conversation'), nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 36;
  const oldScroll = scroller.scrollTop, latestInput = chat.rows(view.characterId).filter(row=>row.kind==='user').at(-1)?.id;
  const sourceId=work.state?.sourceInput?.draftId;
  const sourceFocus=requestedSourceFocus||work.expanded&&(!lastWorkOpen||sourceId!==lastSourceId);
  const focusInput=sourceFocus?chat.sourceRowId(view.characterId,sourceId)??latestInput:latestInput;
  const showInput = requestedSourceFocus||latestInput!==lastInputRow||work.expanded!==lastWorkOpen||work.expanded&&sourceId!==lastSourceId;lastSourceId=sourceId;requestedSourceFocus=false;
  lastInputRow=latestInput;lastWorkOpen=work.expanded;
  log.replaceChildren(...rows);
  const inputRow=showInput?rows.find(row=>row.dataset?.rowId===String(focusInput)):null;
  if(preserveReading){scroller.scrollTop=oldScroll;preserveReading=false;}
  else if(inputRow)scroller.scrollTop=Math.max(0,(scroller.scrollTop||0)+inputRow.getBoundingClientRect().top-scroller.getBoundingClientRect().top);
  else scroller.scrollTop=nearBottom?scroller.scrollHeight:oldScroll;
  $('status').textContent = connectionText() || view.error || appearanceFailure || (workSpeechView.state==='speaking'?'正在播报任务状态…':'') || (awaitingTranscript ? '正在转写…' : '') || (voicePhase === 'preparing' ? '正在准备麦克风…' : '') || ({ idle: wakeLabels[wakeUI.phase]||(wakeUI.phase==='error'?'唤醒已停止，请在网页重新开启':'我在这里'), listening: voicePhase === 'recording' ? '正在听你说 · 再点一次结束' : '正在准备麦克风…', thinking: '正在想怎么回应你…', speaking: '正在说话…', error: '这一轮没有完成' }[view.state]);
  const isThinking = connection.connected && !view.error && !awaitingTranscript && !(memoryBookMode && view.reply) && (awaitingTextTurn || view.state === 'thinking');
  $('thinking-indicator').hidden = !isThinking;
  if (isThinking && currentBubbleState !== 'thinking') {
    startThinking();
  } else if (!isThinking && currentBubbleState === 'thinking') {
    dismissBubble();
  }
  reconnect.hidden = connection.active || !connection.canRetry; reconnect.disabled = connection.active;
  // The cancel entry exists only while a startup is still in flight and not yet answered by the user.
  startupCancel.hidden = connection.state !== 'connecting' || startupCancel.disabled;
  if (connection.state !== 'connecting') startupCancel.disabled = false;
  $('invitation').disabled = !connection.connected;
  $('invitation-ignore').disabled = !connection.connected;
  // RWR-10-02: the header footer that held `#voice` is gone; voice input is a ⋯ menu entry now
  // (`drawerMenuEntries`). Guard the optional surface instead of assuming it exists — an unguarded
  // `$('voice').onclick` aborts this whole module before `ready`, so the backend never starts.
  if ($('voice')) {
    $('voice').textContent = voicePhase === 'preparing' ? '取消准备' : voicePhase === 'recording' ? '说完了' : '开始语音';
    $('voice').disabled = !connection.connected || (voicePhase === 'idle' && !['idle', 'error'].includes(view.state));
  }
  $('stop').hidden = (view.state === 'idle' || view.state === 'error')&&!workNotice&&!awaitingTextTurn;
  // E1: 停止按钮仅在有可取消工作时启用；空闲时可见但禁用，位置保持稳定。
  const cancellable = awaitingTextTurn || !(view.state === 'idle' || view.state === 'error') || !!workNotice || playback.busy;
  $('stop').disabled = !cancellable;
  $('send').disabled = !connection.connected || chat.pending(view.characterId) || (memoryBookMode && (!!textRequestId||!!thinkingRequestId||privacyPending));
  const styleSelect = $('reply-style'); if (styleSelect) styleSelect.disabled = $('send').disabled;
  $('invitation-card').hidden = !view.invitation; $('invitation').textContent = view.invitation?.text ?? '';
  if (panelOpen) fitComposer();
  scheduleIntroductionAck();
  applyRunningRoleIdentity();
}
function sendPresence(force = false) {
  if (!connection.connected) return;
  send({channel:'companion_presence',hidden:companionHidden||document.hidden,dnd:companionLife?.quiet===true});
  const presence = {
    channel: 'presence',
    isTyping: document.activeElement === $('text'),
    isSpeaking: playback.busy || workSpeechView.state === 'speaking',
    isTurnActive: awaitingTextTurn || awaitingTranscript || invitationTextPending || voicePhase !== 'idle' || ['listening','thinking','speaking'].includes(view.state),
    isWorkPendingConfirmation: !!work.state?.confirmation || work.state?.stage === 'confirming',
  };
  const key = JSON.stringify(presence);
  if (!force && key === lastPresenceKey) return;
  lastPresenceKey = key;
  send(presence);
}
// This presentation is never appended to chat or submitted as user/model text.
function scheduleIntroductionAck() {
  const current = introduction, epoch = introductionEpoch;
  if (!current || current.acknowledged || introductionFramePending || !connection.connected || !panelOpen || document.hidden) return;
  const visible = () => {
    if (epoch !== introductionEpoch || introduction !== current || !connection.current(current.generation) || !connection.connected || !panelOpen || document.hidden) return false;
    const node = $('introduction');
    if (!node || !node.getClientRects().length || $('drawer').hidden) return false;
    const rect = node.getBoundingClientRect(), clip = $('conversation').getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > clip.top && rect.top < clip.bottom && rect.right > clip.left && rect.left < clip.right;
  };
  introductionFramePending = true;
  requestAnimationFrame(() => {
    if (!visible()) { if (epoch === introductionEpoch) introductionFramePending = false; return; }
    // Give the visible content a paint opportunity before acknowledging it.
    requestAnimationFrame(() => {
      if (epoch === introductionEpoch) introductionFramePending = false;
      if (!visible() || current.acknowledged) return;
      send({ channel: 'command', command: { type: 'acknowledge_introduction', introductionId: current.id } }, current.generation);
      current.acknowledged = true;
    });
  });
}
$('conversation').addEventListener('scroll', scheduleIntroductionAck);
function panel(open) {
  if (open && memoryBookMode) dismissBubble();
  if(open&&panelOpen&&!$('drawer').hidden){scheduleIntroductionAck();return;}
  const epoch = ++panelEpoch;
  panelAnimation?.cancel(); panelAnimation = null;
  clearTimeout(panelCloseTimer);
  if (!open) {
    records.close(false);document.activeElement?.blur?.();
    // RWR-10-02: the in-dialog hotkey binding UI is gone, so there is no binding state to reset here.
  }
  const drawer = $('drawer');
  panelOpen = open; drawer.inert = !open;
  // RUX-08: the window-edge resize handles only exist while the chat window is in use, and they
  // track the PANEL's rect (see positionResizeHandles) — refreshed now, after the entrance
  // animation, and again on every host displayConfig acknowledgement.
  const resizeRoot = $('window-resize'); if (resizeRoot) resizeRoot.hidden = !open;
  if (open) { positionResizeHandles(); setTimeout(positionResizeHandles, 300); }
  const animate = drawer.animate && !document.hidden && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const finishClose = () => { if (!panelOpen && epoch === panelEpoch && !drawer.hidden) { clearTimeout(panelCloseTimer); drawer.hidden = true; native('shell', { type: 'panel', open: false }); } };
  if (open) { drawer.hidden = false; markVisibleWork(); native('shell', { type: 'panel', open: true }); }
  if (animate && !drawer.hidden) {
    panelAnimation = drawer.animate(open ? [{opacity:0,transform:'translateY(6px)'},{opacity:1,transform:'translateY(0)'}] : [{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(6px)'}], {duration:open ? 200 : 180,easing:'cubic-bezier(.2,.7,.2,1)'});
    // Occluded WKWebViews can suspend animation frames. Closing must still end.
    if (!open) panelCloseTimer = setTimeout(finishClose, 180);
    panelAnimation.finished.then(() => { if (!open) finishClose(); }, () => {});
  } else if (!open) finishClose();
  introductionEpoch++; introductionFramePending = false;
  if (open) { requestAnimationFrame(() => {
    if (panelOpen && epoch === panelEpoch && !document.hidden && document.hasFocus?.() !== false&&!records.isOpen) { fitComposer(); $('text').focus({ preventScroll: true }); }
  }); scheduleIntroductionAck(); }
  publishInteractiveRegions();
}
function fitComposer() {
  const input = $('text'); input.style.height = 'auto';
  input.style.height = `${Math.min(120, Math.max(24, input.scrollHeight || 24))}px`;
}
// FIX61-04: the function panel is its own view, separate from the chat drawer. It shares no state with
// the conversation, so opening it never clears a draft, an active turn or the reading position.
let toastTimer, lastReportedError = '', clickThrough = false;
function showToast(message) {
  const toast = $('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add('visible'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => { toast.hidden = true; }, 260);
  }, 3000);
}
// UI-MAN-01: while click-through is active the window still receives forwarded mouse MOVEMENT but not
// clicks. The renderer's job is therefore narrow: report which content-relative rectangles currently hold
// real, visible, clickable UI, and report where the pointer is. The shell decides the actual OS hit policy,
// which keeps a renderer bug from turning the whole desktop into a click sink.
//
// RWR-10-02: `#function-panel` is removed from the desktop, so it is no longer a region root. The size
// panel is INSIDE `#drawer`, so it is already covered by the drawer root.
// RUX-08: each window-edge resize handle is its own root so a pointer on a handle keeps the window
// clickable while click-through is on (the container itself is pointer-events:none and is skipped by
// the pointerEvents check below, exactly as intended).
const INTERACTIVE_REGION_ROOT_SELECTOR = ['#drawer', '#mic-test', '#work-records-dialog', '#invitation-card', '#speech-bubble', '#window-resize [data-edge]'].join(',');
const CLICKABLE_SELECTOR = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [role="button"]:not([aria-disabled="true"]), [tabindex]:not([tabindex="-1"])';
function visibleInteractiveRects() {
  const rects = [];
  for (const root of document.querySelectorAll(INTERACTIVE_REGION_ROOT_SELECTOR)) {
    if (root.hidden || !root.getClientRects().length) continue;
    const style = getComputedStyle(root);
    if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') continue;
    if (Number(style.opacity) === 0) continue;
    // A collapsing drawer still reports geometry mid-animation; only a settled surface may capture clicks.
    const bounds = root.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) continue;
    rects.push({ x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height });
    // Popup layers inside a panel (an open <select>, a dialog) can extend past their root, so each visible
    // interactive descendant contributes its own rectangle too.
    for (const control of root.querySelectorAll(CLICKABLE_SELECTOR)) {
      const rect = control.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (control.closest('[hidden]')) continue;
      rects.push({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    }
  }
  const portrait = renderer?.interactiveRect?.();
  if (portrait && portrait.width > 0 && portrait.height > 0) rects.push(portrait);
  return rects;
}
let lastRegionSignature = '';
function publishInteractiveRegions() {
  const rects = visibleInteractiveRects();
  const signature = JSON.stringify(rects);
  if (signature === lastRegionSignature) return;
  lastRegionSignature = signature;
  native('shell', { type: 'interactive_regions', regions: rects });
}
function reportPointerPosition(event) {
  if (!clickThrough) return;
  native('shell', { type: 'pointer_position', x: event.clientX, y: event.clientY, inside: true });
}
/**
 * RUX-08 (2026-10-10): four sides and four corners resize the CHAT WINDOW while the drawer is open.
 * The renderer only expresses intent: it measures the drag in CSS pixels (DPI-safe) and sends the
 * absolute target size; the HOST clamps it against the honest minimum and the current work area,
 * relayouts, and persists only on commit — an uncommitted drag restores the saved size, and the
 * transaction is cancelled on Escape or window blur. The model's own size is untouched, per the plan.
 *
 * Direction semantics follow the grabbed handle (`e`/`s` grow, `w`/`n` shrink from the same edge),
 * which is exactly the edge the user is dragging; on L-shaped placements (drawer below the pet) the
 * window edge under the pointer is the drawer's own edge, so the resize reads naturally there too.
 */
const drawerResize = { drag: null };
function cancelDrawerResize(commit = false) {
  if (!drawerResize.drag) return false;
  drawerResize.drag = null;
  native('shell', { type: 'resize_drawer', phase: commit ? 'commit' : 'cancel' });
  return true;
}
/**
 * RUX-08 (user rework, 2026-10-10): the resize handles must sit on the VISIBLE CHAT PANEL's edges —
 * not on the transparent host window's bounds. In an L-shaped layout the host window spans the pet
 * AND the panel, so a viewport-edge handle lands far away from the panel the user is looking at
 * (measured: panel right edge x=909, host e-handle at x=1202 — invisible to the user). The container
 * is therefore placed over `#drawer`'s measured rect, and each handle strip aligns with a PANEL edge.
 * Re-run on open, on every host `displayConfig` acknowledgement (any relayout) and once more after
 * the drawer's entrance animation settles.
 */
function positionResizeHandles() {
  const root = $('window-resize'), drawer = $('drawer');
  if (!root || root.hidden || !drawer || drawer.hidden) return;
  const rect = drawer.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  root.style.left = `${rect.left}px`;
  root.style.top = `${rect.top}px`;
  root.style.width = `${rect.width}px`;
  root.style.height = `${rect.height}px`;
}
function installDrawerResize() {
  const root = $('window-resize');
  if (!root) return;
  for (const handle of root.querySelectorAll('[data-edge]')) {
    handle.onpointerdown = event => {
      if (event.button !== 0 || drawerResize.drag) return;
      event.preventDefault(); event.stopPropagation();
      drawerResize.drag = { id: event.pointerId, edge: handle.dataset.edge };
      // Capture is the robust path for REAL pointers; a synthetic/test pointer (or one the browser
      // already released) throws NotFoundError here, and the drag must still work through the
      // element's own move/up handlers in that case.
      try { handle.setPointerCapture(event.pointerId); } catch { /* capture unavailable: element handlers still run */ }
      native('shell', { type: 'resize_drawer', phase: 'begin', edge: drawerResize.drag.edge });
    };
    handle.onpointermove = event => {
      const active = drawerResize.drag;
      if (!active || active.id !== event.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      // RUX-08 (rework): send the pointer's VIEWPORT position, never a screenX delta. The host
      // derives the new size from the pointer's absolute screen position (window origin + viewport
      // coords), because the WINDOW ITSELF MOVES during the drag — fitDisplay re-places the drawer
      // against the screen bounds — and that motion corrupts any delta reference (measured: a
      // +125px drag oscillated and committed -294px). An absolute derivation has no reference to
      // corrupt: each update recomputes "the size implied by where the mouse is right now".
      native('shell', { type: 'resize_drawer', phase: 'update', edge: active.edge, pointerX: event.clientX, pointerY: event.clientY });
    };
    handle.onpointerup = event => {
      if (!drawerResize.drag || drawerResize.drag.id !== event.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      drawerResize.drag = null;
      native('shell', { type: 'resize_drawer', phase: 'commit' });
    };
    handle.onpointercancel = handle.onlostpointercapture = event => {
      if (!drawerResize.drag || drawerResize.drag.id !== event.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      drawerResize.drag = null;
      native('shell', { type: 'resize_drawer', phase: 'cancel' });
    };
  }
}
// Both the drawer and its peer views are separate surfaces, so each must refresh the report.
function installRegionTracking() {
  const refresh = () => { publishInteractiveRegions(); };
  for (const root of ['#drawer', '#mic-test', '#work-records-dialog']) {
    const node = $(root);
    if (!node) continue;
    new MutationObserver(refresh).observe(node, { attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
  }
  const observer = new MutationObserver(refresh);
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'style', 'disabled', 'aria-disabled'] });
  document.addEventListener('pointermove', event => { reportPointerPosition(event); }, true);
  // Leaving the window must release capture immediately, otherwise the last region would keep the window
  // intercepting clicks that the user is aiming at the desktop behind it.
  document.addEventListener('pointerleave', () => { native('shell', { type: 'pointer_position', inside: false }); }, true);
  window.addEventListener('blur', () => { native('shell', { type: 'pointer_position', inside: false }); });
  window.addEventListener('resize', () => { refresh(); positionBubble(); });
  publishInteractiveRegions();
  // A read-only probe for the Windows smoke test: recomputes the report on demand so the harness can tell
  // "the DOM has no visible controls" apart from "the observer never fired".
  window.__aikaInteractiveRegionProbe = () => ({ current: visibleInteractiveRects().length, lastSignatureLength: lastRegionSignature.length });
}

/**
 * RWR-10-02: `#function-panel` no longer exists on the desktop. The right-click panel is disabled
 * (desktop/pointer-router.ts) and the low-frequency actions it used to host moved into the drawer's 「⋯」
 * menu, which is the single desktop entry point from here on.
 *
 * `functionPanel()` is kept as an explicit no-op for the historical dismiss call sites, and
 * `drawerMenuOpen` is the state those call sites actually need now (it participates in the greeting's
 * "busy" calculation and in the Escape ordering, exactly as the panel did).
 */
let drawerMenuOpen = false;
function functionPanel() { /* removed surface: nothing to open or close */ }
function setLocalGreetingPreference(enabled, persist = true) {
  if (typeof enabled !== 'boolean') return;
  if (memoryBookMode) enabled = false;
  const wasEnabled = localGreetingEnabled;
  localGreetingEnabled = enabled;
  localGreeting.setEnabled(enabled);
  if (persist) native('shell', { type: 'local_greeting_preference', enabled });
  renderDrawerMenu();
  // ACCEPT-02: turning the switch on is the one moment the user expects to SEE the feature. A preview is
  // scheduled only for an explicit off -> on transition, never for a repeat click on an already-on switch
  // and never for a restored or console-echoed value (`persist === false`).
  if (enabled && !wasEnabled && persist) scheduleLocalGreetingPreview();
}
let localGreetingPreviewToken = 0;
/**
 * ACCEPT-02: one immediate, non-persistent preview after the user enables local greetings.
 *
 * It does NOT touch the scheduler's real clock, cooldown or `lastShownAt`, so the normal 45-minute idle
 * policy and the 6-hour cooldown are unaffected. The open menu counts as "busy", so the menu is closed
 * first and the busy state is re-read on the next frame — the same sequence the ticker uses.
 */
function scheduleLocalGreetingPreview() {
  const token = ++localGreetingPreviewToken;
  closeDrawerMenu();
  requestAnimationFrame(() => {
    // The user may have switched it off again, or a reply may have started, in this same frame.
    if (token !== localGreetingPreviewToken || !localGreetingEnabled) return;
    if (localGreetingBusy()) return;
    const decision = localGreeting.preview();
    if (!decision) return;
    showBubble(decision.text, 'greeting', 8000);
    renderUI();
  });
}
function localGreetingBusy() {
  return !connection.connected || currentBubbleState !== 'idle' || !!capturing || voicePhase !== 'idle' || awaitingTextTurn || awaitingTranscript
    || view.state !== 'idle' || !!workNotice || playback.busy || drawerMenuOpen;
}
function openConsole(target) {
  // The console is a local page served by this same backend. Only a same-origin path is passed; the
  // shell resolves it against the management origin and refuses anything else.
  requestManagement(target, 'menu');
}
/**
 * RWR-10-02/10-01: the drawer's 「⋯」 menu. Every entry resolves to a real target — there is deliberately
 * no entry that silently does nothing, and no entry for a feature whose backend does not exist yet.
 *
 * The size panel is a real in-frame surface (see `#size-panel`), not a toast: the previous
 * "调整大小" entry only told the user to go find a hidden handle.
 */
function drawerMenuEntries() {
  if (memoryBookMode) return [
    { id:'quiet',label:`免打扰：${companionLife?.quiet?'已开启':'已关闭'}`,pressed:!!companionLife?.quiet,disabled:!companionLife,run:()=>companionAction('set_quiet',!companionLife?.quiet) },
    { id:'incognito',label:`本地无痕：${desktopIncognito?'已开启':'已关闭'}`,pressed:desktopIncognito,disabled:!!textRequestId||!!thinkingRequestId||privacyPending,run:()=>{privacyPending=true;renderUI();send({channel:'book_privacy',characterId:view.characterId,sessionId:backendSessionId,incognito:!desktopIncognito})} },
    { id:'life',label:`自主活动：${companionLife?.enabled?'已开启':'已暂停'}`,pressed:!!companionLife?.enabled,disabled:!companionLife,run:()=>companionAction('set_enabled',!companionLife?.enabled) },
    { id:'book',label:'Memory Book',run:()=>openConsole('/memory-book') },
    { id:'console',label:'打开管理',run:()=>openConsole('/chat') },
    { id:'settings',label:'设置',run:()=>openConsole('/settings') },
    { id:'hide_to_tray',label:'收起到系统托盘',run:()=>native('shell',{type:'hide_to_tray'}) },
  ];
  return [
    { id: 'console', label: '打开控制台', run: () => openConsole('') },
    // LUI-06: deep links land directly on the React SPA — the legacy console fragments
    // (`/#page=...`) were served by the retired console and no longer exist.
    { id: 'companion-settings', label: '主动陪伴设置', run: () => openConsole(`/settings?tab=companion`) },
    // RUX-07 (2026-10-10): 「外观 / 换肤」「记忆与对话」 and 「开始语音输入」 were removed from this
    // menu by user direction. Appearance/memory stay reachable through the console (打开控制台, or the
    // console's own character pages); voice input remains available through the press-to-talk hotkey.
    // No stub entries and no leftover click area.
    { id: 'size', label: display.panelOpen ? '收起大小设置' : '调整大小', run: () => toggleSizePanel() },
    { id: 'mode', label: display.mode === 'half' ? '全身展示' : '半身展示', run: () => setDisplayMode(display.mode === 'half' ? 'full' : 'half') },
    { id: 'greeting', label: `本地时间问候：${localGreetingEnabled ? '已开启' : '已关闭'}`, pressed: localGreetingEnabled,
      run: () => setLocalGreetingPreference(!localGreetingEnabled) },
    { id: 'sound', label: `回复声音：${playback.soundEnabled ? '已开启' : '已关闭'}`, pressed: playback.soundEnabled,
      run: () => applyReplySound(!playback.soundEnabled) },
    // FIX61-11: the microphone test is a desktop view, not a console page (FIX61-07 §2 requires the
    // trusted renderer to own the device). RWR-10-02 removed the function panel that used to host it,
    // so the ⋯ menu is now its entry point.
    { id: 'microphone', label: '麦克风测试', run: () => micTestPanel(true) },
    // Window controls collapse; the tray context menu owns actual application exit.
    { id: 'hide_to_tray', label: '收起到系统托盘', run: () => { wake.disconnect(); captureFeedback.stop(); void stopPlayback(); stopCapture(); native('shell', { type: 'hide_to_tray' }); } },
    // RUX-02: 快速重启 restarts the managed backend through the host's bounded shutdown path. The
    // connection drop is rendered by the existing connectionChanged plumbing; the shell relaunches the
    // backend without leaving the app. This is NOT a web reload and never touches saved configuration.
    { id: 'quick_restart', label: '快速重启', run: () => { wake.disconnect(); captureFeedback.stop(); void stopPlayback(); stopCapture(); native('shell', { type: 'restart_backend' }); } },
  ];
}
function renderDrawerMenu() {
  const menu = $('drawer-more-menu');
  if (!menu) return;
  const focusedId=menu.contains(document.activeElement)?document.activeElement.id:null;
  const items = drawerMenuEntries().map(entry => {
    const item = document.createElement('button');
    item.type = 'button'; item.setAttribute('role', entry.pressed===undefined?'menuitem':'menuitemcheckbox'); item.id = `menu-${entry.id}`;
    item.textContent = entry.label;item.disabled=entry.disabled===true;
    if(entry.id==='thinking')item.disabled=!!textRequestId||!!thinkingRequestId;
    if (entry.pressed !== undefined) item.setAttribute('aria-checked', String(entry.pressed));
    item.onclick = event => { event.stopPropagation(); closeDrawerMenu(); entry.run(); };
    return item;
  });
  menu.replaceChildren(...items);
  if(focusedId)menu.querySelector('#'+CSS.escape(focusedId))?.focus({preventScroll:true});
}
function closeDrawerMenu() {
  const menu = $('drawer-more-menu');
  if (!menu) return;
  menu.remove();
  drawerMenuOpen = false;
  document.removeEventListener('pointerdown', dismissDrawerMenu, true);
  publishInteractiveRegions();
}
function dismissDrawerMenu(event) {
  const menu = $('drawer-more-menu');
  if (menu && !menu.contains(event.target) && !$('drawer-settings')?.contains(event.target)) closeDrawerMenu();
}
function toggleDrawerMenu() {
  if ($('drawer-more-menu')) { closeDrawerMenu(); return; }
  const menu = document.createElement('div');
  menu.id = 'drawer-more-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '更多操作');
  $('drawer').append(menu);
  drawerMenuOpen = true;
  renderDrawerMenu();
  menu.addEventListener('keydown',event=>{
    const items=[...menu.querySelectorAll('button:not(:disabled)')],index=items.indexOf(document.activeElement);
    if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;items[next]?.focus();}
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeDrawerMenu();$('drawer-settings')?.focus();}
  });
  document.addEventListener('pointerdown', dismissDrawerMenu, true);
  publishInteractiveRegions();
  menu.querySelector('button')?.focus?.({ preventScroll: true });
}
const playback = new DesktopPlaybackController(new BrowserPlaybackDriver(), scope => view.accepts(scope)||workSpeechView.accepts(scope), (requestId, event) => {
  const workOutput=workSpeechView.accepts(event.scope);
  (workOutput?workSpeechView:view).receive({type:'playback',playback:event});
  if(workOutput&&event.type==='started'&&workNotice)workNotice.started=true;
  if(workOutput&&event.type==='ended'&&workNotice?.started&&workNotice.workBinding)work.presented(workNotice.workBinding);
  if(workOutput&&['ended','stopped','error'].includes(event.type)){workNotice=null;workSpeechView.reset();}
  renderUI();
  send({ channel: 'playback', requestId, event });
  if (['ended','stopped','error'].includes(event.type)) renderer?.reset();
  if (event.type === 'started' || ['ended','stopped','error'].includes(event.type)) report({ type: 'playback-state', event: event.type, timingBasis: event.timingBasis, model: renderer?.ready ? renderer.snapshot() : null });
});
function stopPlayback(scope) { playback.stop(scope); }
/**
 * RWR-10-01: the reply-sound preference is owned by the HOST prefs file, not by this renderer. The host
 * reports it on every fresh page and after every console change, and this function applies it. The old
 * in-dialog `#sound-toggle` checkbox (deleted in RWR-10-02) had no listener at all, so the switch silently
 * did nothing; the switch now lives in the 「⋯」 menu and reads back from the playback controller.
 */
function applyReplySound(enabled) {
  if (typeof enabled !== 'boolean') return;
  playback.setOutputEnabled(enabled);
  if (drawerMenuOpen) renderDrawerMenu();
}
/**
 * RWR-10-03: restore a task's original input into the CURRENT conversation only.
 *
 * Three guards, all required: the card must be expanded, the source must be structurally valid, and its
 * scope must belong to the session now being displayed. The last one is what stops a saved task from an
 * earlier session from appearing as this session's 「你的原话」. `DesktopChatLog.restoreSource` enforces the
 * same rule independently, so a future caller cannot bypass it.
 */
function restoreSelectedSource(){const source=work.state?.sourceInput;if(!work.expanded||!source||typeof source.draftId!=='string'||typeof source.text!=='string'||!isCharacterId(source.scope?.characterId)||typeof source.scope?.sessionId!=='string')return;if(source.scope.sessionId!==backendSessionId)return;if(!['original_input','legacy_saved_input'].includes(source.provenance))return;chat.restoreSource(source);}
function markVisibleWork(){if(!records.isOpen&&panelOpen&&!document.hidden&&!$('drawer').hidden&&work.expanded&&!$('work-card').hidden)work.presented();}
function displayedWorkBinding(){return work.inputBinding();}
function clearWorkSpeech(){const scope=workNotice?.scope;workNotice=null;workSpeechView.reset();if(scope)stopPlayback(scope);}
function stopCapture(scope) {
  if (!scope || capturing && scopeEquals(capturing.scope, scope)) voicePhase = 'idle';
  if (!capturing || scope && !scopeEquals(capturing.scope, scope)) return;
  const active = capturing; capturing = null; captureFeedback.stop(active.feedbackToken);active.controller.abort(); active.session?.stop();
  voiceFrames.reset();
  report({ type: 'capture-stopped' });
}
/**
 * FIX61-08 live audio: the backend asks for the frame it already captured for this input session, and
 * the renderer answers with exactly that PCM16 payload. Frames are keyed by index so a request for an
 * index this renderer never captured is refused rather than answered with the wrong audio.
 */
const voiceFrames={sessions:new Map(),reset(){this.sessions.clear();},
  add(sessionId,index,pcm){let frames=this.sessions.get(sessionId);if(!frames)this.sessions.set(sessionId,frames=new Map());
    frames.set(index,pcm);while(frames.size>240){const oldest=frames.keys().next().value;frames.delete(oldest);}},
  take(sessionId,index){const frames=this.sessions.get(sessionId);const pcm=frames?.get(index);if(pcm)frames.delete(index);return pcm;}};
function answerVoiceFrame(message,generation){
  const pcm=voiceFrames.take(message.inputSessionId,message.index);
  // While the user has not spoken yet the backend asks for a frame that does not exist. That is
  // normal: answer with an empty frame so the backend asks again instead of failing the capture.
  if(!pcm||pcm.length!==message.sampleCount*2){
    send({channel:'voice_chunk',requestId:message.requestId,inputSessionId:message.inputSessionId,generation:message.generation,
      index:message.index,sampleRate:message.sampleRate,sampleCount:0,pcm:''},generation);return;}
  send({channel:'voice_chunk',requestId:message.requestId,inputSessionId:message.inputSessionId,generation:message.generation,
    index:message.index,sampleRate:message.sampleRate,sampleCount:message.sampleCount,pcm:base64(new Uint8Array(pcm.buffer,pcm.byteOffset,pcm.byteLength))},generation);
}
function command(cmd,{wakeInput=false,invitationResponseText}={}) {
  if (memoryBookMode && ['start_voice','finish_voice','click_invitation'].includes(cmd.type)) return;
  const commandEnteredAt=performance.now();
  if (!connection.connected) return;
  if (cmd.type === 'submit_text' && (chat.pending(view.characterId) || memoryBookMode && (textRequestId||thinkingRequestId||privacyPending))) return;
  const acceptedTextInvitation = cmd.type === 'click_invitation' && typeof invitationResponseText === 'string' && invitationResponseText.trim().length > 0;
  localGreeting.markInteraction();
  if (currentBubbleState === 'greeting') dismissBubble();
  if (['start_voice', 'click_invitation', 'submit_text', 'cancel'].includes(cmd.type)) stopThinking();
  if(!wakeInput&&['start_voice','click_invitation','submit_text','cancel'].includes(cmd.type)){wake.pause();wakeRequestId=null;}
  if(['start_voice','submit_text'].includes(cmd.type)){const binding=displayedWorkBinding();cmd={...cmd,...(binding?{workBinding:binding}:{})};}
  if(cmd.type==='start_voice'||cmd.type==='click_invitation'&&!acceptedTextInvitation)voiceRequestAt=inputEventTiming?.at??commandEnteredAt;

  if (cmd.type === 'finish_voice' && voicePhase !== 'recording') {
    command({ type: 'cancel' }); view.error = '录音尚未就绪，已取消；请等到提示正在听再结束。'; renderUI(); return;
  }
  if (cmd.type === 'click_invitation' && voicePhase !== 'idle') return;
  if(cmd.type==='start_voice'||cmd.type==='click_invitation'&&!acceptedTextInvitation)captureFeedbackToken=wakeInput?wakeFeedbackToken:captureFeedback.start();
  else if(['finish_voice','cancel','submit_text'].includes(cmd.type)&&!wakeInput)captureFeedback.stop();
  if(['cancel','start_voice','click_invitation'].includes(cmd.type))textRequestId=null;
  if(cmd.type==='submit_text'){
    if (chat.pending(view.characterId)) return;
    const key=textRetryKey(),previous=textRetries.get(key),style=cmd.replyStyle??'inherit';
    if(memoryBookMode&&previous?.text===cmd.text&&previous.style!==style){$('text').value=cmd.text;showToast('此输入已有未确认请求，请沿用原本轮风格恢复，或新建会话。');return;}
    const request=memoryBookMode&&previous?.text===cmd.text?previous:{text:cmd.text,style,id:crypto.randomUUID()};
    if(memoryBookMode)textRetries.set(key,request);
    textRequestId=request.id;cmd={...cmd,clientRequestId:textRequestId};
  }
  if (cmd.type === 'start_voice') { voiceRequestId = crypto.randomUUID();wakeRequestId=wakeInput?voiceRequestId:null; cmd = { ...cmd, clientRequestId: voiceRequestId }; invitationPending = false; }
  if (cmd.type === 'click_invitation') { voiceRequestId = null; invitationPending = !acceptedTextInvitation; invitationTextPending = acceptedTextInvitation; }
  if (['cancel', 'submit_text'].includes(cmd.type)) { voiceRequestId = null; invitationPending = false; chat.cancelVoice(view.characterId); }
  if (['start_voice', 'click_invitation'].includes(cmd.type)) {
    chat.failPending(view.characterId);
    if (!acceptedTextInvitation) chat.beginVoice(view.characterId, true);
    else if (!chat.submit(view.characterId, invitationResponseText)) { invitationTextPending = false; invitationPending = false; return; }
  }
  if (cmd.type === 'submit_text' && !chat.submit(view.characterId, cmd.text)) return;
  if (cmd.type === 'cancel') { work.forgetBinding();chat.failPending(view.characterId);restoreTextRetry();if(memoryBookMode){textRetries.delete(textRetryKey());showToast('本轮已停止；该轮不会自动重发，再次发送将作为新的一轮。');} }
  if (['cancel','submit_text'].includes(cmd.type)) hold.clear();
  if (['cancel','submit_text','start_voice','click_invitation'].includes(cmd.type)) {
    clearWorkSpeech();workSpeechBlocked=false;inputFocusEpoch++;inputScope=null;awaitingTranscript=false;work.input(!!cmd.workBinding); routeFocusEpoch=++interactionFocusEpoch; companionRoute=null; void stopPlayback(); stopCapture(); renderer?.reset();
  }
  captureAllowed = cmd.type === 'start_voice' || cmd.type === 'click_invitation' && !acceptedTextInvitation;
  if (captureAllowed) { voicePhase = 'preparing'; }
  if (cmd.type === 'finish_voice') { awaitingTranscript=true;voicePhase = 'finishing'; captureAllowed = false; if (capturing) capturing.inputEndedAt = new Date().toISOString(); }
  if (['cancel', 'submit_text', 'start_voice', 'click_invitation'].includes(cmd.type)) awaitingTextTurn = cmd.type === 'submit_text' || acceptedTextInvitation;
  view.command(cmd);
  if(memoryBookMode&&cmd.type==='submit_text')view.reply='';
  if (cmd.type === 'start_voice') renderer?.beginAttention();
  // Dispatch explicit voice authorization before rebuilding the chat DOM.
  if (cmd.type === 'start_voice') { send({ channel: 'command', command: cmd }); report({type:'capture-command-timing',source:inputEventTiming?.source??'command',handlerToCommandMs:Math.max(0,commandEnteredAt-voiceRequestAt),handlerToSendMs:Math.max(0,performance.now()-voiceRequestAt)});renderUI(); }
  else { renderUI(); send({ channel: 'command', command: cmd }); }

}
const bytesFromBase64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
function base64(bytes) { let text = ''; for (let at = 0; at < bytes.length; at += 32768) text += String.fromCharCode(...bytes.subarray(at, at + 32768)); return btoa(text); }
function connectionChanged(value) {
  if (!connection.update(value)) return;
  stopCompanionAnimation();companionManifest=null;
  companionLife = null;
  localPetAction=null;localPetChase=false;
  companionRelationship = null; companionFocus = false; companionFocusTimer = null;
  companionSequence = -1;
  companionDelivery=null;
  cancelInvitationAutoDismiss();
  wake.disconnect();wakeRequestId=null;
  captureFeedback.stop();
  awaitingTextTurn = false;invitationTextPending=false;lastPresenceKey='';clearWorkSpeech();spokenNotices.clear();workSpeechBlocked=false;inputFocusEpoch=0;interactionFocusEpoch=0;routeFocusEpoch=0; inputScope=null;awaitingTranscript=false;work.reset(); companionRoute=null; textRequestId=null;resetThinking();
  presentationPolicy=null;applyPresentationPolicy();
  // RUX-04: the appearance watchdog belongs to the session that armed it; a dropped/superseded
  // connection disarms it (the connection status explains the wait instead).
  clearAppearanceWatchdog(); previewAppearanceless = false;
  hold.clear(); voiceRequestId = null; invitationPending = false; chat.cancelVoice(view.characterId);
  introduction = null; introductionEpoch++; introductionFramePending = false; captureAllowed = false;
  chat.setDraft(view.characterId, $('text').value); chat.failPending(view.characterId);restoreTextRetry();
  void stopPlayback(); stopCapture(); renderer?.reset(); view.reset(); view.reply = ''; view.invitation = null;
  renderUI();
  if (!connection.active) panel(true);
}
async function receive(message, generation) {
  if(message.channel==='book_activity'||message.channel==='book_activity_pulse'){
    if(generation!==connection.generation||message.characterId!==view.characterId)return;
    if(message.channel==='book_activity'){localPetActivity=message.view;renderDrawerMenu();}
    else if(!localPetAction||localPetAction.kind==='typing')beginLocalPet('typing');
    return;
  }
  if(message.channel==='book_reply_style'){
    if(message.requestId!==stylePreviewRequest||message.characterId!==view.characterId||message.sessionId!==backendSessionId)return;
    const target=$('reply-style-preview');if(!target)return;
    const decision=message.decision;
    target.textContent=message.error?`回复风格预览失败：${message.error}`:decision?`发送前：${replyStyleSummary(decision)}${decision.requestConflict?'（字数边界优先）':''} · ${decision.effectiveRange.minChars===null?'无下限':`最少${decision.effectiveRange.minChars}字`} / ${decision.effectiveRange.maxChars===null?'无上限':`最多${decision.effectiveRange.maxChars}字`}`:'';
    return;
  }
  if(message.channel==='book_thinking'){
    if(generation!==connection.generation)return;
    if(message.requestId!==thinkingRequestId||message.characterId!==view.characterId||message.sessionId!==backendSessionId)return;
    clearTimeout(thinkingTimer);thinkingTimer=null;thinkingRequestId=null;
    if(message.error){renderThinkingPanel(message.error);showToast(message.error);}
    else if(message.data&&Number.isSafeInteger(message.data.level)&&Number.isSafeInteger(message.data.revision)&&typeof message.data.label==='string'&&(!message.data.options||Array.isArray(message.data.options)&&message.data.options.every(option=>Number.isSafeInteger(option.level)&&typeof option.label==='string'))){thinkingData={...thinkingData,...message.data};renderThinkingPanel('当前：'+message.data.label.replace(/[,，].*$/,''));}
    else renderThinkingPanel('网页返回的思考强度结果无效，请刷新。');
    renderUI();return;
  }
  if (message.channel === 'appearance') {
    appearanceQueue = appearanceQueue.catch(() => {}).then(async () => {
      const original = $('model'), canvas = original.cloneNode(false);
      canvas.id = 'appearance-candidate'; canvas.style.visibility = 'hidden'; canvas.style.position = 'absolute'; canvas.style.inset = '0'; original.parentNode.append(canvas);
      const candidate = message.manifest.type === 'sprite' ? new SpriteRenderer(canvas, report, { assetBase: message.assetBase }) : new JellyfishRenderer(canvas, report, { assetBase: message.assetBase });
      try {
        resolveLocalPetSlot(message.manifest.localInteractions??null,message.manifest,'petting');
        candidate.bindSkin(message.manifest); await candidate.load();
        if (generation !== connection.generation) throw Error('形象加载已被新会话取代');
        candidate.setFraming(display.mode); const previous = renderer;
        // Cached restoration may have replaced the original while this candidate loaded.
        const current = $('model');
        finishLocalPet(true);stopCompanionAnimation();localPetChase=false;localPetMotionMode=null;companionManifest=message.manifest;companionAppearanceRequestId=message.requestId;renderDrawerMenu();
        canvas.id = 'model'; canvas.style.visibility = current.style.visibility; current.replaceWith(canvas); renderer = candidate; previous?.dispose(); applyPresentationPolicy();
        companionCapabilityNotes = message.manifest.type === 'sprite'
          ? ['working', 'sleeping', 'happy'].filter(state => !message.manifest.sprite?.clips?.[state]).map(state => `形象包未声明 ${state} 动画；仅提供本地位移反馈`)
          : !message.manifest.catalog?.items?.some(item => item.availability === 'automatic' && item.defaultEnabled) ? ['形象包没有已启用的自动预设；仅提供本地位移反馈'] : [];
        report({ type: 'companion-capabilities', skinId: message.manifest.skinId, notes: companionCapabilityNotes });
        send({ channel: 'ack', requestId: message.requestId }, generation);
        // RUX-04: the correct character's first frame IS the pet's first frame — nothing was shown
        // before it and nothing is pressed over it now. A success clears any earlier failure note.
        appearanceReady = true; appearanceFailure = null; clearAppearanceWatchdog();
        report({ type: 'appearance-ready', basis: 'appearance-first-frame' });
      } catch (error) {
        candidate.dispose(); canvas.remove();
        // RUX-04: a load failure never presses text onto the window. The drawer status line and a
        // toast carry the honest state; the backend's next appearance message retries the same path.
        if (generation === connection.generation) noteAppearanceFailure(error.message);
        send({ channel: 'rpc_error', requestId: message.requestId, message: `形象加载失败：${error.message}` }, generation);
      }
    }); return;
  }
  if (!connection.current(generation)) return;
  if (message.channel === 'book_turn_state') {
    const scope = message.scope;
    if (!memoryBookMode || !textRequestId || message.clientRequestId !== textRequestId || scope?.turnId !== textRequestId
      || scope.characterId !== view.characterId || scope.sessionId !== backendSessionId || !Number.isSafeInteger(scope.generation)) return;
    if (!['pending','completed','failed'].includes(message.state)) return;
    if (message.state === 'completed' && (typeof message.text !== 'string' || !message.text.trim())) return;
    if(message.state!=='pending'||!view.accepts(scope))report({type:'book-turn-recovery',requestId:textRequestId,state:message.state});
    if (!view.accepts(scope)) view.restoreTextTurn(scope);
    chat.acknowledge(scope, true); chat.route(scope, 'companion'); companionRoute=scope; awaitingTextTurn=false;
    if (message.state === 'completed') {
      view.receive({type:'reply',reply:{scope,text:message.text,expression:{emotion:'neutral'}}});
      chat.reply(scope,message.text,message.attachmentCount); stopThinking(); showBubble(message.text,'speaking');
      const lengthNotice=replyLengthNotice(message.replyLength);
      const styleNotice=message.replyStyleDecision?`本轮风格：${replyStyleSummary(message.replyStyleDecision)}`:'';
      if(styleNotice||lengthNotice)showToast([styleNotice,lengthNotice].filter(Boolean).join(' · '));
      textRetries.delete(textRetryKey());turnReplyStyle='inherit';previewReplyStyle(); const styleSelect=$('reply-style'); if(styleSelect)styleSelect.value='inherit';
      view.receive({type:'presentation',presentation:{scope,state:'idle',expression:{emotion:'neutral'},mouth:0}});
      textRequestId=null;
    } else if (message.state === 'failed') {
      view.receive({type:'error',scope,message:message.message || '本轮未完成。'});
      chat.failPending(view.characterId);restoreTextRetry();textRetries.delete(textRetryKey()); stopThinking(); showBubble(message.message || '本轮未完成。','error',6000); textRequestId=null;
    }
    renderUI();renderDrawerMenu(); return;
  }
  if(message.channel==='book_erased'){
    if(!memoryBookMode||!isCharacterId(message.characterId)||message.sessionId!==backendSessionId||!Array.isArray(message.turnIds)||message.turnIds.some(id=>typeof id!=='string'))return;
    if(message.characterId!==view.characterId){chat.erase(message.characterId,message.turnIds);return;}
    const selected=new Set(message.turnIds),last=chat.rows(view.characterId).filter(row=>row.kind==='assistant').at(-1),affected=!!(view.scope&&selected.has(view.scope.turnId))||!!(last?.scope&&selected.has(last.scope.turnId));
    const oldDraft=chat.draft(view.characterId);chat.erase(view.characterId,message.turnIds);
    if($('text').value===oldDraft&&oldDraft!==chat.draft(view.characterId))$('text').value=chat.draft(view.characterId);
    if(affected){view.reset();view.reply='';dismissBubble();}
    if(textRequestId&&selected.has(textRequestId)){textRequestId=null;awaitingTextTurn=false;inputScope=null;companionRoute=null;chat.failPending(view.characterId);stopThinking();}
    renderUI();renderDrawerMenu();return;
  }
  if(message.channel==='companion_takeover'){
    if(message.phase==='prepare'){
      const inherited=localGreeting.handoffState();bookGreetingInheritance=inherited;bookTakeoverReady=false;localGreeting.setEnabled(false);localGreetingEnabled=false;
      send({channel:'companion_takeover',characterId:view.characterId,stopped:true,lastShownAt:inherited.lastShownAt,previouslyEnabled:inherited.enabled});
    }else if(message.phase==='ready'){bookTakeoverReady=true;}
    else if(message.phase==='failed'){bookTakeoverReady=false;localGreetingEnabled=bookGreetingInheritance?.enabled===true;localGreeting.setEnabled(localGreetingEnabled);showToast('主动问候接管失败，已恢复本地时间问候。');}
    send({channel:'companion_presence',hidden:companionHidden||document.hidden,dnd:companionLife?.quiet===true});return;
  }
  if(message.channel==='companion_offer'){
    if(bookTakeoverReady&&message.characterId===view.characterId&&message.sessionId===backendSessionId&&!companionHidden&&!document.hidden&&!companionFocus&&!companionLife?.quiet&&!localGreetingBusy()&&typeof message.id==='string'&&message.id.length<=128)
      send({channel:'companion_claim',characterId:view.characterId,sessionId:backendSessionId,id:message.id});
    return;
  }
  if(message.channel==='companion_message'){
    const delivery=message.delivery;
    if(!bookTakeoverReady||message.characterId!==view.characterId||message.sessionId!==backendSessionId||companionHidden||document.hidden||companionFocus||companionLife?.quiet||localGreetingBusy()||typeof delivery?.id!=='string'||typeof delivery.text!=='string'||!delivery.text.trim()||delivery.expiresAt<Date.now())return;
    const key=`book-proactive-seen:${view.characterId}:${backendSessionId}`,old=JSON.parse(sessionStorage.getItem(key)||'[]');
    if(companionSeen.has(delivery.id)||old.includes(delivery.id)){send({channel:'companion_ack',characterId:view.characterId,id:delivery.id});return;}
    const scope={characterId:view.characterId,sessionId:backendSessionId,turnId:delivery.id,generation:view.scope?.generation??0};
    chat.reply(scope,delivery.text);showBubble(delivery.text,'greeting',10000);lastUI='';renderUI();
    companionSeen.add(delivery.id);sessionStorage.setItem(key,JSON.stringify([...old,delivery.id].slice(-128)));
    requestAnimationFrame(()=>requestAnimationFrame(()=>{if(!document.hidden&&!companionHidden&&!companionFocus)send({channel:'companion_ack',characterId:view.characterId,id:delivery.id});}));return;
  }
  if (message.channel === 'companion_error') { showToast(message.message); report({ type: 'companion-error', message: message.message }); return; }
  if (message.channel === 'companion_state') {
    try { validateCompanionLife(message.state); } catch (error) { report({ type: 'companion-invalid-state', message: error.message }); return; }
    if (message.state.characterId !== view.characterId || message.state.pairingId !== 'local-user'
      || !Number.isSafeInteger(message.sequence) || message.sequence <= companionSequence) return;
    if(companionAnimation&&!companionAnimation.manual&&message.interactionRevision!==undefined&&message.interactionRevision!==companionAnimation.revision)stopCompanionAnimation();
    const menuChanged = !companionLife || companionLife.activity !== message.state.activity || companionLife.enabled !== message.state.enabled || companionLife.quiet !== message.state.quiet || companionFocus !== !!message.focus || companionFocusTimer?.id !== message.focusTimer?.id || companionFocusTimer?.completedAt !== message.focusTimer?.completedAt;
    companionFocus = !!message.focus; companionFocusTimer = message.focusTimer ?? null; companionRelationship = message.relationship ?? null;
    if(companionFocus&&currentBubbleState==='greeting')dismissBubble();
    companionSequence = message.sequence; companionLife = message.state; renderUI(); if (menuChanged) renderDrawerMenu(); return;
  }
  if(message.channel==='book_privacy'){
    if(message.characterId!==view.characterId||message.sessionId!==backendSessionId||typeof message.incognito!=='boolean')return;
    privacyPending=false;
    if(message.error){showToast(message.error);renderUI();return;}
    textRetries.delete(textRetryKey());turnReplyStyle='inherit';if($('reply-style'))$('reply-style').value='inherit';stylePreviewRequest=null;if($('reply-style-preview'))$('reply-style-preview').textContent='';desktopIncognito=message.incognito;chat.clear(view.characterId);$('text').value='';view.reply='';dismissBubble();renderUI();renderDrawerMenu();showToast(desktopIncognito?'本地无痕已开启：新内容不保存，非临时网页/项目归档会拒绝发送':'无痕上下文已释放，恢复普通聊天');return;
  }
  if (message.channel === 'backend_ready') {
    memoryBookMode = message.productMode === 'memory-book';desktopIncognito=!!message.incognito;privacyPending=false;
    // B03: the per-turn style never crosses characters; reset it whenever the bound role changes.
    if (turnReplyStyleCharacter !== message.characterId || backendSessionId !== message.sessionId) {
      turnReplyStyleCharacter = message.characterId; turnReplyStyle = 'inherit';clearTimeout(stylePreviewTimer);stylePreviewRequest=null;if($('reply-style-preview'))$('reply-style-preview').textContent='';
      const styleSelect = $('reply-style'); if (styleSelect) styleSelect.value = 'inherit';
    }
    document.documentElement.classList.toggle('memory-book-mode', memoryBookMode);
    $('full-chat').hidden = !memoryBookMode;
    if (memoryBookMode) { bookTakeoverReady=false; }
    // RWR-08 (F02): admission of the running role is the backend registry's decision; the shell only
    // checks the wire shape. `isProductCharacter` (companion-only) refused a legitimately promoted
    // role-b before the view could ever bind it.
    if (message.bridgeVersion !== DESKTOP_BRIDGE_VERSION || !isCharacterId(message.characterId) || typeof message.sessionId !== 'string' || !message.sessionId) {
      connectionChanged({ generation, state: 'failed', reason: 'version' });
      native('shell', { type: 'disconnect', generation }); return;
    }
    const bookRoleRefresh = memoryBookMode && connection.connected && message.sessionId === backendSessionId;
    if (memoryBookMode && message.backendInstanceId && message.backendInstanceId !== bookBackendInstanceId) {
      bookBackendInstanceId=message.backendInstanceId; view.beginBackend(); workSpeechView.beginBackend();
    } else if (bookRoleRefresh && message.characterId === view.characterId && bookBackendInstanceId) {
      runningRoleLabel=message.characterLabel || runningRoleLabel;if(message.characterId==='aika'&&/^(Aika|AIKI)$/i.test(runningRoleLabel))runningRoleLabel='ALLMIND'; renderUI(); return;
    }
    if(memoryBookMode && message.characterId!==view.characterId){
      localPetAction=null;localPetActivity=null;localPetEnvironment=null;localPetChase=false;localPetMotionMode=null;
      stopCompanionAnimation();
      companionLife=null;companionDelivery=null;companionRelationship=null;companionFocus=false;companionFocusTimer=null;companionSequence=0;dismissBubble();
      view.beginBackend();workSpeechView.beginBackend();view.bindCharacter(message.characterId);workSpeechView.bindCharacter(message.characterId);
    }
    if (memoryBookMode && Number.isFinite(message.replyBudgetMs)) thinkingTimeout.timeoutMs=Math.min(600000,Math.max(40000,message.replyBudgetMs+5000));
    if (message.characterId !== view.characterId) { companionLife = null;companionDelivery=null; }
    if (!bookRoleRefresh && !connection.ready(generation)) return;
    wake.disconnect();wakeRequestId=null;
    captureFeedback.stop();
    awaitingTextTurn = false;clearWorkSpeech();spokenNotices.clear();workSpeechBlocked=false;inputFocusEpoch=0;interactionFocusEpoch=0;routeFocusEpoch=0; inputScope=null;awaitingTranscript=false;work.reset(); companionRoute=null; textRequestId=null;
    presentationPolicy=null;applyPresentationPolicy();
    introduction = null; introductionEpoch++; introductionFramePending = false; captureAllowed = false;
    void stopPlayback(); stopCapture(); renderer?.reset();
    if(message.characterId!==view.characterId||message.sessionId!==backendSessionId)resetThinking();
    backendSessionId=message.sessionId;view.setSession(message.characterId, message.sessionId);workSpeechView.setSession(message.characterId,message.sessionId);
    // RUX-04: an appearanceless backend (offline preview) never delivers a character model. The
    // canvas stays empty ON PURPOSE — no default model is preloaded — so the empty state is named
    // in the drawer status line instead of a loading text that never resolves. A real backend
    // arms a bounded watchdog and delivers the appearance of the character it selected.
    previewAppearanceless = message.appearanceless === true;
    appearanceReady = false; appearanceFailure = null; clearAppearanceWatchdog();
    if (!previewAppearanceless) {
      // Bounded watchdog: a connected backend that never delivers an appearance surfaces an honest
      // drawer state (toast + status + open panel) instead of an invisible wait. Chat still works.
      // With the host-remembered model already on screen the missing fresh appearance stays a
      // diagnostic — nothing is pressed over the visible character.
      appearanceWatchdog = setTimeout(() => {
        appearanceWatchdog = null;
        if (appearanceReady || previewAppearanceless || !connection.current(generation) || !connection.connected) return;
        if (renderer) { report({ type: 'appearance-watchdog-fired', shown: 'host-remembered-appearance' }); return; }
        noteAppearanceFailure('backend did not deliver an appearance');
        panel(true);
        renderUI();
      }, 60000);
    }
    // TASK-EDIT-01: the editor buffer is bound to this backend context (character+session generation);
    // a new session releases any open buffer so a stale draft can never hang on a new card.
    work.setEditorContext({ characterId: message.characterId, generation });
    // RWR-10-03: a NEW backend session starts an empty visible conversation. The per-role draft is
    // preserved (and restored into the composer just below). Re-entering the SAME session is idempotent, so
    // a duplicate `backend_ready` cannot wipe the rows the user is currently reading.
    chat.beginSession(message.characterId, message.sessionId);
    // RWR-08 (E1/F02): bind the card title / labels / placeholder to the REAL running role.
    runningRoleLabel = typeof message.characterLabel === 'string' && message.characterLabel.trim() ? message.characterLabel : '';if(memoryBookMode&&message.characterId==='aika'&&/^(Aika|AIKI)$/i.test(runningRoleLabel))runningRoleLabel='ALLMIND';
    if (message.introduction && typeof message.introduction.id === 'string' && message.introduction.id && typeof message.introduction.text === 'string' && message.introduction.text.trim()) introduction = { ...message.introduction, generation, acknowledged: false };
    $('text').value = chat.draft(view.characterId);previewReplyStyle(); renderUI();
    report({ type: message.channel, characterId: message.characterId, bridgeVersion: DESKTOP_BRIDGE_VERSION }); return;
  }
  if(message.channel==='wake_control'){if(!connection.connected)return;wake.control(message);return;}
  if(message.channel==='wake_result'){if(!connection.connected)return;wake.result(message);return;}
  if(message.channel==='wake_error'){if(!connection.connected)return;wake.error(message);return;}
  if (message.channel === 'backend_closed') { connectionChanged({ generation, state: 'disconnected' }); return; }
  if (!connection.connected) return;
  if(message.channel==='work_state') { if(work.receive(message.state)){markVisibleWork();if(message.state.focus==='work')restoreSelectedSource();renderUI();} return; }
  if(message.channel==='work_speech'){
    const e=message.event;
    if(!e||!e.scope||e.scope.sessionId!==backendSessionId||!isCharacterId(e.scope.characterId)||e.scope.characterId!==workSpeechView.characterId||!Number.isSafeInteger(e.inputEpoch)||e.inputEpoch!==inputFocusEpoch||typeof e.noticeId!=='string')return;
    if(e.state==='end'){if(workNotice?.noticeId===e.noticeId&&scopeEquals(workNotice.scope,e.scope)){if(playback.busy&&scopeEquals(playback.scope,e.scope))workNotice.ending=true;else clearWorkSpeech();}return;}
    if(e.state!=='start'||spokenNotices.has(e.noticeId)||workSpeechBlocked||voicePhase!=='idle'||capturing||awaitingTextTurn||['thinking','speaking','listening'].includes(view.state))return;
    clearWorkSpeech();spokenNotices.add(e.noticeId);workNotice={noticeId:e.noticeId,scope:e.scope,ending:false,workBinding:e.workBinding?structuredClone(e.workBinding):undefined};workSpeechView.scope=e.scope;renderUI();return;
  }
  if(message.channel==='input_route') {
    if(!view.accepts(message.scope)||!['companion','work'].includes(message.route))return;
    chat.route(message.scope,message.route);
    if(message.route==='work'){companionRoute=null;awaitingTextTurn=false;if(routeFocusEpoch===interactionFocusEpoch)work.routedWork();markVisibleWork();restoreSelectedSource();view.reset();renderer?.reset();}
    else {companionRoute=message.scope;work.input();}
    renderUI(); return;
  }
  if(message.channel==='presentation_policy'){
    const p=message.policy;
    if(!p||typeof p.modelId!=='string'||!Number.isSafeInteger(p.revision)||p.revision<0||!Array.isArray(p.enabledIds)||p.enabledIds.some(id=>typeof id!=='string'))return;
    if(presentationPolicy?.modelId===p.modelId&&p.revision<=presentationPolicy.revision)return;
    presentationPolicy=structuredClone(p);applyPresentationPolicy();return;
  }
  if (message.channel === 'event') {
    const e = message.event;
    if(e.type==='turn'&&e.input.kind==='text'&&((!textRequestId||e.input.clientRequestId!==textRequestId)&&!invitationTextPending&&e.input.provenance?.kind!=='companion-trigger')){report({type:'book-turn-rejected',reason:'request-identity',turnId:e.input.scope?.turnId});return;}
    if(e.type==='reply'&&!scopeEquals(companionRoute,e.reply.scope)&&e.provenance?.kind!=='companion-trigger'){report({type:'book-turn-rejected',reason:'reply-route',turnId:e.reply.scope?.turnId});return;}
    if (e.type === 'turn' && e.input.kind === 'voice' && !(invitationPending && !e.input.clientRequestId) && (!voiceRequestId || e.input.clientRequestId !== voiceRequestId)) return;
    // Work presentation may reset before a late ASR event; input identity is independent.
    const accepted = e.type==='transcript' ? scopeEquals(inputScope,e.scope) : view.receive(e);
    if(memoryBookMode&&['turn','reply','error'].includes(e.type))report({type:'book-turn-event',event:e.type,accepted,turnId:e.input?.scope?.turnId ?? e.reply?.scope?.turnId ?? e.scope?.turnId});
    if(accepted&&e.type==='invitation'){
      if(view.invitation?.status==='shown')invitationAutoDismiss.schedule(view.invitation.id,view.invitation.expiresAt);
      else cancelInvitationAutoDismiss();
    }
    if(accepted&&e.type==='turn')cancelInvitationAutoDismiss();
    if(accepted&&e.type==='turn')inputScope=e.input.scope;
    if(accepted&&e.type==='transcript'&&!e.interim)awaitingTranscript=false;
    if(accepted&&e.type==='error'){captureFeedback.stop();inputScope=null;awaitingTranscript=false;}
    if (accepted && ['turn', 'error'].includes(e.type)) awaitingTextTurn = false;
    if (accepted && e.type === 'turn') {
      if (e.input.provenance?.kind === 'companion-trigger') { companionRoute = e.input.scope; invitationTextPending = false; }
      else if (e.input.kind === 'text') { chat.acknowledge(e.input.scope, true); invitationTextPending = false; }
      else chat.bindVoice(e.input.scope);
    }
    if (accepted && e.type === 'transcript') { if (e.interim) chat.interim(e.scope, e.text); else chat.transcript(e.scope, e.text); }
    if (accepted && e.type === 'reply' && scopeEquals(companionRoute,e.reply.scope)) {
      if(memoryBookMode&&['happy','neutral'].includes(e.reply.expression?.emotion))companionDelivery={emotion:e.reply.expression.emotion,until:Date.now()+4000};
      stopThinking();
      showBubble(e.reply.text, 'speaking');
      chat.reply(e.reply.scope, e.reply.text,e.reply.attachmentCount);
      if(memoryBookMode){
        const lengthNotice=replyLengthNotice(e.reply.replyLength);
        const styleNotice=e.reply.replyStyleDecision?`本轮风格：${replyStyleSummary(e.reply.replyStyleDecision)}`:'';
        if(styleNotice||lengthNotice)showToast([styleNotice,lengthNotice].filter(Boolean).join(' · '));
        textRetries.delete(textRetryKey());turnReplyStyle='inherit';previewReplyStyle(); const styleSelect=$('reply-style'); if(styleSelect)styleSelect.value='inherit';
      }
      if(memoryBookMode)textRequestId=null;
    }
    if (accepted && e.type === 'error') {
      if(memoryBookMode)textRequestId=null;
      stopThinking();
      showBubble(e.message || '这一轮没有完成，请稍后再试～', 'error', 6000);
      hold.clear(); voiceRequestId = null; invitationPending = false; invitationTextPending = false; chat.cancelVoice(view.characterId); chat.failPending(view.characterId);restoreTextRetry();if(memoryBookMode)textRetries.delete(textRetryKey());
    }
    if (accepted && (e.type === 'error' || e.type === 'presentation' && e.presentation.state === 'error')) { captureFeedback.stop();void stopPlayback(); stopCapture(); renderer?.reset(); }
    if (accepted && e.type === 'turn') { if (playback.scope && !scopeEquals(playback.scope, e.input.scope)) void stopPlayback(); if (capturing && !scopeEquals(capturing.scope, e.input.scope)) stopCapture(); renderer?.reset({ preserveAttention: e.input.kind === 'voice' }); }
    if (accepted) renderUI();
    if (accepted && e.type === 'reply' && e.provenance?.kind === 'companion-trigger') {
      send({ channel: 'command', command: { type: 'acknowledge_companion_reply', triggerId: e.provenance.triggerId, scope: e.reply.scope } }, generation);
    }
    return;
  }
  try {
    if (message.channel === 'stop' || message.channel === 'capture_stop') {
      if (message.channel === 'stop') await stopPlayback(message.scope); else stopCapture(message.scope);
      send({ channel: 'ack', requestId: message.requestId }, generation); return;
    }
    if (message.channel === 'play') {
      const isWorkSpeech=workNotice&&!workNotice.ending&&scopeEquals(workNotice.scope,message.tts.scope);
      if(!scopeEquals(companionRoute,message.tts.scope)&&!isWorkSpeech||isWorkSpeech&&workNotice.playRequestId&&workNotice.playRequestId!==message.requestId){message.audioBase64='';send({channel:'playback',requestId:message.requestId,event:{type:'stopped',scope:message.tts.scope,at:new Date().toISOString()}});return;}
      if(isWorkSpeech)workNotice.playRequestId=message.requestId;
      if(isWorkSpeech)workSpeechView.expression=message.tts.expression??workSpeechView.expression;
      const bytes = bytesFromBase64(message.audioBase64); message.audioBase64 = '';
      await playback.play(message.requestId, message.tts, bytes);
      return;
    }
    if (message.channel === 'voice_frame') { answerVoiceFrame(message, generation); return; }
    if (message.channel === 'capture_start') {
      if (!captureAllowed || !view.accepts(message.scope)) throw new Error('录音仅能由当前主动语音轮次打开');
      const fromWake=wakeRequestId!==null&&wakeRequestId===voiceRequestId;
      if(fromWake&&!wake.pendingCapture){if(capturing?.wake&&capturing.session&&scopeEquals(capturing.scope,message.scope)){send({channel:'ack',requestId:message.requestId},generation);return;}throw new Error('唤醒录音已取消');}
      stopCapture(); voicePhase = 'preparing';
      const active = { scope: message.scope, controller: new AbortController(),feedbackToken:captureFeedbackToken,wake:fromWake,frameIndex:0 }; capturing = active;
      pcmFrames.reset();voiceFrames.reset();
      const driver = new BrowserCaptureDriver({ workletModuleUrl: new URL('./recorder-worklet.js', import.meta.url), cameraWidth: 640, jpegQuality: .8, maxBufferedSamples: 12000000,
        // FIX61-10 (FIX61-07 07-C): the conversation records from the machine-local microphone choice,
        // the same device the mic test validated. null keeps the system default; an exact id that has
        // disappeared fails loudly through the existing device-failure plane instead of switching mics.
        deviceId: microphoneTest?.selectedDeviceId() ?? null,
        // Live leg: every 2048-sample flush is framed here and kept for the backend's frame requests.
        voiceSink:block=>{for(const frame of pcmFrames.push(block)){voiceFrames.add(message.scope.turnId,active.frameIndex++,frame);}},
        onVoiceSinkError:()=>{if(capturing===active)report({type:'voice-sink-error'});},
        onLevel:level=>{if(capturing===active&&!active.controller.signal.aborted)captureFeedback.level(active.feedbackToken,level);}, onDiagnostic: event => {
        if(capturing===active){if(event.phase==='stopped')captureFeedback.stop(active.feedbackToken);report({type:'capture-timing',...event,requestElapsedMs:Math.max(0,performance.now()-voiceRequestAt)});}
      } });
      const opening=active.wake?Promise.resolve(wake.takeCapture()):driver.open(active.controller.signal);renderUI();
      active.session = await opening;
      if (capturing !== active) { active.session.stop(); throw new Error('录音轮次已取消'); }
      voicePhase = 'recording'; hold.ready(); renderUI();
      send({ channel: 'ack', requestId: message.requestId }, generation);if(active.wake)wake.captureReady(); report({ type: 'capture-ready' }); return;
    }
    if (message.channel === 'capture_finish') {
      const active = capturing;
      if (!active?.session || !scopeEquals(active.scope, message.scope)) throw new Error('没有本轮已就绪的录音');
      if(!active.wake)captureFeedback.stop(active.feedbackToken);
      const inputEndedAt = active.inputEndedAt ?? new Date().toISOString();
      const value = await active.session.finish();
      try {
        if (capturing !== active) throw new Error('采集结果已失效');
        send({ channel: 'capture', requestId: message.requestId, result: { scope: active.scope, audio: { id: crypto.randomUUID(), mimeType: 'audio/wav', base64: base64(value.audio) }, images: value.images.map(i => ({ id: crypto.randomUUID(), mimeType: i.mimeType, base64: base64(i.bytes) })), inputEndedAt, captureStoppedAt: value.captureStoppedAt } }, generation);
        capturing = null; voicePhase = 'idle'; renderUI(); report({ type: 'capture-finished', inputEndedAt, captureStoppedAt: value.captureStoppedAt });
      } finally { value.audio.fill(0); value.images.forEach(i => i.bytes.fill(0)); }
    }
  } catch (error) {
    const failure = toDeviceFailure(error), text = deviceFailureMessage(failure), scope = message.scope ?? message.tts?.scope;
    if (connection.current(generation) && message.channel.startsWith('capture') && scope && view.accepts(scope)) {
      stopCapture(scope); captureAllowed = false; hold.clear(); voiceRequestId = null; invitationPending = false;
      inputScope=null;awaitingTranscript=false;chat.cancelVoice(view.characterId); view.receive({ type: 'error', scope, message: text }); renderUI();
    }
    send({ channel: 'rpc_error', requestId: message.requestId, ...(scope ? { scope } : {}), error: failure, message: text }, generation);
  }
}
// FIX61-11 / FIX61-07: the mic test lives in this trusted renderer, not in the console page — there is no
// websocket/MCP channel, so a console-side getUserMedia would test the browser's device instead of the
// pet's. It is independent of the backend connection, so a failed backend still lets the user check
// whether the microphone itself works. Installed before petBridge is published so the shell's data
// directory delivery can reach it.
const microphoneTest = installMicrophoneTest({
  get: $,
  shell: value => native('shell', value),
  busy: () => !!capturing || voicePhase !== 'idle'
});
function micTestPanel(open) { microphoneTest?.open(open); }
window.petBridge = { receive, connectionChanged, hotkeyConfig, hotkeyEvent, displayConfig: value => { display.receive(value); positionResizeHandles(); }, managementResult,playCompanionInteraction,
  petEnvironment:value=>{
    if(typeof value.spatialEnabled==='boolean')localPetSpatial=value.spatialEnabled;
    if(value.placeholder){beginLocalPet(value.placeholder);showToast('已切换交互占位，具体动作由后续角色资源提供。');return;}
    if(typeof value.suspended==='boolean'){localPetSuspended=value.suspended;if(value.suspended)finishLocalPet(true);return;}
    if(value.error){report({type:'local-pet-source-error',message:value.error});showToast(value.error);return;}
    localPetEnvironment=value;
    if(value.completed==='jumping'){if(localPetAction?.kind==='jumping')finishLocalPet();return;}
    if(value.state==='gazing'&&localPetAction&&localPetAction.kind!=='gazing')return;
    if(['moving','chasing','docked','jumping','gazing'].includes(value.state)&&!companionPointerActive&&!panelOpen&&(!localPetAction||['moving','chasing','docked','jumping','gazing'].includes(localPetAction.kind))&&!(companionLife?.activity==='resting'&&value.state==='gazing'))beginLocalPet(value.state);
  },
  // RUX-04: the host's remembered appearance for the load period (see restoreCachedAppearance).
  cachedAppearance: restoreCachedAppearance,
  // RWR-10-01: the host owns replySound and reports the effective value; the renderer only applies it.
  replySoundPreference: enabled => applyReplySound(enabled),
  desktopVisibility: visible => {
    companionHidden = !visible;
    send({channel:'companion_presence',hidden:!visible||document.hidden,dnd:companionLife?.quiet===true});
    if (!visible) { localGreetingPreviewToken++; dismissBubble(); void stopPlayback(); stopCapture(); }
  },
  localGreetingPreference: enabled => setLocalGreetingPreference(enabled, false),
  localGreetingLastShownAt: at => localGreeting.restoreLastShownAt(at),
  // FIX61-11: the shell owns the microphone preference file; it reports the stored device id here so the
  // renderer never needs a path (and never imports the Node-only preference store).
  microphonePreference: deviceId => microphoneTest?.setStoredDevice(deviceId),
  clickThroughChanged: ({ enabled }) => {
    clickThrough = enabled === true;
    window.__aikaClickThroughProbe = clickThrough;
    showToast(clickThrough ? '已开启鼠标穿透（快捷键 Ctrl+Shift+M 关闭）' : '已关闭鼠标穿透模式');
  },
  rightClickRestore: ({ x, y }) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const hit = document.elementFromPoint(x, y);
    if (hit?.closest?.('#character')) { pointerRouter.contextMenu({ target: { id: 'character' } }); panel(true); }
  } };
window.desktopHost?.subscribe((method, ...args) => window.petBridge[method]?.(...args));
$('speech-bubble')?.addEventListener('click', () => {
  dismissBubble();
  if ($('drawer')?.hidden) panel(true);
});
$('speech-bubble-close')?.addEventListener('click', e => { e.stopPropagation(); dismissBubble(); });
// RWR-10-02: the quit button moved into the 「⋯」 menu, so it is no longer bound here.
$('close').onclick = () => panel(false);
$('drawer-appearance')?.addEventListener('click',event=>{event.stopPropagation();closeDrawerMenu();toggleSizePanel();});
$('size-panel-close')?.addEventListener('click',()=>{display.setPanelOpen(false);$('drawer-appearance')?.setAttribute('aria-expanded','false');$('drawer-appearance')?.focus();publishInteractiveRegions();});
document.addEventListener('pointerdown',event=>{if(display.panelOpen&&!event.target.closest?.('#size-panel,#drawer-appearance')){display.setPanelOpen(false);$('drawer-appearance')?.setAttribute('aria-expanded','false');publishInteractiveRegions();}});
$('drawer-settings')?.addEventListener('click', event => { event.stopPropagation(); toggleDrawerMenu(); });
$('text').oninput = () => { localGreeting.markInteraction(); clearWorkSpeech();workSpeechBlocked=true;interactionFocusEpoch++; work.input(!!displayedWorkBinding()); chat.setDraft(view.characterId, $('text').value); fitComposer();previewReplyStyle(); };
$('text').oncompositionstart = () => { composing = true; };
$('text').oncompositionend = () => { composing = false; };
$('text').onkeydown = event => {
  if (event.key !== 'Enter') return;
  if (composing || event.isComposing || event.keyCode === 229) { event.preventDefault(); return; }
  if (!event.shiftKey) { event.preventDefault(); $('form').requestSubmit(); }
};
$('form').onsubmit = event => {
  event.preventDefault(); const text = $('text').value.trim();
  if (composing || event.isComposing || !text || !connection.connected || chat.pending(view.characterId) || memoryBookMode && (textRequestId||thinkingRequestId)) return;
  $('text').value = '';
  command({ type: 'submit_text', text, ...(turnReplyStyle !== 'inherit' ? { replyStyle: turnReplyStyle } : {}) });previewReplyStyle();
};
$('text').onfocus = () => report({ type: 'input-focus', active: document.activeElement === $('text') });
// B03: the composer's per-turn style only feeds the next submit; the backend receipt governs display.
$('reply-style')?.addEventListener('change', event => {
  const value = event.target.value;
  turnReplyStyle = value === 'short' || value === 'balanced' || value === 'detailed' ? value : 'inherit';previewReplyStyle();
});
// RWR-10-02: the ⋯ menu owns voice input; `#voice` only exists in older layouts, so bind when present.
$('voice')?.addEventListener('click', () => timedVoiceInput(performance.now(),'voice-button',()=>command({ type: voicePhase !== 'idle' ? 'finish_voice' : 'start_voice' })));
$('stop').onclick = () => command({ type: 'cancel' });
$('full-chat').onclick = () => {
  if(desktopIncognito){showToast('当前无痕聊天不进入完整聊天归档；请在本面板查看，退出无痕会释放。');return;}
  const scope = companionRoute;
  openConsole('/chat?' + new URLSearchParams({ characterId: view.characterId, sessionId: backendSessionId || 'desktop', ...(scope?.turnId ? { messageId: scope.turnId } : {}) }));
};
$('speech-bubble-text').onclick = () => { if (memoryBookMode) panel(true); };
$('invitation').onclick = () => { if (view.invitation) { const invitation = view.invitation, id = invitation.id; cancelInvitationAutoDismiss(id); view.invitation = null; panel(true);
  command({ type: 'click_invitation', invitationId: id }, invitation.actionKind === 'text' && invitation.responseText ? { invitationResponseText: invitation.responseText } : {}); } };
$('invitation-ignore').onclick = () => { if (view.invitation) { const id = view.invitation.id; cancelInvitationAutoDismiss(id); view.invitation = null; renderUI(); command({ type: 'ignore_invitation', invitationId: id }); } };
// FIX61-04 / RWR-10-02: a left short tap strokes locally and a left drag moves the window. The right
// button is now disabled: it only consumes its event (see pointer-router.ts) so no panel, drag or stroke
// happens and Chromium's system menu stays away. A stroke never sends a command, never writes Memory and
// never calls the model.
const pointerRouter = new CharacterPointerRouter({
  panel: () => {}, panelOpen: () => false,
  drag: (dx, dy) => native('shell', { type: 'drag', dx, dy }),
  dragEnd: () => native('shell', { type: 'drag_end' }),
  gesture:(kind,phase)=>{
    if(phase==='cancel'){finishLocalPet(true);return;}
    if(phase==='complete'){finishLocalPet();return;}
    beginLocalPet(kind);
  },
  stroke: at => {
    // Respect the display toggle and reduced-motion; a model without those parameters reports why.
    beginLocalPet('petting');
  }
});
$('character').onpointerdown = e => {
  // Bubble controls live inside the character. Capturing their pointer retargets the click to the
  // character, so neither expand nor close can fire. Only model gestures belong to this router.
  if (e.target.closest?.('#speech-bubble')) return;
  companionPointerActive = true;
  finishLocalPet(true);
  const rect=$('character').getBoundingClientRect();
  pointerRouter.pointerDown({pointerId:e.pointerId,button:e.button,screenX:e.screenX,screenY:e.screenY,timeStamp:e.timeStamp,region:e.clientY-rect.top<rect.height*.4?'head':'body'}); if(e.isTrusted)e.currentTarget.setPointerCapture(e.pointerId);
};
$('character').onpointermove = e => pointerRouter.pointerMove(e);
$('character').onpointercancel = $('character').onlostpointercapture = e => { companionPointerActive = false; pointerRouter.pointerCancel(e); };
$('character').onpointerup = e => { companionPointerActive = false; pointerRouter.pointerUp(e); };
$('character').oncontextmenu = e => { e.preventDefault(); pointerRouter.contextMenu(e); panel(true); };
// RWR-10-02: `view-full`/`view-half`/`model-size` are real in-frame controls again (they live in
// `#size-panel`), `model-resize` still exists as an optional drag handle, and `management` may exist for a
// legacy header button. Typing in any of these must not trigger press-to-talk.
const editing = target => ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName) || target?.isContentEditable || ['view-full', 'view-half', 'model-size-reset', 'model-resize', 'model-size', 'management'].includes(target?.id);
document.addEventListener('keydown', e => {
  const receivedAt=performance.now();
  if(e.key==='Tab'&&records.isOpen){records.tab(e);return;}
  if(e.key==='Escape'&&records.isOpen){e.preventDefault();e.stopPropagation();records.close();return;}
  if (e.key === 'Escape' && display.cancel(e)) return;
  if(e.key==='Escape'&&display.panelOpen){e.preventDefault();display.setPanelOpen(false);$('drawer-appearance')?.setAttribute('aria-expanded','false');$('drawer-appearance')?.focus();publishInteractiveRegions();return;}
  if (bindingKey || composing || e.isComposing || e.keyCode === 229) return;
  if (!editing(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey && timedVoiceInput(receivedAt,'keyboard',()=>hold.down(e.code,e.repeat))) { e.preventDefault(); e.stopPropagation(); return; }
  if (e.key === 'Escape') {
    // Topmost first: an in-flight window resize (RUX-08) is the most modal gesture — cancelling it
    // restores the saved drawer size without touching the chat or the menu behind it.
    if (cancelDrawerResize()) { e.preventDefault(); return; }
    // Then: a test session is the most modal peer view, then the ⋯ menu, then the size panel.
    if (microphoneTest?.isOpen()) { e.preventDefault(); micTestPanel(false); return; }
    if (drawerMenuOpen) { e.preventDefault(); closeDrawerMenu(); return; }
    if (display.panelOpen) { e.preventDefault(); display.setPanelOpen(false); renderDrawerMenu(); return; }
    if (playback.busy || capturing || voicePhase !== 'idle' || view.scope) command({ type: 'cancel' }); else panel(false);
  }
}, true);
document.addEventListener('keyup', e => { if (hold.up(e.code)) { e.preventDefault(); e.stopPropagation(); } }, true);
document.addEventListener('focusin', e => { if (editing(e.target)) hold.cancel(); });
window.addEventListener('blur', () => { cancelDrawerResize(); hold.cancel(); display.cancel(); companionPointerActive=false;pointerRouter.pointerCancel();finishLocalPet(true); });
document.addEventListener('visibilitychange', () => { localGreeting.markInteraction(); introductionEpoch++; introductionFramePending = false; if (document.hidden) { hold.cancel(); display.cancel(); pointerRouter.pointerCancel(); } else scheduleIntroductionAck(); });
window.addEventListener('pagehide', () => { display.cancel(); void microphoneTest?.close(); connectionChanged({ generation: connection.generation, state: 'disconnected' }); void stopPlayback(); stopCapture(); renderer?.dispose(); });
window.addEventListener('error', e => report({ type: 'script-error', message: e.message }));
window.addEventListener('unhandledrejection', e => report({ type: 'promise-error', message: String(e.reason) }));
document.addEventListener('pointerdown', () => localGreeting.markInteraction(), true);
setInterval(() => {
  if (!localGreetingEnabled || document.hidden || companionHidden || companionLife?.quiet) return;
  const decision = localGreeting.tick({ visible: true, busy: localGreetingBusy() });
  if (!decision) return;
  native('shell', { type: 'local_greeting_shown', occurredAt: decision.occurredAt });
  showBubble(decision.text, 'greeting', 8000);
  renderUI();
}, 30000);
renderUI(); native('shell', { type: 'ready' });
setInterval(() => sendPresence(true), 1_000);
installRegionTracking();
installDrawerResize();
let frame = 0, lastRender = 0;
// RUX-04 (user direction, 2026-10-10): NO fixed default model is preloaded here — `new JellyfishRenderer`
// must never run against the startup canvas with a built-in path. The load period shows the LAST
// SHOWN character instead: the host republishes the remembered appearance (restoreCachedAppearance,
// delivered on page ready), and the backend's `appearance` handler swaps in the authoritative model.
// The animation loop simply idles while no renderer exists.
function animate(at) {
  requestAnimationFrame(animate);
  if (at - lastRender <= 32) return;
  if (view.expireInvitation(Date.now())) renderUI();
  const shown = workSpeechView.state === 'speaking' ? workSpeechView : view;
  const petInterrupted=!connection.connected||localPetSuspended||companionHidden||document.hidden||companionFocus||companionLife?.quiet||!companionLife?.enabled||['listening','thinking','speaking'].includes(shown.state);
  const petReducedMotion=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const mode=petInterrupted||petReducedMotion||companionPointerActive||panelOpen||localPetAction&&['petting','dragging','feeding','gifting','playing'].includes(localPetAction.kind)?'stop':localPetChase&&localPetAvailable('chasing')?'chase':['docked','jumping'].includes(localPetEnvironment?.state)?'stop':companionLife?.activity==='walking'&&localPetAvailable('moving')?'walk':'stop';
  if(mode!==localPetMotionMode){localPetMotionMode=mode;native('shell',{type:'pet_motion',mode});}
  if(localPetAction){
    // A held gesture ends on release/cancel, never on an absent animation callback.
    if(companionPointerActive&&!petInterrupted)localPetAction.until=Date.now()+1200;
    const result=advancePetAction(localPetAction,Date.now(),petInterrupted);
    if(result.completed)finishLocalPet();else if(result.cancelled)finishLocalPet(true);else localPetAction=result.active;
  }
  const local = memoryBookMode ? arbitrateCompanionPresentation(shown, companionLife, Date.now(),
    { hidden: companionHidden || document.hidden, interacting: panelOpen, focused: companionFocus,action:localPetAction, ...(companionDelivery?{delivery:companionDelivery}:{}),...(companionRelationship?{relationship:companionRelationship}:{}) }) : null;
  if(companionAnimation&&(!interactionPlayable(!!companionAnimation.manual)||Date.now()>=companionAnimation.until))stopCompanionAnimation();
  const interaction=companionAnimation?.ready?companionAnimation:null;
  const state = interaction?(interaction.target.kind==='sprite'?interaction.target.targetId:'idle'):local?.characterState ?? characterState.update(shown, voicePhase === 'preparing' ? 'listening' : shown.state, work.focused && shown === view && ['idle','error'].includes(shown.state));
  companionPresentation = local;
  const canvas = $('model');
  if (canvas && local) {
    canvas.dataset.localActivity = local.localActivity;
    const reduced=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    canvas.style.transform = interaction||reduced?'':['touch','petting','feeding'].includes(local.localActivity) ? 'scale(1.03)' : '';
  }
  renderer?.updateView({ ...(local ?? shown), characterState: state,localGaze:!petInterrupted&&local?.localActivity==='gazing'?localPetEnvironment?.cursor:null }, state, state === 'working');
  if(interaction?.resolve){const snapshot=renderer.snapshot();if(snapshot.interactionTarget===interaction.target.targetId){clearTimeout(interaction.timer);const resolve=interaction.resolve;interaction.resolve=null;interaction.reject=null;resolve(snapshot);}}
  lastRender = at; frame++;
}
requestAnimationFrame(animate);
// Read-only probe for the Windows acceptance: which visual owns the load period.
window.__aikaAppearanceProbe = () => ({ startupAppearanceRestored, appearanceReady, previewAppearanceless, hasRenderer: !!renderer });
window.__aikaThinkingProbe=()=>({pending:!!thinkingRequestId,memoryBookMode,connected:connection.connected,generation:connection.generation,sendDisabled:$('send').disabled,formula:!connection.connected||chat.pending(view.characterId)||(memoryBookMode&&(!!textRequestId||!!thinkingRequestId))});
window.__aikaCompanionProbe = () => ({ life: companionLife, presentation: companionPresentation, hidden: companionHidden, focus: companionFocus,
  appearanceRequestId:companionAppearanceRequestId,
  localAction:localPetAction,chasing:localPetChase,spatialEnabled:localPetSpatial,transitions:localPetTransitions,activity:localPetActivity,
  frames: frame, renderer: renderer?.snapshot(), capabilities: companionCapabilityNotes, muted: !playback.soundEnabled,
  connectionGeneration: connection.generation, connected: connection.connected });
// Bounded telemetry of model parameters only, never transcript/audio/frame contents.
let lastTrace = 0;
setInterval(() => { if (playback.busy && renderer?.ready && performance.now() - lastTrace > 700) { lastTrace = performance.now(); report({ type: 'speaking-parameters', ...renderer.snapshot() }); } }, 500);
