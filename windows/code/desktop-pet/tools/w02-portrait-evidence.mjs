import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PortraitStore } from '../dist/management/portrait-store.js';
import { SkinStore } from '../dist/management/skin-store.js';

const root = resolve(import.meta.dirname, '../../../../docs/next/chatgpt-integration/wiki-handoff/inputs/w02-allmind');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const checks = [];
for (const asset of manifest.assets) {
  const bytes = readFileSync(join(root, asset.file));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  checks.push({ file: asset.file, sha256, matches: sha256 === asset.sha256 && bytes.length === asset.bytes });
}
if (checks.some(item => !item.matches)) throw Error('原件哈希与归档 manifest 不一致');
const scratch = mkdtempSync(join(tmpdir(), 'w02-portraits-'));
const skins = await SkinStore.open(join(scratch, 'skins.json'), join(scratch, 'packs'), resolve(import.meta.dirname, '../desktop'));
const portraits = await PortraitStore.open(join(scratch, 'portraits.json'), skins);
const characterId = 'w02-synthetic';
let revision = 0;
const imported = [];
for (const [index, file] of ['portrait-01-original.png', 'portrait-02-original.png'].entries()) {
  const set = await portraits.add({ characterId, name: index === 0 ? '坐姿' : '站姿', file: join(root, file), origin: 'user_supplied', operationId: `import-${index + 1}`, expectedRevision: revision, currentSkinId: skins.state().activeSkinId });
  revision = set.revision;
  imported.push(set.variants.at(-1));
}
const selected = await portraits.select(characterId, imported[0].id, revision, 'select-default');
const before = skins.state().activeSkinId;
const report = { characterId, isolated: true, activatedLiveSkin: skins.state().activeSkinId !== before, framing: selected.framing, checks, variants: selected.variants.map(item => { const sprite = skins.describe(item.skinId).sprite; return { id: item.id, name: item.name, skinId: item.skinId, origin: item.origin, width: sprite?.width ?? null, height: sprite?.height ?? null, contentBounds: sprite?.contentBounds ?? null, alpha: sprite?.alpha ?? null }; }), selectedVariantId: selected.selectedVariantId, liveActiveSkinId: skins.state().activeSkinId };
const evidence = resolve(import.meta.dirname, '../../../../docs/next/chatgpt-integration/wiki-handoff/evidence/w02');
mkdirSync(evidence, { recursive: true });
writeFileSync(join(evidence, 'portrait-import.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ selected: report.selectedVariantId, variants: report.variants.map(item => ({ name: item.name, alpha: item.alpha, bounds: item.contentBounds })) }));
rmSync(scratch, { recursive: true, force: true });
