import { runtimeHours } from './format.js';
import type { Alert, AlertSettings, Sample } from './types.js';

const STORAGE_KEY = 'enphase-local-alerts';

export const DEFAULT_SETTINGS: AlertSettings = {
  socBelow: 30,
  runtimeBelow: 2,
  onGridLoss: true,
  runtimeAvgHours: 1,
  sound: false,
};

export function loadSettings(): AlertSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AlertSettings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AlertSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* private mode — settings just won't persist */ }
}

/**
 * Active alerts for a sample. Every alert carries an icon and a label, so the
 * status colour is never the only thing carrying meaning.
 */
export function evaluate(sample: Sample | null, avgDrainW: number | null, settings: AlertSettings): Alert[] {
  if (!sample) return [];
  const active: Alert[] = [];

  if (sample.shutdown) {
    active.push({
      id: 'shutdown',
      level: 'critical',
      icon: '✕',
      title: 'Battery system reports shutdown',
      detail: 'The gateway says the storage system is shut down. Check the Enphase app.',
    });
  }

  if (sample.offGrid && settings.onGridLoss) {
    active.push({
      id: 'offgrid',
      level: 'warning',
      icon: '⚠',
      title: 'Grid is down — running on battery',
      detail: 'The system has islanded. Solar plus battery are carrying the house.',
    });
  }

  if (typeof sample.soc === 'number' && sample.soc < settings.socBelow) {
    active.push({
      id: 'soc',
      level: sample.soc < settings.socBelow / 2 ? 'critical' : 'warning',
      icon: '▼',
      title: `Battery at ${Math.round(sample.soc)}%`,
      detail: `Below your ${settings.socBelow}% threshold.`,
    });
  }

  const hours = runtimeHours(sample, avgDrainW);
  if (hours !== null && hours < settings.runtimeBelow) {
    active.push({
      id: 'runtime',
      level: 'critical',
      icon: '⏱',
      title: `About ${hours.toFixed(1)}h of battery left`,
      detail: `Below your ${settings.runtimeBelow}h threshold at the last ${settings.runtimeAvgHours}h average draw.`,
    });
  }

  return active;
}

let audioContext: AudioContext | null = null;

/** Short double beep — no audio files, so nothing to load over a dead network. */
export function beep(): void {
  try {
    const Ctor = window.AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audioContext = audioContext || new Ctor();
    const context = audioContext;
    const now = context.currentTime;
    [0, 0.28].forEach((offset) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.25, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.2);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(now + offset);
      oscillator.stop(now + offset + 0.22);
    });
  } catch { /* autoplay policy or no audio device */ }
}

export function canNotify(): boolean {
  return typeof window !== 'undefined'
    && 'Notification' in window
    && window.isSecureContext;
}

export function notify(alert: Alert): void {
  if (!canNotify() || Notification.permission !== 'granted') return;
  try {
    // eslint-disable-next-line no-new
    new Notification(alert.title, { body: alert.detail, tag: alert.id });
  } catch { /* some browsers require a service worker; the in-page banner still shows */ }
}
