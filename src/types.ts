/** One reading of the system, as stored in history and sent to the UI. */
export interface Sample {
  /** Unix seconds. */
  t: number;
  /** Aggregate battery state of charge, percent. */
  soc: number | null;
  /** Usable energy left, watt-hours. */
  availWh: number | null;
  /** Commissioned capacity, watt-hours. */
  capWh: number | null;
  /** Aggregate state of health, percent. */
  sohPct: number | null;
  /** Backup reserve setting, percent. 100 means full-backup mode. */
  reservePct: number | null;
  /** True when the system has islanded — the grid is down. */
  offGrid: boolean;
  shutdown: boolean;
  solarW: number | null;
  loadW: number | null;
  /** Positive imports from the grid, negative exports. */
  gridW: number | null;
  /** Positive discharges the battery, negative charges it. */
  battW: number | null;
}

export interface GatewayError {
  kind: 'token' | 'network';
  message: string;
  renewUrl?: string;
}

export interface StatusResponse {
  ok: boolean;
  error: GatewayError | null;
  sample: Sample | null;
  gatewayHost: string;
  onHotspot: boolean;
  sampleSeconds: number;
  serverTime: number;
}

export interface HistoryResponse {
  hours: number;
  samples: Sample[];
}

export type AlertLevel = 'critical' | 'warning';

export interface Alert {
  id: string;
  level: AlertLevel;
  icon: string;
  title: string;
  detail: string;
}

export interface AlertSettings {
  socBelow: number;
  runtimeBelow: number;
  onGridLoss: boolean;
  sound: boolean;
}
