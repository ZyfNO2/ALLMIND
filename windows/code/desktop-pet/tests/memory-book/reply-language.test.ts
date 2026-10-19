import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FileBookRepository } from '../../memory/file-book-repository.js';
import { BookRuntime } from '../../app/book-runtime.js';
import { splitRubyText } from '../../core/ruby-text.js';
import { replyLanguageInstruction } from '../../core/reply-language.js';
import { validateRuntime } from '../../memory/book-validation.js';
import { emptyEntry, type ReplyLanguage } from '../../contracts/memory-book.js';
import { bookTokenCost } from '../../memory/local-book-index.js';

test('reply language survives reopening, validates at commit, and invalidates old runtime traces', async t => {
  const root = join(process.cwd(), '.local/memory-book-tests'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'reply-language-'));
  let repository = new FileBookRepository(directory); t.after(() => repository.close());
  const initial = repository.loadConfig();
  assert.equal(initial.replyLanguage, 'zh-CN');
  assert.equal(replyLanguageInstruction(), replyLanguageInstruction('zh-CN'));
  assert.match(replyLanguageInstruction('en'), /Reply language is English/);
  assert.match(replyLanguageInstruction('zh-CN'), /口号及结尾必须译为中文/u);
  const legacy = { ...initial }; delete legacy.replyLanguage; validateRuntime(legacy);
  assert.throws(() => repository.commitConfig({ ...initial, replyLanguage: 'unsupported' as ReplyLanguage }, 0, 'bad-language'), { code: 'invalid_input' });
  assert.equal(repository.loadConfig().revision, 0);
  repository.commitConfig({ ...initial, replyLanguage: 'ja-JP' }, 0, 'japanese');
  repository.close(); repository = new FileBookRepository(directory);
  assert.equal(repository.loadConfig().replyLanguage, 'ja-JP');
  const runtime = new BookRuntime(repository, { async complete() { throw Error('Inspector must not call a model'); } });
  const scope = { characterId: 'aika', pairingId: 'local-user', sessionId: 'language-check' };
  repository.commit(scope, { upsert: [emptyEntry('persona-language', 'persona', '角色', '这是有外语示例的角色资料：Hello.')] }, 0, 'language-persona');
  const before = await runtime.inspect(scope, '你好', new AbortController().signal);
  assert.equal(before.messages.filter(m => m.role === 'system').length, 1, 'Use one composed system message across provider variations');
  assert.match(JSON.stringify(before.messages), /返信言語は日本語/u);
  const config = repository.loadConfig(); repository.commitConfig({ ...config, replyLanguage: 'zh-ja-ruby' }, config.revision, 'ruby');
  assert.throws(() => runtime.trace(scope, before.recall.id), { code: 'conflict' });
  const next = await runtime.inspect(scope, '你好', new AbortController().signal);
  assert.match(JSON.stringify(next.messages), /中文正文＋日文 Ruby 注释/u);
  assert.deepEqual(next.messages.at(-1), { role: 'user', content: '你好' }, 'Never rewrite the saved user input');
  assert.ok(next.usedTokens >= next.messages.reduce((sum, m) => sum + bookTokenCost(m.content), 0), 'All composed instructions and data count toward the actual prompt budget');
});

test('Ruby preserves literal text and only accepts bounded plain-text annotations', () => {
  assert.deepEqual(splitRubyText('前<ruby>你好<rt>こんにちは</rt></ruby>后'), [{ text: '前' }, { text: '你好', annotation: 'こんにちは' }, { text: '后' }]);
  const hostile = '<ruby>你好<rt><img src=x onerror=alert(1)></rt></ruby><script>alert(2)</script>';
  assert.deepEqual(splitRubyText(hostile), [{ text: hostile }]);
  const oversized = '<ruby>' + '字'.repeat(2001) + '<rt>日本語</rt></ruby>';
  assert.deepEqual(splitRubyText(oversized), [{ text: oversized }]);
});
