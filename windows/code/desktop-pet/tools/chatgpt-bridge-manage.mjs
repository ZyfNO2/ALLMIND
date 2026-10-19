import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const data = resolve('../../.local/memory-book');
const session = JSON.parse(readFileSync(resolve(data, 'management-session.json'), 'utf8'));
const url = new URL(session.url);
const token = new URLSearchParams(url.hash.slice(1)).get('token');
if (!token) throw new Error('management token absent');
const call = async (path, body) => {
  const response = await fetch(url.origin + '/api/memory-book/v1' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(75000) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error?.message ?? 'HTTP ' + response.status); return value;
};
const mode = process.argv[2] ?? 'status';
if (mode === 'configure') {
  const { config } = await call('/runtime');
  const response = await fetch(url.origin + '/api/memory-book/v1/runtime', { method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ config: { ...config, chatgptWeb: { ...config.chatgptWeb, transport: 'bridge' } }, expectedRevision: config.revision, operationId: randomUUID() }) });
  const value = await response.json(); if (!response.ok || value.activationError) throw new Error(value.error?.message ?? value.activationError);
  const pair = await call('/chatgpt-web/pairing', {});
  console.log(JSON.stringify({ revision: value.config.revision, transport: value.config.chatgptWeb.transport, connected: pair.connected }));
} else if (mode === 'status') console.log(JSON.stringify(await call('/chatgpt-web/status')));
else if (mode === 'connection') { const pair = await call('/chatgpt-web/pairing', {}); console.log(JSON.stringify({ connected: pair.connected })); }
else throw new Error('Unknown mode');
