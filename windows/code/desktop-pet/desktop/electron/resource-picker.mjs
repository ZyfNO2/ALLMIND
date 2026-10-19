import { basename, dirname, resolve } from 'node:path';
import { HOST_SPRITE_EXTENSIONS, isHostSpriteFile } from './host-preferences.ts';

/** Deduplicate only while the native chooser is open; every later click opens it again. */
export function createResourcePicker({ dialog, getWindow, scanModelEntries, archiveEntries }) {
  const inFlight = new Map();
  async function open(params) {
    const isSprite = params.type === 'sprite', wantsDirectory = params.selectionKind === 'directory', wantsArchive = params.selectionKind === 'archive';
    const options = {
      title: isSprite ? '选择精灵图（PNG / WebP）' : wantsDirectory ? '选择 Live2D 模型包目录' : wantsArchive ? '选择 Live2D ZIP 模型包' : '选择模型入口文件（.model3.json）',
      properties: wantsDirectory ? ['openDirectory'] : ['openFile'],
      filters: isSprite ? [{ name: '精灵图', extensions: HOST_SPRITE_EXTENSIONS.map(extension => extension.replace('.', '')) }]
        : wantsDirectory ? [] : [{ name: wantsArchive ? 'Live2D ZIP 模型包' : 'Live2D 模型入口', extensions: [wantsArchive ? 'zip' : 'json'] }],
    };
    const win = getWindow();
    const result = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const picked = Array.isArray(result?.filePaths) ? result.filePaths[0] : undefined;
    if (result?.canceled) return { outcome: 'cancelled' };
    if (!picked) throw Error('系统选择窗口没有返回选中的资源。');
    const source = resolve(picked), displayName = basename(source);
    if (isSprite) {
      if (!isHostSpriteFile(source)) throw Error('请选择 PNG 或 WebP 精灵图。');
      return { outcome: 'selected', source, root: dirname(source), displayName, entries: [] };
    }
    if (wantsArchive && !source.toLowerCase().endsWith('.zip')) throw Error('请选择 ZIP 模型包。');
    if (!wantsDirectory && !wantsArchive && !source.toLowerCase().endsWith('.model3.json')) throw Error('请选择 .model3.json 模型入口。');
    const root = wantsDirectory ? source : dirname(source);
    const entries = wantsArchive ? await archiveEntries(source) : wantsDirectory ? await scanModelEntries(root)
      : [{ entry: basename(source), label: basename(source) }];
    if (!entries.length) throw Error('选中的资源中没有找到 .model3.json 模型入口。');
    return { outcome: 'selected', source, root: wantsArchive ? source : root, displayName, entries };
  }
  return function select(params) {
    const key = `${params.characterId ?? ''}|${params.type}|${params.selectionKind}`;
    if (!inFlight.has(key)) inFlight.set(key, open(params).finally(() => inFlight.delete(key)));
    return inFlight.get(key);
  };
}
