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
import http from 'node:http';
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
    port: Number(process.env.PORT || 8787),
    sampleSeconds: Number(process.env.SAMPLE_SECONDS || 30),
    historyHours: Number(process.env.HISTORY_HOURS || 48),
    historyFile: process.env.HISTORY_FILE || path.join(ROOT, 'history.jsonl'),
    requestTimeoutMs: 20000,
    serial: process.env.GATEWAY_SERIAL || '482513006020',
};
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
function parseHost(value) {
    const match = /^(.*?):(\d+)$/.exec(value);
    if (match)
        return { hostname: match[1], port: Number(match[2]) };
    return { hostname: value, port: 443 };
}
function gatewayRequest(host, urlPath, body) {
    const { hostname, port } = parseHost(host);
    const payload = body === undefined ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const fail = (error, code) => {
            reject(Object.assign(error, { code }));
        };
        const request = https.request({
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
        }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => {
                const status = response.statusCode ?? 0;
                if (status === 401 || status === 403)
                    return fail(new Error('token rejected'), 'TOKEN');
                if (status !== 200)
                    return fail(new Error(`HTTP ${status} from ${urlPath}`), 'HTTP');
                try {
                    resolve(JSON.parse(body));
                }
                catch {
                    fail(new Error(`non-JSON response from ${urlPath}`), 'PARSE');
                }
            });
        });
        request.on('timeout', () => { request.destroy(); fail(new Error('timeout'), 'NET'); });
        request.on('error', (error) => fail(error, 'NET'));
        if (payload !== null)
            request.write(payload);
        request.end();
    });
}
/** Try the last-good host first, then the other one; remember the winner. */
async function fetchWithFailover(urlPath, body) {
    const order = activeHost === CONFIG.gatewayHost
        ? [CONFIG.gatewayHost, CONFIG.fallbackHost]
        : [CONFIG.fallbackHost, CONFIG.gatewayHost];
    let lastError = Object.assign(new Error('unreachable'), { code: 'NET' });
    for (const host of order) {
        try {
            const data = await gatewayRequest(host, urlPath, body);
            if (host !== activeHost)
                console.log(`[gateway] now reachable at ${host}`);
            activeHost = host;
            return data;
        }
        catch (err) {
            lastError = err;
            if (lastError.code === 'TOKEN')
                throw lastError; // same on any host
        }
    }
    throw lastError;
}
const mwToW = (value) => (typeof value === 'number' ? value / 1000 : null);
function pickMeter(payload, section, measurementType) {
    const list = payload?.[section];
    if (!Array.isArray(list))
        return null;
    const hit = list.find((entry) => entry.measurementType === measurementType);
    return typeof hit?.wNow === 'number' ? hit.wNow : null;
}
async function takeSample() {
    const secctrl = (await fetchWithFailover('/ivp/ensemble/secctrl'));
    let production = null;
    try {
        production = (await fetchWithFailover('/production.json?details=1'));
    }
    catch { /* meters are optional; SOC is the thing that matters */ }
    let live = undefined;
    try {
        let status = (await fetchWithFailover('/ivp/livedata/status'));
        if (status?.connection?.sc_stream !== 'enabled') {
            // The gateway switches its live stream off on its own and leaves it off
            // until asked again, which is why solar/load/grid/battery would go null
            // a few samples after startup. Ask, then re-read.
            await fetchWithFailover('/ivp/livedata/stream', { enable: 1 });
            status = (await fetchWithFailover('/ivp/livedata/status'));
        }
        if (status?.connection?.sc_stream === 'enabled')
            live = status.meters;
    }
    catch { /* stream unavailable; SOC is the thing that matters */ }
    let solarW = pickMeter(production, 'production', 'production');
    if (solarW === null) {
        const inverters = production?.production?.find((entry) => entry.type === 'inverters');
        solarW = typeof inverters?.wNow === 'number' ? inverters.wNow : null;
    }
    let loadW = pickMeter(production, 'consumption', 'total-consumption');
    let gridW = pickMeter(production, 'consumption', 'net-consumption');
    let battW = null;
    if (live) {
        battW = mwToW(live.storage?.agg_p_mw);
        if (solarW === null)
            solarW = mwToW(live.pv?.agg_p_mw);
        if (loadW === null)
            loadW = mwToW(live.load?.agg_p_mw);
        if (gridW === null)
            gridW = mwToW(live.grid?.agg_p_mw);
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
let history = [];
let latest = null;
let lastError = null;
function pruneHistory() {
    const cutoff = Math.round(Date.now() / 1000) - CONFIG.historyHours * 3600;
    history = history.filter((row) => row.t >= cutoff);
}
function loadHistory() {
    try {
        for (const line of fs.readFileSync(CONFIG.historyFile, 'utf8').split('\n')) {
            if (!line.trim())
                continue;
            try {
                const row = JSON.parse(line);
                if (typeof row.t === 'number')
                    history.push(row);
            }
            catch { /* skip a torn line */ }
        }
        history.sort((a, b) => a.t - b.t);
        pruneHistory();
        console.log(`[history] loaded ${history.length} samples from ${path.basename(CONFIG.historyFile)}`);
    }
    catch {
        console.log('[history] starting a new history file');
    }
}
/** Rewrite the file from the pruned in-memory copy so it can't grow forever. */
function rewriteHistory() {
    const body = history.map((row) => JSON.stringify(row)).join('\n');
    fs.writeFile(CONFIG.historyFile, body ? body + '\n' : '', (err) => {
        if (err)
            console.error('[history] rewrite failed:', err.message);
    });
}
function recordSample(sample) {
    history.push(sample);
    fs.appendFile(CONFIG.historyFile, JSON.stringify(sample) + '\n', (err) => {
        if (err)
            console.error('[history] append failed:', err.message);
    });
}
async function poll() {
    try {
        latest = await takeSample();
        lastError = null;
        recordSample(latest);
    }
    catch (err) {
        const failure = err;
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
        if (failure.code === 'TOKEN')
            void tokens.refresh(true);
    }
}
// ---------------------------------------------------------------- http
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
    '.ico': 'image/x-icon',
};
function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}
function serveStatic(res, urlPath) {
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
const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/status') {
        const respond = () => sendJson(res, 200, {
            ok: !lastError,
            error: lastError,
            sample: latest,
            gatewayHost: activeHost,
            onHotspot: activeHost === CONFIG.fallbackHost,
            sampleSeconds: CONFIG.sampleSeconds,
            serverTime: Math.round(Date.now() / 1000),
            token: tokens.status(),
        });
        // Refresh on demand if the background sample is stale.
        const age = latest ? Date.now() / 1000 - latest.t : Infinity;
        if (age > Math.min(CONFIG.sampleSeconds, 10))
            void poll().then(respond);
        else
            respond();
        return;
    }
    if (url.pathname === '/api/history') {
        const hours = Math.min(Number(url.searchParams.get('hours')) || 6, CONFIG.historyHours);
        const cutoff = Math.round(Date.now() / 1000) - hours * 3600;
        sendJson(res, 200, { hours, samples: history.filter((row) => row.t >= cutoff) });
        return;
    }
    serveStatic(res, url.pathname);
});
function lanAddresses() {
    const out = [];
    for (const entries of Object.values(os.networkInterfaces())) {
        for (const entry of entries ?? []) {
            if (entry.family === 'IPv4' && !entry.internal)
                out.push(entry.address);
        }
    }
    return out;
}
loadHistory();
void poll();
void tokens.refresh(); // monthly refresh, first checked at startup
server.listen(CONFIG.port, '0.0.0.0', () => {
    const { expiresAt } = tokens.claims();
    console.log(`
Enphase local monitor
  gateway   ${CONFIG.gatewayHost}  (hotspot fallback ${CONFIG.fallbackHost})
  sampling  every ${CONFIG.sampleSeconds}s, keeping ${CONFIG.historyHours}h
  token     ${expiresAt ? `valid until ${new Date(expiresAt * 1000).toISOString().slice(0, 10)}` : 'expiry unknown'}${tokens.autoRefreshConfigured ? ', auto-refreshes monthly' : ' — auto-refresh NOT configured (see README)'}

  on this machine   http://localhost:${CONFIG.port}`);
    for (const address of lanAddresses()) {
        console.log(`  on the LAN        http://${address}:${CONFIG.port}`);
    }
    console.log('');
});
setInterval(() => { void poll(); }, CONFIG.sampleSeconds * 1000);
setInterval(() => { pruneHistory(); rewriteHistory(); }, 3600 * 1000);
// Check daily whether the monthly refresh is due; harmless no-op otherwise.
setInterval(() => { void tokens.refresh(); }, 24 * 3600 * 1000);
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        // Under `npm start` a single ^C reaches us twice: once from the terminal's
        // process group, once forwarded by npm. Only act on the first.
        if (shuttingDown)
            return;
        shuttingDown = true;
        console.log('\nstopping');
        server.close(() => process.exit(0));
        // An open dashboard tab keeps re-using its keep-alive socket, so it never
        // goes idle and close() would otherwise wait forever.
        server.closeAllConnections();
        setTimeout(() => process.exit(0), 2000).unref();
    });
}
