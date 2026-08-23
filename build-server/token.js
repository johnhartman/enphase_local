/**
 * Token management, including the monthly auto-refresh.
 *
 * An owner token is valid for a year. Refreshing it every 30 days means the
 * copy on disk always has ~11 months of validity banked, so an outage never
 * catches you with a token about to lapse.
 *
 * Refresh needs the Enphase cloud, so it can only happen while the internet
 * is up — exactly why it runs on a schedule instead of on demand. It uses the
 * same two calls the Enphase web UI makes: log in, then mint a token for the
 * gateway serial. Your Enlighten credentials stay in a chmod-600 file on this
 * machine and are sent only to enphaseenergy.com.
 */
import fs from 'node:fs';
import path from 'node:path';
const DAY_SECONDS = 86400;
export const REFRESH_AFTER_DAYS = 30;
export class TokenManager {
    token = null;
    tokenFile;
    credentialsFile;
    serial;
    lastRefresh = null;
    constructor(baseDir, serial) {
        this.tokenFile = path.join(baseDir, '.enphase_token');
        this.credentialsFile = path.join(baseDir, '.enphase_credentials.json');
        this.serial = serial;
    }
    /** Load from env or the token file. Returns null when nothing is configured. */
    load() {
        const env = process.env.ENPHASE_BEARER_TOKEN?.trim();
        if (env) {
            this.token = env;
            return env;
        }
        try {
            const fromDisk = fs.readFileSync(this.tokenFile, 'utf8').trim();
            if (fromDisk) {
                this.token = fromDisk;
                return fromDisk;
            }
        }
        catch { /* not there yet */ }
        return null;
    }
    get current() {
        return this.token;
    }
    get tokenPath() {
        return this.tokenFile;
    }
    /** Decode iat/exp from the JWT without verifying it — display only. */
    claims() {
        if (!this.token)
            return { issuedAt: null, expiresAt: null };
        try {
            const payload = this.token.split('.')[1];
            const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
            return { issuedAt: decoded.iat ?? null, expiresAt: decoded.exp ?? null };
        }
        catch {
            return { issuedAt: null, expiresAt: null };
        }
    }
    readCredentials() {
        const username = process.env.ENPHASE_USERNAME;
        const password = process.env.ENPHASE_PASSWORD;
        if (username && password)
            return { username, password };
        try {
            const parsed = JSON.parse(fs.readFileSync(this.credentialsFile, 'utf8'));
            if (parsed.username && parsed.password) {
                return { username: parsed.username, password: parsed.password };
            }
        }
        catch { /* not configured — manual renewal it is */ }
        return null;
    }
    get autoRefreshConfigured() {
        return this.readCredentials() !== null;
    }
    status() {
        return {
            ...this.claims(),
            autoRefresh: this.autoRefreshConfigured,
            lastRefresh: this.lastRefresh,
        };
    }
    /** True when the token on disk is older than the refresh window. */
    isDue(now = Date.now() / 1000) {
        const { issuedAt, expiresAt } = this.claims();
        if (!this.token)
            return true;
        if (issuedAt)
            return now - issuedAt > REFRESH_AFTER_DAYS * DAY_SECONDS;
        // No readable iat — refresh when less than 11 months of validity remain.
        if (expiresAt)
            return expiresAt - now < 335 * DAY_SECONDS;
        return false;
    }
    /**
     * Mint a fresh token from the Enphase cloud and persist it.
     * Quietly does nothing when credentials aren't configured.
     */
    async refresh(force = false) {
        const credentials = this.readCredentials();
        if (!credentials)
            return null;
        if (!force && !this.isDue())
            return null;
        const record = (ok, message) => {
            this.lastRefresh = { ok, time: Math.round(Date.now() / 1000), message };
            console.log(`[token] ${ok ? 'refreshed' : 'refresh failed'}: ${message}`);
            return this.lastRefresh;
        };
        try {
            const login = await fetch('https://enlighten.enphaseenergy.com/login/login.json', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    'user[email]': credentials.username,
                    'user[password]': credentials.password,
                }),
                signal: AbortSignal.timeout(30000),
            });
            if (!login.ok) {
                return record(false, `Enlighten login failed (HTTP ${login.status}) — check .enphase_credentials.json`);
            }
            const session = (await login.json());
            if (!session.session_id)
                return record(false, 'Enlighten login returned no session');
            const minted = await fetch('https://entrez.enphaseenergy.com/tokens', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    session_id: session.session_id,
                    serial_num: this.serial,
                    username: credentials.username,
                }),
                signal: AbortSignal.timeout(30000),
            });
            if (!minted.ok)
                return record(false, `token endpoint returned HTTP ${minted.status}`);
            const fresh = (await minted.text()).trim();
            if (!fresh.includes('.'))
                return record(false, 'token endpoint returned something that is not a JWT');
            fs.writeFileSync(this.tokenFile, fresh + '\n', { mode: 0o600 });
            this.token = fresh;
            const { expiresAt } = this.claims();
            const until = expiresAt ? new Date(expiresAt * 1000).toISOString().slice(0, 10) : 'unknown';
            return record(true, `new token valid until ${until}`);
        }
        catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            return record(false, `could not reach Enphase (${reason}) — will retry tomorrow`);
        }
    }
}
