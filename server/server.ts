/**
 * Enphase local monitor — server
 *
 * Runs on a machine on the house LAN. Holds the bearer token, polls the IQ
 * Gateway over its self-signed HTTPS, keeps a rolling history on disk, and
 * serves the React UI from the same origin (the gateway sends no CORS
 * headers, so a browser can never talk to it directly).
 *
 * Zero runtime dependencies — plain Node 18+.
 *
 *   npm start
 *   GATEWAY_HOST=172.30.1.1 npm start     # when joined to the Envoy hotspot
 */

import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TokenManager } from './token.js';

// build-server/server.js lives one level below the project root.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CONFIG = {
  gatewayHost: process.env.GATEWAY_HOST || '192.168.0.148',
  // With the router dead you join the gateway's own Envoy_XXXXXX hotspot,
  // where it always answers on this address. Tried automatically.
  fallbackHost: process.env.GATEWAY_FALLBACK || '172.30.1.1',
  // The dashboard is served over TLS so the browser treats it as a secure
  // context (required for desktop notifications). Plain HTTP only redirects.
  port: Number(process.env.PORT || 443),
  httpPort: Number(process.env.HTTP_PORT || 80),
  certFile: process.env.TLS_CERT || path.join(ROOT, 'cert.pem'),
  keyFile: process.env.TLS_KEY || path.join(ROOT, 'key.pem'),
  sampleSeconds: Number(process.env.SAMPLE_SECONDS || 30),
  historyHours: Number(process.env.HISTORY_HOURS || 48),
  historyFile: process.env.HISTORY_FILE || path.join(ROOT, 'history.jsonl'),
  outagesFile: process.env.OUTAGES_FILE || path.join(ROOT, 'outages.jsonl'),
  requestTimeoutMs: 20000,
  serial: process.env.GATEWAY_SERIAL || '482513006020',
};

interface Sample {
  t: number;
  soc: number | null;
  availWh: number | null;
  capWh: number | null;
  sohPct: number | null;
  reservePct: number | null;
  offGrid: boolean;
  shutdown: boolean;
  solarW: number | null;
  loadW: number | null;
  gridW: number | null;
  battW: number | null;
}

/** One grid outage: the stretch during which the system stayed islanded. */
interface Outage {
  /** Unix seconds of the first off-grid sample. */
  startTime: number;
  /** Unix seconds of the first on-grid sample after it; null while ongoing. */
  endTime: number | null;
  socStart: number | null;
  socMin: number | null;
  socEnd: number | null;
  /** House consumption while islanded, watt-hours. */
  loadWh: number;
  /** Solar production while islanded, watt-hours. */
  solarWh: number;
  /** Seconds of the outage with no usable readings, left out of the Wh totals. */
  unmeasuredSeconds: number;
}

interface PollError {
  kind: 'token' | 'network';
  message: string;
  renewUrl?: string;
}

type GatewayFailure = Error & { code?: string };

// ---------------------------------------------------------------- token

const tokens = new TokenManager(ROOT, CONFIG.serial);

if (!tokens.load()) {
  console.error(`
No Enphase token found.

Either set the environment variable:
  export ENPHASE_BEARER_TOKEN='eyJraWQi...'
or save it next to the server:
  echo 'eyJraWQi...' > ${tokens.tokenPath} && chmod 600 ${tokens.tokenPath}

A fresh owner token (valid 1 year, needs internet):
  https://enlighten.enphaseenergy.com/entrez-auth-token?serial_num=${CONFIG.serial}

Optional — for automatic monthly refresh, also create:
  ${path.join(ROOT, '.enphase_credentials.json')}
  {"username": "you@example.com", "password": "your Enlighten password"}
  chmod 600 it. See the README.
`);
  process.exit(2);
}

// ---------------------------------------------------------------- gateway

let activeHost = CONFIG.gatewayHost;

/** Split an optional ":port" suffix off a host string. */
function parseHost(value: string): { hostname: string; port: number } {
  const match = /^(.*?):(\d+)$/.exec(value);
  if (match) return { hostname: match[1], port: Number(match[2]) };
  return { hostname: value, port: 443 };
}

function gatewayRequest(host: string, urlPath: string, body?: unknown): Promise<unknown> {
  const { hostname, port } = parseHost(host);
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const fail = (error: Error, code: string) => {
      reject(Object.assign(error, { code }));
    };
    const request = https.request(
      {
        hostname,
        port,
        path: urlPath,
        method: payload === null ? 'GET' : 'POST',
        // The gateway serves a self-signed cert on your own LAN; the bearer
        // token is what authenticates this connection.
        rejectUnauthorized: false,
        headers: {
          Authorization: `Bearer ${tokens.current ?? ''}`,
          ...(payload === null ? {} : {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          }),
        },
        timeout: CONFIG.requestTimeoutMs,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { body += chunk; });
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          if (status === 401 || status === 403) return fail(new Error('token rejected'), 'TOKEN');
          if (status !== 200) return fail(new Error(`HTTP ${status} from ${urlPath}`), 'HTTP');
          try {
            resolve(JSON.parse(body));
          } catch {
            fail(new Error(`non-JSON response from ${urlPath}`), 'PARSE');
          }
        });
      },
    );
    request.on('timeout', () => { request.destroy(); fail(new Error('timeout'), 'NET'); });
    request.on('error', (error) => fail(error, 'NET'));
    if (payload !== null) request.write(payload);
    request.end();
  });
}

/** Try the last-good host first, then the other one; remember the winner. */
async function fetchWithFailover(urlPath: string, body?: unknown): Promise<unknown> {
  const order = activeHost === CONFIG.gatewayHost
    ? [CONFIG.gatewayHost, CONFIG.fallbackHost]
    : [CONFIG.fallbackHost, CONFIG.gatewayHost];
  let lastError: GatewayFailure = Object.assign(new Error('unreachable'), { code: 'NET' });
  for (const host of order) {
    try {
      const data = await gatewayRequest(host, urlPath, body);
      if (host !== activeHost) console.log(`[gateway] now reachable at ${host}`);
      activeHost = host;
      return data;
    } catch (err) {
      lastError = err as GatewayFailure;
      if (lastError.code === 'TOKEN') throw lastError; // same on any host
    }
  }
  throw lastError;
}

const mwToW = (value: unknown): number | null => (typeof value === 'number' ? value / 1000 : null);

interface MeterEntry { type?: string; measurementType?: string; wNow?: number }
interface ProductionPayload { production?: MeterEntry[]; consumption?: MeterEntry[] }
interface SecctrlPayload {
  agg_soc?: number;
  Max_energy?: number;
  ENC_agg_avail_energy?: number;
  ENC_agg_soh?: number;
  Enc_max_available_capacity?: number;
  configured_backup_soc?: number;
  shutdown?: boolean;
  offgrid_secctrl?: { is_active?: boolean };
}
interface LivedataPayload {
  connection?: { sc_stream?: string };
  meters?: Record<string, { agg_p_mw?: number } | undefined>;
}

function pickMeter(payload: ProductionPayload | null, section: 'production' | 'consumption', measurementType: string): number | null {
  const list = payload?.[section];
  if (!Array.isArray(list)) return null;
  const hit = list.find((entry) => entry.measurementType === measurementType);
  return typeof hit?.wNow === 'number' ? hit.wNow : null;
}

async function takeSample(): Promise<Sample> {
  const secctrl = (await fetchWithFailover('/ivp/ensemble/secctrl')) as SecctrlPayload;

  let production: ProductionPayload | null = null;
  try {
    production = (await fetchWithFailover('/production.json?details=1')) as ProductionPayload;
  } catch { /* meters are optional; SOC is the thing that matters */ }

  let live: LivedataPayload['meters'] = undefined;
  try {
    let status = (await fetchWithFailover('/ivp/livedata/status')) as LivedataPayload;
    if (status?.connection?.sc_stream !== 'enabled') {
      // The gateway switches its live stream off on its own and leaves it off
      // until asked again, which is why solar/load/grid/battery would go null
      // a few samples after startup. Ask, then re-read.
      await fetchWithFailover('/ivp/livedata/stream', { enable: 1 });
      status = (await fetchWithFailover('/ivp/livedata/status')) as LivedataPayload;
    }
    if (status?.connection?.sc_stream === 'enabled') live = status.meters;
  } catch { /* stream unavailable; SOC is the thing that matters */ }

  let solarW = pickMeter(production, 'production', 'production');
  if (solarW === null) {
    const inverters = production?.production?.find((entry) => entry.type === 'inverters');
    solarW = typeof inverters?.wNow === 'number' ? inverters.wNow : null;
  }
  let loadW = pickMeter(production, 'consumption', 'total-consumption');
  let gridW = pickMeter(production, 'consumption', 'net-consumption');
  let battW: number | null = null;

  if (live) {
    battW = mwToW(live.storage?.agg_p_mw);
    if (solarW === null) solarW = mwToW(live.pv?.agg_p_mw);
    if (loadW === null) loadW = mwToW(live.load?.agg_p_mw);
    if (gridW === null) gridW = mwToW(live.grid?.agg_p_mw);
  }

  const capWh = secctrl.Enc_max_available_capacity ?? secctrl.Max_energy ?? null;
  // A gateway that has just rebooted answers before it has re-discovered the
  // batteries: agg_soc 0, capacity 0, SOH 0, default reserve. Recording that
  // would chart a phantom discharge and trip the low-charge alert, so treat
  // it as a failed poll and keep the last good sample current.
  if (capWh === 0) {
    throw Object.assign(new Error('reports no battery capacity'), { code: 'NOTREADY' });
  }

  return {
    t: Math.round(Date.now() / 1000),
    soc: secctrl.agg_soc ?? null,
    availWh: secctrl.ENC_agg_avail_energy ?? secctrl.Max_energy ?? null,
    capWh,
    sohPct: secctrl.ENC_agg_soh ?? null,
    reservePct: secctrl.configured_backup_soc ?? null,
    offGrid: Boolean(secctrl.offgrid_secctrl?.is_active),
    shutdown: Boolean(secctrl.shutdown),
    solarW,
    loadW,
    gridW,
    battW,
  };
}

// ---------------------------------------------------------------- history

let history: Sample[] = [];
let latest: Sample | null = null;
let lastError: PollError | null = null;

function pruneHistory(): void {
  const cutoff = Math.round(Date.now() / 1000) - CONFIG.historyHours * 3600;
  history = history.filter((row) => row.t >= cutoff);
}

function loadHistory(): void {
  try {
    for (const line of fs.readFileSync(CONFIG.historyFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as Sample;
        if (typeof row.t === 'number') history.push(row);
      } catch { /* skip a torn line */ }
    }
    history.sort((a, b) => a.t - b.t);
    pruneHistory();
    console.log(`[history] loaded ${history.length} samples from ${path.basename(CONFIG.historyFile)}`);
  } catch {
    console.log('[history] starting a new history file');
  }
}

/** Rewrite the file from the pruned in-memory copy so it can't grow forever. */
function rewriteHistory(): void {
  const body = history.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFile(CONFIG.historyFile, body ? body + '\n' : '', (err) => {
    if (err) console.error('[history] rewrite failed:', err.message);
  });
}

function recordSample(sample: Sample): void {
  trackOutage(history[history.length - 1] ?? null, sample);
  history.push(sample);
  fs.appendFile(CONFIG.historyFile, JSON.stringify(sample) + '\n', (err) => {
    if (err) console.error('[history] append failed:', err.message);
  });
}

// ---------------------------------------------------------------- drain

/**
 * What was emptying the battery at one sample, in watts: the measured battery
 * discharge when there is one, else house load minus solar. Mirrors netDrainW
 * in src/format.ts.
 */
function sampleDrainW(sample: Sample): number | null {
  if (sample.battW !== null && sample.battW > 5) return sample.battW;
  if (sample.loadW === null) return null;
  return sample.solarW === null ? sample.loadW : sample.loadW - Math.max(0, sample.solarW);
}

const AVG_DRAIN_HOURS = [1, 6, 24, 48] as const;

/**
 * Mean drain over each of the last 1/6/24/48 hours, so a short spike does not
 * swing the runtime estimate. All windows go out with every status response,
 * which lets the dashboard switch between them without another request.
 */
function averageDrainW(): Record<number, number | null> {
  const now = Math.round(Date.now() / 1000);
  const out: Record<number, number | null> = {};
  let sum = 0;
  let count = 0;
  let i = history.length - 1;
  for (const hours of AVG_DRAIN_HOURS) {
    for (; i >= 0 && history[i].t >= now - hours * 3600; i--) {
      const drain = sampleDrainW(history[i]);
      if (drain !== null) { sum += drain; count++; }
    }
    out[hours] = count ? sum / count : null;
  }
  return out;
}

// ---------------------------------------------------------------- outages

// Kept forever, unlike the rolling history. Only the last record can be open
// (endTime null); it is updated on every sample while the grid is down, so an
// outage survives a restart of this process.
let outages: Outage[] = [];

function loadOutages(): void {
  try {
    for (const line of fs.readFileSync(CONFIG.outagesFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as Outage;
        if (typeof row.startTime === 'number') outages.push(row);
      } catch { /* skip a torn line */ }
    }
    console.log(`[outage] loaded ${outages.length} outages from ${path.basename(CONFIG.outagesFile)}`);
  } catch {
    console.log('[outage] starting a new outage log');
  }
}

/** Write to a temp file and rename, so a power cut can't tear the log. */
function saveOutages(): void {
  const body = outages.map((row) => JSON.stringify(row)).join('\n');
  const tempFile = `${CONFIG.outagesFile}.tmp`;
  try {
    fs.writeFileSync(tempFile, body ? body + '\n' : '');
    fs.renameSync(tempFile, CONFIG.outagesFile);
  } catch (err) {
    console.error('[outage] save failed:', (err as Error).message);
  }
}

const formatSpan = (seconds: number): string => {
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
};
const formatSoc = (soc: number | null): string => (soc === null ? '—' : `${soc}%`);

function trackOutage(previous: Sample | null, sample: Sample): void {
  const last = outages[outages.length - 1];
  const open = last && last.endTime === null ? last : null;

  if (!open) {
    if (!sample.offGrid) return;
    outages.push({
      startTime: sample.t,
      endTime: null,
      socStart: sample.soc,
      socMin: sample.soc,
      socEnd: null,
      loadWh: 0,
      solarWh: 0,
      unmeasuredSeconds: 0,
    });
    console.log(`[outage] grid down at ${new Date(sample.t * 1000).toISOString()}, battery ${formatSoc(sample.soc)}`);
    saveOutages();
    return;
  }

  if (sample.soc !== null) {
    open.socMin = open.socMin === null ? sample.soc : Math.min(open.socMin, sample.soc);
  }

  // Energy is integrated between consecutive samples of the outage; a longer
  // gap (failed polls, this process down) or a missing reading is unmeasured.
  const seconds = previous && previous.t >= open.startTime ? sample.t - previous.t : 0;
  if (previous && seconds > 0) {
    if (
      seconds <= CONFIG.sampleSeconds * 5
      && previous.loadW !== null && sample.loadW !== null
      && previous.solarW !== null && sample.solarW !== null
    ) {
      // The production meter reads slightly negative at times; that is not
      // production, so it is floored at zero.
      open.loadWh += ((previous.loadW + sample.loadW) / 2) * (seconds / 3600);
      open.solarWh += ((Math.max(0, previous.solarW) + Math.max(0, sample.solarW)) / 2) * (seconds / 3600);
    } else {
      open.unmeasuredSeconds += seconds;
    }
  }

  if (!sample.offGrid) {
    open.endTime = sample.t;
    open.socEnd = sample.soc;
    console.log(
      `[outage] grid restored after ${formatSpan(open.endTime - open.startTime)} — battery `
      + `${formatSoc(open.socStart)} → ${formatSoc(open.socEnd)} (low ${formatSoc(open.socMin)}), `
      + `house used ${(open.loadWh / 1000).toFixed(2)} kWh, solar made ${(open.solarWh / 1000).toFixed(2)} kWh`,
    );
  }
  saveOutages();
}

// While the gateway is down, each poll blocks for the full timeout on both
// hosts, and every dashboard refresh would otherwise queue another one. Share
// the in-flight poll instead, so callers wait on the same request and no burst
// of stacked samples lands when the gateway comes back.
let inFlight: Promise<void> | null = null;

function poll(): Promise<void> {
  if (!inFlight) {
    inFlight = runPoll().finally(() => { inFlight = null; });
  }
  return inFlight;
}

async function runPoll(): Promise<void> {
  try {
    latest = await takeSample();
    lastError = null;
    recordSample(latest);
  } catch (err) {
    const failure = err as GatewayFailure;
    lastError = failure.code === 'TOKEN'
      ? {
        kind: 'token',
        message: 'The gateway rejected the token — it has most likely expired.',
        renewUrl: `https://enlighten.enphaseenergy.com/entrez-auth-token?serial_num=${CONFIG.serial}`,
      }
      : failure.code === 'NOTREADY'
        ? {
          kind: 'network',
          message: `The gateway answered but ${failure.message} — it is probably restarting. Showing the last good sample.`,
        }
        : {
          kind: 'network',
          message: `Cannot reach the gateway (${failure.message}). Tried ${CONFIG.gatewayHost} and ${CONFIG.fallbackHost}.`,
        };
    console.error('[poll]', lastError.message);
    // A rejected token with auto-refresh configured: try to fix it now.
    if (failure.code === 'TOKEN') void tokens.refresh(true);
  }
}

// ---------------------------------------------------------------- static

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

/**
 * The production meter reads below zero at times (seen around dusk). The raw
 * value stays in memory and in history.jsonl; the API reports it as 0 W.
 */
function forApi(sample: Sample): Sample {
  return sample.solarW !== null && sample.solarW < 0 ? { ...sample, solarW: 0 } : sample;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(res: ServerResponse, urlPath: string): void {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(ROOT, 'dist', safe);
  fs.readFile(file, (err, data) => {
    if (err) {
      fs.readFile(path.join(ROOT, 'dist', 'index.html'), (err2, shell) => {
        if (err2) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('UI not built yet. Run:  npm install && npm run build\n');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(shell);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  });
}

// ---------------------------------------------------------------- tls

/**
 * Load the certificate pair, minting a self-signed one with the system
 * openssl on first start. The cert names localhost, this machine's hostname
 * and every LAN address it has right now, and lasts ten years, so the
 * appliance keeps working with the internet down. Browsers warn once per
 * device until the cert is trusted there.
 */
function ensureCertificate(): { key: Buffer; cert: Buffer } {
  if (!fs.existsSync(CONFIG.certFile) || !fs.existsSync(CONFIG.keyFile)) {
    const names = [
      'DNS:localhost',
      `DNS:${os.hostname()}`,
      'IP:127.0.0.1',
      ...lanAddresses().map((address) => `IP:${address}`),
    ];
    // A config file rather than -addext, so LibreSSL (macOS) and OpenSSL both work.
    const confFile = path.join(os.tmpdir(), `enphase-local-openssl-${process.pid}.cnf`);
    fs.writeFileSync(confFile, [
      '[req]',
      'distinguished_name = dn',
      'x509_extensions = ext',
      'prompt = no',
      '[dn]',
      'CN = Enphase local monitor',
      '[ext]',
      `subjectAltName = ${names.join(',')}`,
      'basicConstraints = CA:FALSE',
      'keyUsage = digitalSignature, keyEncipherment',
      'extendedKeyUsage = serverAuth',
    ].join('\n'));
    try {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
        '-config', confFile, '-keyout', CONFIG.keyFile, '-out', CONFIG.certFile,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
    } finally {
      fs.rmSync(confFile, { force: true });
    }
    fs.chmodSync(CONFIG.keyFile, 0o600);
    console.log(`[tls] minted self-signed certificate ${path.basename(CONFIG.certFile)} for ${names.join(', ')}`);
  }
  return { key: fs.readFileSync(CONFIG.keyFile), cert: fs.readFileSync(CONFIG.certFile) };
}

// ---------------------------------------------------------------- http

const server = https.createServer(ensureCertificate(), (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'https://localhost');

  if (url.pathname === '/api/status') {
    const respond = () => sendJson(res, 200, {
      ok: !lastError,
      error: lastError,
      sample: latest && forApi(latest),
      avgDrainW: averageDrainW(),
      gatewayHost: activeHost,
      onHotspot: activeHost === CONFIG.fallbackHost,
      sampleSeconds: CONFIG.sampleSeconds,
      serverTime: Math.round(Date.now() / 1000),
      token: tokens.status(),
    });
    // Refresh on demand if the background sample is stale.
    const age = latest ? Date.now() / 1000 - latest.t : Infinity;
    if (age > Math.min(CONFIG.sampleSeconds, 10)) void poll().then(respond);
    else respond();
    return;
  }

  if (url.pathname === '/api/history') {
    const hours = Math.min(Number(url.searchParams.get('hours')) || 6, CONFIG.historyHours);
    const cutoff = Math.round(Date.now() / 1000) - hours * 3600;
    sendJson(res, 200, { hours, samples: history.filter((row) => row.t >= cutoff).map(forApi) });
    return;
  }

  if (url.pathname === '/api/outages') {
    sendJson(res, 200, { outages });
    return;
  }

  serveStatic(res, url.pathname);
});

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

loadHistory();
loadOutages();
void poll();
void tokens.refresh(); // monthly refresh, first checked at startup

const portSuffix = CONFIG.port === 443 ? '' : `:${CONFIG.port}`;

// Plain HTTP only bounces to the TLS listener, keeping the port in the URL
// unless it is the default. Losing this listener is not fatal: the dashboard
// is still reachable over https, so log and carry on.
const redirect = http.createServer((req: IncomingMessage, res: ServerResponse) => {
  const host = (req.headers.host ?? 'localhost').replace(/:\d+$/, '');
  res.writeHead(301, { Location: `https://${host}${portSuffix}${req.url ?? '/'}` });
  res.end();
});
redirect.on('error', (err: NodeJS.ErrnoException) => {
  console.error(`[http] redirect listener on :${CONFIG.httpPort} failed (${err.code ?? err.message}); https still serves`);
});
redirect.listen(CONFIG.httpPort, '0.0.0.0');

server.listen(CONFIG.port, '0.0.0.0', () => {
  const { expiresAt } = tokens.claims();
  console.log(`
Enphase local monitor
  gateway   ${CONFIG.gatewayHost}  (hotspot fallback ${CONFIG.fallbackHost})
  sampling  every ${CONFIG.sampleSeconds}s, keeping ${CONFIG.historyHours}h
  token     ${expiresAt ? `valid until ${new Date(expiresAt * 1000).toISOString().slice(0, 10)}` : 'expiry unknown'}${tokens.autoRefreshConfigured ? ', auto-refreshes monthly' : ' — auto-refresh NOT configured (see README)'}

  on this machine   https://localhost${portSuffix}`);
  for (const address of lanAddresses()) {
    console.log(`  on the LAN        https://${address}${portSuffix}`);
  }
  console.log(`  http://…:${CONFIG.httpPort} redirects here; self-signed cert, so expect a one-time browser warning per device
`);
});

setInterval(() => { void poll(); }, CONFIG.sampleSeconds * 1000);
setInterval(() => { pruneHistory(); rewriteHistory(); }, 3600 * 1000);
// Check daily whether the monthly refresh is due; harmless no-op otherwise.
setInterval(() => { void tokens.refresh(); }, 24 * 3600 * 1000);

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // Under `npm start` a single ^C reaches us twice: once from the terminal's
    // process group, once forwarded by npm. Only act on the first.
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nstopping');
    redirect.close();
    redirect.closeAllConnections();
    server.close(() => process.exit(0));
    // An open dashboard tab keeps re-using its keep-alive socket, so it never
    // goes idle and close() would otherwise wait forever.
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
