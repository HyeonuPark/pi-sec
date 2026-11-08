/**
 * One line graph, drawn as inline SVG. A slot is one x position; a `null` value
 * breaks the line, so a slot with too few calls shows a gap and not a zero.
 * Hovering a point shows the slot time, the value and the call count, and one
 * more line when the caller gives `extra` and it returns text for the slot.
 */
import type { UsageStatsSlot } from "../../shared/wire/usage-stats.ts";
import { formatValue } from "./format.ts";

export interface Series {
  readonly name: string;
  readonly color: string;
  readonly values: readonly (number | null)[];
}

const W = 720;
const H = 240;
const LEFT = 52;
const RIGHT = 12;
const TOP = 12;
const BOTTOM = 28;

export interface ChartProps {
  readonly id: string;
  readonly title: string;
  readonly unit: string;
  readonly slots: readonly UsageStatsSlot[];
  readonly labels: readonly string[];
  readonly series: readonly Series[];
  /** An extra hover line for a slot, or `null` for none. */
  readonly extra?: (slot: UsageStatsSlot) => string | null;
}

function hover(props: ChartProps, name: string, value: number, index: number): string {
  const slot = props.slots[index];
  const text = `${props.labels[index]}\n${name}: ${formatValue(value)} ${props.unit}\n${slot?.calls ?? 0} calls`;
  const extra = slot === undefined ? null : (props.extra?.(slot) ?? null);
  return extra === null ? text : `${text}\n${extra}`;
}

export function Chart(props: ChartProps) {
  const { slots, series } = props;
  const all = series.flatMap((line) => line.values).filter((value): value is number => value !== null);
  const max = all.length === 0 ? 0 : Math.max(...all);
  const top = max > 0 ? max : 1;
  const x = (index: number): number =>
    slots.length <= 1 ? (LEFT + W - RIGHT) / 2 : LEFT + ((W - LEFT - RIGHT) * index) / (slots.length - 1);
  const y = (value: number): number => TOP + (H - TOP - BOTTOM) * (1 - value / top);
  const ticks = [0, top / 2, top];
  const edge = slots.length === 0 ? [] : [0, Math.floor((slots.length - 1) / 2), slots.length - 1];

  return (
    <figure class="stats-chart" id={props.id}>
      <figcaption class="stats-chart-title">
        {props.title} <span class="stats-unit">({props.unit})</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={props.title} class="stats-svg">
        {ticks.map((tick) => (
          <g key={tick} class="stats-tick">
            <line x1={LEFT} x2={W - RIGHT} y1={y(tick)} y2={y(tick)} class="stats-grid" />
            <text x={LEFT - 6} y={y(tick) + 4} text-anchor="end" class="stats-axis">
              {formatValue(tick)}
            </text>
          </g>
        ))}
        {[...new Set(edge)].map((index) => (
          <text key={index} x={x(index)} y={H - 8} text-anchor="middle" class="stats-axis">
            {props.labels[index]}
          </text>
        ))}
        {series.map((line) => {
          const segments: string[] = [];
          let run: string[] = [];
          line.values.forEach((value, index) => {
            if (value === null) {
              if (run.length > 1) segments.push(run.join(" "));
              run = [];
            } else {
              run.push(`${x(index).toFixed(1)},${y(value).toFixed(1)}`);
            }
          });
          if (run.length > 1) segments.push(run.join(" "));
          return (
            <g key={line.name} class="stats-line" data-series={line.name} style={{ color: line.color }}>
              {segments.map((points) => (
                <polyline key={points} points={points} fill="none" stroke="currentColor" stroke-width="2" />
              ))}
              {line.values.map((value, index) =>
                value === null ? null : (
                  <circle key={index} cx={x(index)} cy={y(value)} r="3.5" fill="currentColor" class="stats-point">
                    <title>{hover(props, line.name, value, index)}</title>
                  </circle>
                ),
              )}
            </g>
          );
        })}
        {all.length === 0 ? (
          <text x={(LEFT + W - RIGHT) / 2} y={H / 2} text-anchor="middle" class="stats-axis">
            Fewer than 3 calls in every slot
          </text>
        ) : null}
      </svg>
      {series.length > 1 ? (
        <ul class="stats-legend">
          {series.map((line) => (
            <li key={line.name}>
              <span class="stats-swatch" style={{ background: line.color }} /> {line.name}
            </li>
          ))}
        </ul>
      ) : null}
    </figure>
  );
}
