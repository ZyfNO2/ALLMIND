import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pet = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = resolve(process.env.AIKI_BOOK_DATA ?? join(pet, '../../.local/memory-book'));
mkdirSync(directory, { recursive: true });
const electron = createRequire(import.meta.url)('electron') as string;
const child = spawn(electron, [join(pet, 'desktop/electron/main.mjs'), '--root', join(pet, 'desktop'), '--backend', join(pet, 'dist/app/book-backend.js'), '--node', process.execPath, ...process.argv.slice(2)], {
  windowsHide: true, stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, AIKI_BOOK_DATA: directory, PET_TRIAL_CONFIG: join(directory, 'runtime.json') },
});
child.once('error', error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
