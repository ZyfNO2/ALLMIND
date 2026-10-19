import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
/** Build fixed local routes from the trusted installed manifest. Never resolve a requested path. */
export async function presentationAssetRoutes(projectRoot: string): Promise<ReadonlyMap<string, string>> {
  const desktop = resolve(projectRoot, 'code/desktop-pet/desktop'), base = resolve(desktop, 'assets/local-model');
  const routes = new Map<string, string>();
  routes.set('/preview-runtime/presentation-preview.js', resolve(desktop, '../management/preview-runtime/presentation-preview.js'));
  if (!existsSync(base)) {
    process.stderr.write('ALLMIND: 私人 Live2D 默认模型未安装，不注册其预览路由；静态立绘预览可用。\n');
    return routes;
  }
  const refs = JSON.parse(await readFile(resolve(base, 'pet.model3.json'), 'utf8')).FileReferences;
  const paths: string[] = ['pet.model3.json', 'presets.json', refs.Moc, refs.Physics, refs.DisplayInfo, ...refs.Textures,
    ...refs.Expressions.map((x: { File: string }) => x.File), ...Object.values(refs.Motions as Record<string, { File: string }[]>).flat().map(x => x.File)];
  for (const path of new Set(paths.filter(Boolean))) {
    if (path.startsWith('/') || /[:%\\]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid installed model path');
    routes.set('/presentation-assets/' + path, resolve(base, path));
  }
  const shaderBase = resolve(desktop, 'vendor/cubism/Framework/Shaders/WebGL');
  for (const file of await readdir(shaderBase)) if (/^[a-zA-Z0-9_.-]+\.(frag|vert)$/.test(file)) routes.set('/presentation-shaders/' + file, resolve(shaderBase, file));
  routes.set('/presentation-runtime/core.js', resolve(desktop, 'vendor/cubism/Core/live2dcubismcore.min.js'));
  // LUI-05: the shared Cubism/Sprite preview bundle. It is a build product of
  // `desktop/build-presentation-preview.mjs` and is served from a fixed same-origin route instead of
  // from the retired `management/ui/` directory, so retiring that directory cannot delete a module the
  // React resource dialog still loads.
  routes.set('/preview-runtime/presentation-preview.js', resolve(desktop, '../management/preview-runtime/presentation-preview.js'));
  return routes;
}
