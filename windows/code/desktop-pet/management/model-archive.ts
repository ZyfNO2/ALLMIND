import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ManagementError } from '../contracts/management.js';
import { isValidResourceEntry, type ResourceSelectionEntry } from '../contracts/desktop-host.js';

async function archive(source: string, destination?: string): Promise<ResourceSelectionEntry[]> {
  const script = ['../tools/model-archive.ps1', '../../tools/model-archive.ps1'].map(path => new URL(path, import.meta.url)).find(existsSync);
  if (!script) throw new ManagementError('unavailable', 'ZIP 导入组件缺失。');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(script)], { windowsHide: true });
    let output = '', error = '';
    const timer = setTimeout(() => { child.kill(); reject(new ManagementError('unavailable', 'ZIP 处理超时。')); }, 120_000);
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { error += data; });
    child.stdin.on('error', reject);
    child.once('error', cause => { clearTimeout(timer); reject(cause); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new ManagementError('invalid_request', `ZIP 处理失败：${error.trim()}`)); return; }
      try { resolve(JSON.parse(output || '[]')); } catch (cause) { reject(cause); }
    });
    child.stdin.end(JSON.stringify({ source, destination, mode: destination ? 'extract' : 'list' }));
  });
}
export async function archiveEntries(source: string): Promise<ResourceSelectionEntry[]> {
  return (await archive(source)).filter(item => isValidResourceEntry(item.entry));
}
export async function extractModelArchive(source: string, destination: string): Promise<void> { await archive(source, destination); }
