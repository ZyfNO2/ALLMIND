import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

test('actual UI API transport respects web budgets, preserves HTTP defaults and cancellation', async () => {
  const budgets = [], calls = [];
  const source = readFileSync('management/character-ui/src/book-api.ts', 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const context = vm.createContext({ exports, URLSearchParams, location: { hash: '', pathname: '/chat', search: '' }, sessionStorage: { getItem: () => 'fixture-token' },
    AbortSignal: { timeout: value => { budgets.push(value); return { budget: value }; }, any: signals => ({ signals }) },
    fetch: async (_url, options) => { calls.push(options); return { ok: true, json: async () => ({ ok: true }) }; } });
  vm.runInContext(code, context);
  await exports.api('/models/test', { body: { binding: { kind: 'chatgpt-web' } } });
  await exports.api('/models/test', { body: { binding: { model: 'http' } } });
  const stop = { cancelled: true };
  await exports.api('/chat', { timeoutMs: 320000, signal: stop });
  await exports.api('/wiki/preview', { timeoutMs: 140000 });
  await exports.api('/chatgpt-web/requests/id/resume', {});
  assert.deepEqual(budgets, [165000, 35000, 320000, 140000, 135000]);
  assert.equal(calls[2].signal.signals[0], stop);
});
