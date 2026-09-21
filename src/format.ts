import type { Sample } from './types.js';

type Maybe = number | null | undefined;

export function formatW(watts: Maybe, { sign = false }: { sign?: boolean } = {}): string {
  if (watts === null || watts === undefined || Number.isNaN(watts)) return '—';
  const prefix = sign && watts > 0 ? '+' : '';
  if (Math.abs(watts) >= 1000) return `${prefix}${(watts / 1000).toFixed(2)} kW`;
  return `${prefix}${Math.round(watts)} W`;
}

export function formatKwh(wh: Maybe, digits = 1): string {
  if (wh === null || wh === undefined || Number.isNaN(wh)) return '—';
  return `${(wh / 1000).toFixed(digits)} kWh`;
}

export function formatClock(epochSeconds: Maybe): string {
  if (!epochSeconds) return '—';
  return new Date(epochSeconds * 1000).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatDateTime(epochSeconds: Maybe): string {
  if (!epochSeconds) return '—';
  return new Date(epochSeconds * 1000).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatAgo(epochSeconds: Maybe, now: number = Date.now() / 1000): string {
  if (!epochSeconds) return 'never';
  const seconds = Math.max(0, Math.round(now - epochSeconds));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${(seconds / 3600).toFixed(1)}h ago`;
}

export function formatDuration(hours: Maybe): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return '—';
  if (hours >= 48) return '2+ days';
  const whole = Math.floor(hours);
  const minutes = Math.round((hours - whole) * 60);
  if (whole === 0) return `${minutes}m`;
  return `${whole}h ${String(minutes).padStart(2, '0')}m`;
}

/**
 * What is actually emptying the battery right now, in watts.
 * Prefers the measured battery flow; falls back to load minus solar.
 */
export function netDrainW(sample: Sample | null): number | null {
  if (!sample) return null;
  if (typeof sample.battW === 'number' && sample.battW > 5) return sample.battW;
  if (typeof sample.loadW === 'number' && typeof sample.solarW === 'number') {
    return sample.loadW - sample.solarW;
  }
  return typeof sample.loadW === 'number' ? sample.loadW : null;
}

/**
 * Hours of battery left at the given drain (the current net drain unless one
 * is passed), or null when solar covers it.
 */
export function runtimeHours(sample: Sample | null, drain: number | null = netDrainW(sample)): number | null {
  if (!sample?.availWh || drain === null || drain <= 50) return null;
  return sample.availWh / drain;
}
