import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const PAD = { top: 10, right: 68, bottom: 26, left: 48 } as const;

export interface Series {
  key: string;
  label: string;
  color: string;
  values: (number | null)[];
}

interface LineChartProps {
  title: string;
  /** Unix seconds, ascending. Shared by every series. */
  times: number[];
  series: Series[];
  domainY?: [number, number];
  formatY: (value: number) => string;
  formatTooltip?: (value: number | null) => string;
  height?: number;
  area?: boolean;
  legend?: boolean;
  emptyLabel?: string;
}

function useElementWidth(): [React.RefObject<HTMLElement | null>, number] {
  const ref = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    setWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min];
  const raw = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? magnitude * 10;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let value = start; value <= max + step / 1000; value += step) {
    out.push(Number(value.toFixed(6)));
  }
  return out;
}

function nearestIndex(times: number[], target: number): number {
  if (!times.length) return -1;
  let low = 0;
  let high = times.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (times[mid] < target) low = mid; else high = mid;
  }
  return Math.abs(times[low] - target) <= Math.abs(times[high] - target) ? low : high;
}

interface EndLabel { key: string; label: string; color: string; y: number }

/** Push labels apart so end-of-line text never overlaps. */
function spreadLabels(entries: EndLabel[], top: number, bottom: number, gap = 15): EndLabel[] {
  const sorted = [...entries].sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].y - sorted[i - 1].y < gap) sorted[i].y = sorted[i - 1].y + gap;
  }
  const overflow = sorted.length ? sorted[sorted.length - 1].y - bottom : 0;
  if (overflow > 0) {
    for (const entry of sorted) entry.y = Math.max(top, entry.y - overflow);
  }
  return sorted;
}

export default function LineChart({
  title,
  times,
  series,
  domainY,
  formatY,
  formatTooltip,
  height = 190,
  area = false,
  legend = true,
  emptyLabel = 'Collecting data…',
}: LineChartProps) {
  const [wrapRef, width] = useElementWidth();
  const [hover, setHover] = useState<number | null>(null);

  const innerWidth = Math.max(0, width - PAD.left - PAD.right);
  const innerHeight = height - PAD.top - PAD.bottom;

  const bounds = useMemo<[number, number]>(() => {
    if (domainY) return domainY;
    let min = Infinity;
    let max = -Infinity;
    for (const line of series) {
      for (const value of line.values) {
        if (value === null || Number.isNaN(value)) continue;
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }
    if (!Number.isFinite(min)) return [0, 1];
    if (min === max) return [min - 1, max + 1];
    const padding = (max - min) * 0.12;
    return [min - padding, max + padding];
  }, [domainY, series]);

  const t0 = times.length ? times[0] : 0;
  const t1 = times.length ? times[times.length - 1] : 1;

  const scaleX = useCallback(
    (t: number) => (t1 === t0 ? PAD.left : PAD.left + ((t - t0) / (t1 - t0)) * innerWidth),
    [t0, t1, innerWidth],
  );
  const scaleY = useCallback(
    (v: number) => PAD.top + (1 - (v - bounds[0]) / (bounds[1] - bounds[0])) * innerHeight,
    [bounds, innerHeight],
  );

  const yTicks = useMemo(() => niceTicks(bounds[0], bounds[1], 4), [bounds]);
  const xTicks = useMemo(() => {
    if (times.length < 2) return [];
    return [0, 0.33, 0.66, 1].map((fraction) => t0 + (t1 - t0) * fraction);
  }, [times.length, t0, t1]);
  // Clock time alone is ambiguous once the axis crosses midnight (a 48 h chart
  // shows the same times twice), so add the weekday whenever the ticks span
  // more than one calendar day.
  const formatXTick = useMemo(() => {
    const days = new Set(xTicks.map((tick) => new Date(tick * 1000).toDateString()));
    const options: Intl.DateTimeFormatOptions = days.size > 1
      ? { weekday: 'short', hour: 'numeric', minute: '2-digit' }
      : { hour: 'numeric', minute: '2-digit' };
    const formatter = new Intl.DateTimeFormat([], options);
    return (tick: number) => formatter.format(new Date(tick * 1000));
  }, [xTicks]);

  const paths = useMemo(() => series.map((line) => {
    let d = '';
    let penDown = false;
    line.values.forEach((value, index) => {
      if (value === null || Number.isNaN(value)) {
        penDown = false;
        return;
      }
      const x = scaleX(times[index]);
      const y = scaleY(value);
      d += `${penDown ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
      penDown = true;
    });
    return { ...line, d };
  }), [series, times, scaleX, scaleY]);

  const endLabels = useMemo(() => {
    const entries: EndLabel[] = [];
    paths.forEach((line) => {
      for (let i = line.values.length - 1; i >= 0; i -= 1) {
        const value = line.values[i];
        if (value === null || Number.isNaN(value)) continue;
        entries.push({ key: line.key, label: line.label, color: line.color, y: scaleY(value) });
        break;
      }
    });
    return spreadLabels(entries, PAD.top + 4, height - PAD.bottom - 2);
  }, [paths, scaleY, height]);

  const handleMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!innerWidth || times.length < 2) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const ratio = Math.min(1, Math.max(0, (x - PAD.left) / innerWidth));
    const index = nearestIndex(times, t0 + ratio * (t1 - t0));
    if (index >= 0) setHover(index);
  };

  const summary = `${title}: ${series.map((line) => line.label).join(', ')}`;
  const hasData = times.length >= 2;
  const lastX = hasData ? scaleX(times[times.length - 1]) : 0;
  const firstX = hasData ? scaleX(times[0]) : 0;
  const baseline = height - PAD.bottom;

  return (
    <figure className="chart" ref={wrapRef as React.RefObject<HTMLElement>}>
      <figcaption className="chart-head">
        <h3>{title}</h3>
        {legend && series.length > 1 && (
          <ul className="legend">
            {series.map((line) => (
              <li key={line.key}>
                <span className="swatch" style={{ background: line.color }} aria-hidden="true" />
                {line.label}
              </li>
            ))}
          </ul>
        )}
      </figcaption>

      {!hasData ? (
        <p className="chart-empty">{emptyLabel}</p>
      ) : (
        <div className="chart-body">
          <svg
            width="100%"
            height={height}
            viewBox={`0 0 ${Math.max(width, 1)} ${height}`}
            role="img"
            aria-label={summary}
            onPointerMove={handleMove}
            onPointerLeave={() => setHover(null)}
          >
            <title>{summary}</title>

            {yTicks.map((tick) => (
              <g key={tick}>
                <line
                  className="grid"
                  x1={PAD.left}
                  x2={PAD.left + innerWidth}
                  y1={scaleY(tick)}
                  y2={scaleY(tick)}
                />
                <text
                  className="tick"
                  x={PAD.left - 8}
                  y={scaleY(tick)}
                  textAnchor="end"
                  dominantBaseline="middle"
                >
                  {formatY(tick)}
                </text>
              </g>
            ))}

            {xTicks.map((tick) => (
              <text
                key={tick}
                className="tick"
                x={scaleX(tick)}
                y={baseline + 16}
                textAnchor="middle"
              >
                {formatXTick(tick)}
              </text>
            ))}

            <line className="axis" x1={PAD.left} x2={PAD.left + innerWidth} y1={baseline} y2={baseline} />

            {area && paths.length === 1 && paths[0].d && (
              <path
                d={`${paths[0].d}L${lastX.toFixed(1)} ${baseline.toFixed(1)}L${firstX.toFixed(1)} ${baseline.toFixed(1)}Z`}
                fill={paths[0].color}
                opacity="0.12"
              />
            )}

            {paths.map((line) => (
              <path
                key={line.key}
                d={line.d}
                fill="none"
                stroke={line.color}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}

            {hover !== null && (
              <g>
                <line
                  className="crosshair"
                  x1={scaleX(times[hover])}
                  x2={scaleX(times[hover])}
                  y1={PAD.top}
                  y2={baseline}
                />
                {paths.map((line) => {
                  const value = line.values[hover];
                  if (value === null || Number.isNaN(value)) return null;
                  return (
                    <circle
                      key={line.key}
                      cx={scaleX(times[hover])}
                      cy={scaleY(value)}
                      r="4"
                      fill={line.color}
                      className="marker"
                    />
                  );
                })}
              </g>
            )}

            {endLabels.map((entry) => (
              <g key={entry.key}>
                <circle cx={PAD.left + innerWidth + 10} cy={entry.y} r="3.5" fill={entry.color} />
                <text
                  className="end-label"
                  x={PAD.left + innerWidth + 18}
                  y={entry.y}
                  dominantBaseline="middle"
                >
                  {entry.label}
                </text>
              </g>
            ))}
          </svg>

          {hover !== null && (
            <div
              className="tooltip"
              style={{ left: Math.min(Math.max(scaleX(times[hover]) - 70, 0), Math.max(width - 150, 0)) }}
            >
              <div className="tooltip-time">
                {new Date(times[hover] * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              </div>
              {series.map((line) => (
                <div className="tooltip-row" key={line.key}>
                  <span className="swatch" style={{ background: line.color }} aria-hidden="true" />
                  <span className="tooltip-label">{line.label}</span>
                  <span className="tooltip-value">
                    {(formatTooltip ?? ((value: number | null) => (value === null ? '—' : formatY(value))))(line.values[hover])}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}
