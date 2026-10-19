import { writeFile } from 'node:fs/promises';
import { pageAction } from '../dist/providers/chatgpt-background-bridge.js';
import { consumeChatgptStreamEvent } from '../dist/providers/chatgpt-stream-observer.js';
import { installPageRuntime } from '../desktop/chatgpt-extension/page-runtime.mjs';
await writeFile(new URL('../desktop/chatgpt-extension/page.js', import.meta.url), '// Generated from production pageAction; rebuild with node tools/build-chatgpt-extension.mjs.\n(' + installPageRuntime.toString() + ')(' + pageAction.toString() + ',' + consumeChatgptStreamEvent.toString() + ');\n');
