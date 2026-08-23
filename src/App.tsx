import React, { useEffect, useMemo, useRef, useState } from 'react';
import LineChart, { type Series } from './LineChart.js';
import {
  formatAgo, formatClock, formatDuration, formatKwh, formatW, netDrainW, runtimeHours,
} from './format.js';
import {
  beep, canNotify, DEFAULT_SETTINGS, evaluate, loadSettings, notify, saveSettings,
} from './alerts.js';
import type {
  AlertSettings, HistoryResponse, Sample, StatusResponse,
} from './types.js';

const STATUS_POLL_MS = 8000;
const HISTORY_POLL_MS = 60000;
const RANGES = [1, 6, 24, 48] as const;

// Categorical slots 1–3 of the validated palette. The CSS custom properties
// carry the light and dark steps, so the charts restep with the theme.
const COLORS = {
  solar: 'var(--series-1)',
  load: 'var(--series-2)',
  batt: 'var(--series-3)',
} as const;

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export default function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [history, setHistory] = useState<Sample[]>([]);
  const [rangeHours, setRangeHours] = useState<number>(6);
  const [showTable, setShowTable] = useState(false);
  const [settings, setSettings] = useState<AlertSettings>(DEFAULT_SETTINGS);
  const [notifState, setNotifState] = useState<NotificationPermission>('default');
  const seenAlerts = useRef<Set<string>>(new Set());

  useEffect(() => {
    setSettings(loadSettings());
    if (canNotify()) setNotifState(Notification.permission);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const data = await getJson<StatusResponse>('/api/status');
        if (!cancelled) { setStatus(data); setFetchError(null); }
      } catch (err) {
        if (!cancelled) setFetchError(err instanceof Error ? err.message : String(err));
      }
    };
    void tick();
    const timer = window.setInterval(() => { void tick(); }, STATUS_POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const data = await getJson<HistoryResponse>(`/api/history?hours=${rangeHours}`);
        if (!cancelled) setHistory(data.samples ?? []);
      } catch { /* the status banner already reports trouble */ }
    };
    void tick();
    const timer = window.setInterval(() => { void tick(); }, HISTORY_POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [rangeHours]);

  const sample = status?.sample ?? null;
  const alerts = useMemo(() => evaluate(sample, settings), [sample, settings]);

  // Fire notifications only on the edge — when an alert first appears.
  useEffect(() => {
    const fresh = alerts.filter((alert) => !seenAlerts.current.has(alert.id));
    if (fresh.length) {
      fresh.forEach(notify);
      if (settings.sound) beep();
    }
    seenAlerts.current = new Set(alerts.map((alert) => alert.id));
  }, [alerts, settings.sound]);

  const update = (patch: Partial<AlertSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(next);
  };

  const requestNotifications = async () => {
    if (!canNotify()) return;
    setNotifState(await Notification.requestPermission());
  };

  const times = useMemo(() => history.map((row) => row.t), [history]);
  const socSeries = useMemo<Series[]>(() => [{
    key: 'soc',
    label: 'Charge',
    color: COLORS.solar,
    values: history.map((row) => row.soc),
  }], [history]);
  const powerSeries = useMemo<Series[]>(() => [
    { key: 'solar', label: 'Solar', color: COLORS.solar, values: history.map((row) => row.solarW) },
    { key: 'load', label: 'House', color: COLORS.load, values: history.map((row) => row.loadW) },
    { key: 'batt', label: 'Battery', color: COLORS.batt, values: history.map((row) => row.battW) },
  ], [history]);

  const hours = runtimeHours(sample);
  const drain = netDrainW(sample);
  const connectionProblem = Boolean(fetchError) || Boolean(status && !status.ok);

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>Enphase</h1>
          <p className="sub">
            {status?.gatewayHost ? `gateway ${status.gatewayHost}` : 'connecting…'}
            {status?.onHotspot && <span className="chip">hotspot</span>}
          </p>
        </div>
        <div className={`conn ${connectionProblem ? 'bad' : 'good'}`}>
          <span className="dot" aria-hidden="true" />
          {connectionProblem
            ? 'no data'
            : `updated ${formatAgo(sample?.t, status?.serverTime ?? Date.now() / 1000)}`}
        </div>
      </header>

      {connectionProblem && (
        <div className="banner critical" role="alert">
          <span className="banner-icon" aria-hidden="true">✕</span>
          <div>
            <strong>{fetchError ? 'Cannot reach the monitor server' : status?.error?.message}</strong>
            {status?.error?.renewUrl && (
              <p>
                Generate a new token, then restart the server:{' '}
                <a href={status.error.renewUrl}>{status.error.renewUrl}</a>
              </p>
            )}
            {fetchError && <p>Is <code>npm start</code> still running?</p>}
          </div>
        </div>
      )}

      {alerts.map((alert) => (
        <div key={alert.id} className={`banner ${alert.level}`} role="alert">
          <span className="banner-icon" aria-hidden="true">{alert.icon}</span>
          <div>
            <strong>{alert.title}</strong>
            <p>{alert.detail}</p>
          </div>
        </div>
      ))}

      <section className="hero" aria-label="Battery state of charge">
        <div className="hero-top">
          <span className="hero-label">Battery</span>
          <span className={`grid-state ${sample?.offGrid ? 'off' : 'on'}`}>
            {sample?.offGrid ? 'OFF GRID' : 'on grid'}
          </span>
        </div>
        <div className="hero-figure">
          <span className="hero-value">{sample?.soc ?? '—'}</span>
          <span className="hero-unit">%</span>
        </div>
        <div
          className="meter"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={sample?.soc ?? 0}
          aria-label="Battery charge"
        >
          <div
            className={`meter-fill ${sample && sample.soc !== null && sample.soc < settings.socBelow ? 'low' : ''}`}
            style={{ width: `${Math.max(0, Math.min(100, sample?.soc ?? 0))}%` }}
          />
        </div>
        <dl className="hero-meta">
          <div>
            <dt>Available</dt>
            <dd>{formatKwh(sample?.availWh)} of {formatKwh(sample?.capWh)}</dd>
          </div>
          <div>
            <dt>Runtime</dt>
            <dd>
              {hours === null
                ? (drain !== null && drain <= 50 ? 'solar covering load' : '—')
                : `${formatDuration(hours)} ${sample?.offGrid ? 'left' : 'if grid dropped'}`}
            </dd>
          </div>
          <div>
            <dt>Reserve</dt>
            <dd>
              {sample?.reservePct ?? '—'}%
              {(sample?.reservePct ?? 0) >= 100 && <span className="note"> full-backup</span>}
            </dd>
          </div>
        </dl>
      </section>

      <section className="tiles" aria-label="Live power">
        <Tile label="Solar" color={COLORS.solar} value={formatW(sample?.solarW)} />
        <Tile label="House" color={COLORS.load} value={formatW(sample?.loadW)} />
        <Tile
          label="Battery"
          color={COLORS.batt}
          value={formatW(typeof sample?.battW === 'number' ? Math.abs(sample.battW) : null)}
          detail={typeof sample?.battW === 'number' && Math.abs(sample.battW) > 5
            ? (sample.battW > 0 ? 'discharging' : 'charging')
            : 'idle'}
        />
        <Tile
          label="Grid"
          value={sample?.offGrid
            ? 'islanded'
            : formatW(typeof sample?.gridW === 'number' ? Math.abs(sample.gridW) : null)}
          detail={sample?.offGrid
            ? 'no utility power'
            : (typeof sample?.gridW === 'number' ? (sample.gridW > 0 ? 'importing' : 'exporting') : '')}
        />
      </section>

      <div className="controls">
        <div className="range" role="group" aria-label="Time range">
          {RANGES.map((value) => (
            <button
              key={value}
              type="button"
              className={rangeHours === value ? 'active' : ''}
              onClick={() => setRangeHours(value)}
            >
              {value}h
            </button>
          ))}
        </div>
        <button type="button" className="link" onClick={() => setShowTable((value) => !value)}>
          {showTable ? 'Hide table' : 'Show table'}
        </button>
      </div>

      <LineChart
        title="Battery charge"
        times={times}
        series={socSeries}
        domainY={[0, 100]}
        formatY={(value) => `${Math.round(value)}%`}
        formatTooltip={(value) => (value === null ? '—' : `${Math.round(value)}%`)}
        area
        legend={false}
      />

      <LineChart
        title="Power flows"
        times={times}
        series={powerSeries}
        formatY={(value) => (Math.abs(value) >= 1000 ? `${(value / 1000).toFixed(1)}kW` : `${Math.round(value)}W`)}
        formatTooltip={(value) => formatW(value)}
      />

      {showTable && (
        <div className="table-wrap">
          <table>
            <caption>Most recent samples</caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Charge</th>
                <th scope="col">Solar</th>
                <th scope="col">House</th>
                <th scope="col">Battery</th>
                <th scope="col">Grid</th>
              </tr>
            </thead>
            <tbody>
              {[...history].reverse().slice(0, 40).map((row) => (
                <tr key={row.t}>
                  <td>{formatClock(row.t)}</td>
                  <td>{row.soc === null ? '—' : `${row.soc}%`}</td>
                  <td>{formatW(row.solarW)}</td>
                  <td>{formatW(row.loadW)}</td>
                  <td>{formatW(row.battW)}</td>
                  <td>{row.offGrid ? 'islanded' : formatW(row.gridW)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <details className="settings">
        <summary>Alerts</summary>
        <div className="settings-body">
          <label>
            Warn when charge drops below
            <input
              type="number"
              min="5"
              max="95"
              value={settings.socBelow}
              onChange={(event) => update({ socBelow: Number(event.target.value) })}
            />
            %
          </label>
          <label>
            Warn when runtime drops below
            <input
              type="number"
              min="0.5"
              max="24"
              step="0.5"
              value={settings.runtimeBelow}
              onChange={(event) => update({ runtimeBelow: Number(event.target.value) })}
            />
            hours
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings.onGridLoss}
              onChange={(event) => update({ onGridLoss: event.target.checked })}
            />
            Alert when the grid goes down
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings.sound}
              onChange={(event) => update({ sound: event.target.checked })}
            />
            Play a sound on new alerts
          </label>
          {canNotify() && notifState !== 'granted' && (
            <button type="button" className="link" onClick={() => { void requestNotifications(); }}>
              Enable browser notifications
            </button>
          )}
          {!canNotify() && (
            <p className="note">
              Browser notifications need a secure origin, so they only work at
              localhost. On phones over the LAN the banner and sound still fire.
            </p>
          )}
        </div>
      </details>

      <footer className="foot">
        Reading the gateway directly — no internet or Enphase cloud involved.
        Sampling every {status?.sampleSeconds ?? '—'}s.
      </footer>
    </div>
  );
}

interface TileProps {
  label: string;
  value: string;
  detail?: string;
  color?: string;
}

function Tile({ label, value, detail, color }: TileProps) {
  return (
    <div className="tile">
      <span className="tile-label">
        {color && <span className="swatch" style={{ background: color }} aria-hidden="true" />}
        {label}
      </span>
      <span className="tile-value">{value}</span>
      <span className="tile-detail">{detail || ' '}</span>
    </div>
  );
}
