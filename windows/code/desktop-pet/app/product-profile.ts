import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {appRoot,installedModules,moduleStates} from './module-runtime.js';
/** Static product combinations. A switch does not remove code from a package; the packager's closure does. */
export type ProductProfileId = 'full' | 'desktop-lite' | 'desktop-astrbot' | 'server-core';

export interface ProductModules {
  voice: boolean;
  screen: boolean;
  qqDirect: boolean;
  tools: boolean;
  astrbot: boolean;
  gptText: boolean;
}

export interface ProductProfile {
  id: ProductProfileId;
  modules: ProductModules;
  /** Basenames of dynamically loaded modules left out of this package. */
  omitDynamic: readonly string[];
  moduleStates?:Record<string,{installed:boolean;enabled:boolean}>;
}

const heavy = [
  'book-voice.js',
  'book-screen.js',
  'qq-channel-manager.js',
  'qq-channel-service.js',
  'onebot-qq.js',
  'napcat-host.js',
  'book-tools.js',
  'windows-book-speech.js',
  'windows-book-ocr.js',
  'sapi-tts.js',
] as const;

const astrbotModules = ['allmind-capabilities.js', 'astrbot-connector.js', 'astrbot-chat.js', 'astrbot-management.js'] as const;

export const PROFILES: Record<ProductProfileId, ProductProfile> = {
  full: {
    id: 'full',
    modules: {voice: true, screen: true, qqDirect: true, tools: true, astrbot: false, gptText: true},
    omitDynamic: [],
  },
  'server-core': {id:'server-core',modules:{voice:false,screen:false,qqDirect:false,tools:false,astrbot:true,gptText:false},omitDynamic:[...heavy]},
  'desktop-lite': {
    id: 'desktop-lite',
    modules: {voice: false, screen: false, qqDirect: false, tools: false, astrbot: false, gptText: true},
    omitDynamic: [...heavy, ...astrbotModules],
  },
  'desktop-astrbot': {
    id: 'desktop-astrbot',
    modules: {voice: false, screen: false, qqDirect: false, tools: false, astrbot: true, gptText: true},
    omitDynamic: [...heavy],
  },
};

export function resolveProductProfile(env: NodeJS.ProcessEnv = process.env): ProductProfile {
  const file=join(appRoot,'product-profile.json');
  const raw = env.ALLMIND_PROFILE ?? (existsSync(file)?JSON.parse(readFileSync(file,'utf8')).id:'full');
  if (!Object.hasOwn(PROFILES, raw)) throw new Error('未知 ALLMIND_PROFILE：' + raw);
  const base=PROFILES[raw as ProductProfileId];
  const addons=installedModules();
  const states=moduleStates(addons);
  for(const id of ['voice','screen','tools'] as const)if(base.modules[id])states[id]={installed:true,enabled:true};
  return {...base,moduleStates:states,modules:{...base.modules,...Object.fromEntries(Object.keys(addons).map(id=>[id,true]))}};
}
