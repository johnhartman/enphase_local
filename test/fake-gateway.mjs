// A stand-in IQ Gateway that serves one captured state from
// docs/gateway-captures/<dir>/ over self-signed HTTPS, so the real server can
// be run against a past outage with no hardware:
//
//   node test/fake-gateway.mjs docs/gateway-captures/2026-09-28-islanded [port]
//
// then GATEWAY_HOST=127.0.0.1:<port> GATEWAY_FALLBACK=127.0.0.1:<port> for
// the server (test/replay.sh wires it all up). Zero dependencies, like the
// server itself.
//
// URL -> file: strip the leading "/", drop the query string, "/" -> "_",
// append ".json" unless the path already ends in it. Mirrors
// deploy/capture-gateway.sh. POST /ivp/livedata/stream (the "turn the live
// stream on" call) answers {} like the real gateway. Any request without an
// Authorization header gets 401, which is what the gateway does.

import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = process.argv[2];
const port = Number(process.argv[3] || 8449);
if (!dir || !fs.existsSync(dir)) {
  console.error('usage: node test/fake-gateway.mjs <capture-dir> [port]');
  process.exit(2);
}

function selfSigned() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gateway-'));
  const key = path.join(tmp, 'key.pem');
  const cert = path.join(tmp, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '30',
    '-subj', '/CN=fake-gateway', '-keyout', key, '-out', cert,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function fileFor(urlPath) {
  let name = urlPath.replace(/^\/+/, '').replace(/\?.*$/, '').replace(/\//g, '_');
  if (!name.endsWith('.json')) name += '.json';
  return path.join(dir, name);
}

const server = https.createServer(selfSigned(), (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  };
  if (!req.headers.authorization) return send(401, '{"message":"Unauthorized"}');
  if (req.method === 'POST' && req.url.startsWith('/ivp/livedata/stream')) return send(200, '{}');
  const file = fileFor(req.url);
  if (!fs.existsSync(file)) {
    console.log(`[fake-gateway] ${req.method} ${req.url} -> 404 (no ${path.basename(file)})`);
    return send(404, '{"message":"no such capture"}');
  }
  console.log(`[fake-gateway] ${req.method} ${req.url} -> ${path.basename(file)}`);
  send(200, fs.readFileSync(file));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[fake-gateway] serving ${dir} at https://127.0.0.1:${port}`);
});
