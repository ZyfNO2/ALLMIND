// RWR-07 本地 TLS 终结：https://127.0.0.1:18443 -> http://127.0.0.1:18899
//
// 背景：生产 ProviderTransport 强制 https（transport.ts:56），而用户授权的本地反代
// 是 http://127.0.0.1:18899。本脚本只做本地回环 TLS 终结，不改任何生产代码。
// 证书：启动时若无则用 openssl 生成自签（2天有效期），只监听 127.0.0.1。
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname } from 'node:path';
import https from 'node:https';
import http from 'node:http';

const DIR = new URL('../.local/tls-term/', import.meta.url);
const KEY = new URL('../.local/tls-term/key.pem', import.meta.url);
const CERT = new URL('../.local/tls-term/cert.pem', import.meta.url);
const LISTEN_PORT = Number(process.env.TLS_TERM_PORT ?? 18443);
const TARGET = process.env.TLS_TERM_TARGET ?? 'http://127.0.0.1:18899';

if (!existsSync(KEY) || !existsSync(CERT)) {
  // RWR-07 audit M-2: `-subj "/CN=127.0.0.1"` alone produces a certificate with NO subjectAltName, and
  // every modern TLS client then rejects the handshake with ERR_TLS_CERT_ALTNAME_INVALID. A SAN must be
  // present, so write the extension config first and generate through `-config`.
  const CONF = new URL('../.local/tls-term/san.cnf', import.meta.url);
  if (!existsSync(CONF)) {
    mkdirSync(dirname(CONF.pathname), { recursive: true });
    writeFileSync(CONF.pathname, [
      '[req]', 'distinguished_name = dn', 'x509_extensions = ext', 'prompt = no',
      '[dn]', 'CN = 127.0.0.1',
      '[ext]', 'subjectAltName = IP:127.0.0.1',
      '',
    ].join('\n'));
  }
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${KEY.pathname}" -out "${CERT.pathname}" -days 2 -nodes -config "${CONF.pathname}"`,
    { stdio: 'inherit' },
  );
}

const server = https.createServer(
  { key: readFileSync(KEY), cert: readFileSync(CERT) },
  (req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const target = new URL(req.url ?? '/', TARGET);
      const proxy = http.request(target, {
        method: req.method,
        headers: { ...req.headers, host: target.host },
      }, upstream => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(res);
      });
      proxy.on('error', err => {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `TLS terminator upstream failed: ${err.message}`, type: 'proxy_error' } }));
      });
      proxy.end(body);
    });
  },
);

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`TLS terminator listening on https://127.0.0.1:${LISTEN_PORT} -> ${TARGET}`);
});
