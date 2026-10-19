#!/usr/bin/env node
/**
 * Build the optional local Windows.Media.Ocr helper.
 * Without MSVC + the Windows SDK, the product remains buildable and reports local OCR unavailable.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'desktop/ocr/windows-media-ocr-helper.cpp');
const outputDirectory = resolve(root, 'dist/ocr');
const outputBinary = join(outputDirectory, 'aika-windows-media-ocr.exe');
const buildDirectory = resolve(root, 'desktop/ocr/.build');
const candidateBinary = join(buildDirectory, 'windows-media-ocr-helper.exe');
const objectFile = join(buildDirectory, 'windows-media-ocr-helper.obj');
const manifestPath = join(outputDirectory, 'helper-build.json');
const maxInputBytes = 20 * 1024 * 1024;
const maxPixels = 40_000_000;
const maxOutputBytes = 1024 * 1024;

if (!existsSync(source)) {
  console.error(`Windows.Media.Ocr helper source is missing: ${source}`);
  process.exit(2);
}
if (process.platform !== 'win32') {
  console.log(`Windows.Media.Ocr helper is Windows-only; skipping on ${process.platform}.`);
  process.exit(0);
}

function findVcvars() {
  const candidates = [
    process.env.VSINSTALLDIR ? join(process.env.VSINSTALLDIR, 'VC/Auxiliary/Build/vcvars64.bat') : null,
    'C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Auxiliary/Build/vcvars64.bat',
    'C:/Program Files/Microsoft Visual Studio/2022/Professional/VC/Auxiliary/Build/vcvars64.bat',
    'C:/Program Files/Microsoft Visual Studio/2022/Enterprise/VC/Auxiliary/Build/vcvars64.bat',
    'C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Auxiliary/Build/vcvars64.bat',
  ].filter(Boolean);
  return candidates.find(path => existsSync(path)) ?? null;
}

const vcvars = findVcvars();
if (!vcvars) {
  console.warn('Windows.Media.Ocr helper not built: MSVC/Windows SDK not found; local OCR remains unavailable.');
  process.exit(0);
}

mkdirSync(outputDirectory, { recursive: true });
mkdirSync(buildDirectory, { recursive: true });
const command = `call "${vcvars}" >nul 2>&1 && cl.exe /nologo /std:c++17 /EHsc /O2 /W4 /utf-8 /permissive- `
  + `"${source}" /Fo"${objectFile}" /Fe"${candidateBinary}" /link windowsapp.lib`;
// `command` is a complete cmd.exe script with explicitly quoted paths. Node's default Windows
// argument quoting nests those quotes again, so cmd.exe truncates the command and exits 1. Preserve
// this command string verbatim; the script constructs every path from trusted local paths above.
const result = spawnSync('cmd.exe', ['/d', '/s', '/c', command], {
  cwd: root, stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: true,
});
if (result.status !== 0 || !existsSync(candidateBinary)) {
  console.error('Windows.Media.Ocr helper build failed; preserving any existing binary.');
  process.exit(result.status ?? 1);
}

const promoted = outputBinary + '.next';
try {
  copyFileSync(candidateBinary, promoted);
  // The target is removed only after the complete candidate has compiled and copied successfully.
  rmSync(outputBinary, { force: true });
  copyFileSync(promoted, outputBinary);
} finally {
  rmSync(promoted, { force: true });
  rmSync(candidateBinary, { force: true });
  rmSync(objectFile, { force: true });
}
writeFileSync(manifestPath, JSON.stringify({
  schemaVersion: 1,
  binary: 'aika-windows-media-ocr.exe',
  platform: 'win32',
  builtFrom: 'desktop/ocr/windows-media-ocr-helper.cpp',
  protocolSchemaVersion: 1,
  maxInputBytes,
  maxPixels,
  maxOutputBytes,
}, null, 2) + '\n');
console.log(`Windows.Media.Ocr helper built: ${outputBinary}`);
