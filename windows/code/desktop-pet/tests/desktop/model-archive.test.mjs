import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveEntries, extractModelArchive } from '../../dist/management/model-archive.js';

const createZip = (source, names) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
  $ErrorActionPreference='Stop'
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  Add-Type -AssemblyName System.IO.Compression
  $request=[Console]::In.ReadToEnd()|ConvertFrom-Json
  $zip=[IO.Compression.ZipFile]::Open($request.source,[IO.Compression.ZipArchiveMode]::Create)
  try { foreach($name in $request.names) { $entry=$zip.CreateEntry($name); $writer=[IO.StreamWriter]::new($entry.Open()); try { $writer.Write('{}') } finally { $writer.Dispose() } } } finally { $zip.Dispose() }
`], { input: JSON.stringify({ source, names }), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

test('ZIP validation refuses traversal, case-colliding names and excessive entry count before extracting bytes', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'model-archive-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  for (const [index, names, pattern] of [
    [0, ['../escaped.model3.json'], /不安全/],
    [1, ['runtime/Haru.model3.json', 'runtime/haru.model3.json'], /重名/],
    [2, Array.from({ length: 513 }, (_, n) => `file-${n}.json`), /512/],
  ]) {
    const source = join(scratch, `invalid-${index}.zip`), destination = join(scratch, 'owned-output-' + index);
    createZip(source, names);
    await assert.rejects(archiveEntries(source), pattern);
    await assert.rejects(extractModelArchive(source, destination), pattern);
    await assert.rejects(access(destination), error => error.code === 'ENOENT');
  }
});
