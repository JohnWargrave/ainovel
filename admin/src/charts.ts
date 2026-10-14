// Inline SVG charts. No dependency: the CMS is vanilla TS returning template strings, and every
// form used here (line, horizontal bar) is a few dozen lines of geometry — a charting library would
// be the largest thing in the bundle and would fight the existing render-by-string model.
//
// Palette and mark specs come from the shared data-viz method:
//  - series colors are fixed categorical slots, assigned per entity and never by rank, so filtering
//    a series out never repaints the others;
//  - one measure across nominal categories gets ONE color, never a darker-where-bigger ramp;
//  - 2px lines, ≥8px markers with a 2px surface ring, 4px rounded data-ends, hairline solid grid;
//  - text never wears the series color — identity comes from the mark beside it.

// Categorical slots 1 and 2. Assigned by entity: minted is always blue, burned is always orange,
// in every chart on the page.
export const SERIES_MINTED = '#1677ff';
export const SERIES_BURNED = '#eb6834';

const SURFACE = '#ffffff';
const GRID = '#f0f0f0';
const AXIS_INK = 'rgba(0, 0, 0, 0.45)';
const VALUE_INK = 'rgba(0, 0, 0, 0.88)';

const VIEW_W = 720;

function escapeText(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

/** 1,284 / 12.9K / 4.2M — for axis ticks and bar tips, where full precision is noise. */
export function compact(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (magnitude >= 10_000) return `${(value / 1_000).toFixed(1)}K`;
  return new Intl.NumberFormat().format(Math.round(value));
}

export function exact(value: number): string {
  return new Intl.NumberFormat().format(value);
}

export function usd(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(value);
}

/** Round the axis top to a clean number so ticks read 0 / 2,000 / 4,000 rather than 0 / 1,873. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exponent = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * exponent) return step * exponent;
  }
  return 10 * exponent;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export interface ChartSeries {
  label: string;
  color: string;
  values: number[];
}

export interface LineChartOptions {
  /** One label per x position; only a handful are drawn, the rest live in the tooltip. */
  labels: string[];
  series: ChartSeries[];
  format: (value: number) => string;
  height?: number;
}

/**
 * One y-axis, always. Two measures of different units never share a plot — the alignment of two
 * scales is arbitrary and invents a correlation the data does not contain. Callers pass series that
 * are already in the same unit.
 */
export function lineChart(options: LineChartOptions): string {
  const { labels, series, format } = options;
  const height = options.height ?? 240;
  const pad = { top: 14, right: 64, bottom: 26, left: 58 };
  const plotW = VIEW_W - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const count = labels.length;

  if (count < 2 || series.length === 0) {
    return `<p class="viz-empty">Not enough data to plot yet.</p>`;
  }

  const peak = Math.max(...series.flatMap((entry) => entry.values), 0);
  const top = niceMax(peak);
  const x = (index: number): number => pad.left + (index / (count - 1)) * plotW;
  const y = (value: number): number => pad.top + plotH - (value / top) * plotH;

  const ticks = [0, top / 2, top];
  const grid = ticks
    .map(
      (tick) =>
        `<line x1="${pad.left}" x2="${pad.left + plotW}" y1="${y(tick).toFixed(1)}" y2="${y(tick).toFixed(1)}" stroke="${GRID}" stroke-width="1" />` +
        `<text x="${pad.left - 8}" y="${(y(tick) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${AXIS_INK}" style="font-variant-numeric:tabular-nums">${escapeText(compact(tick))}</text>`,
    )
    .join('');

  // Up to five x labels, always including both ends, so the range is readable without crowding.
  const labelStep = Math.max(1, Math.ceil((count - 1) / 4));
  const xLabels = labels
    .map((label, index) => {
      if (index !== count - 1 && index % labelStep !== 0) return '';
      const anchor = index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle';
      return `<text x="${x(index).toFixed(1)}" y="${height - 8}" text-anchor="${anchor}" font-size="11" fill="${AXIS_INK}">${escapeText(label.slice(5))}</text>`;
    })
    .join('');

  const paths = series
    .map((entry) => {
      const points = entry.values
        .map(
          (value, index) =>
            `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)} ${y(value).toFixed(1)}`,
        )
        .join(' ');
      // A single series gets a 10% wash beneath it; two would muddy where they overlap, so the
      // lines carry it alone.
      const fill =
        series.length === 1
          ? `<path d="${points} L${x(count - 1).toFixed(1)} ${y(0).toFixed(1)} L${x(0).toFixed(1)} ${y(0).toFixed(1)} Z" fill="${entry.color}" fill-opacity="0.1" />`
          : '';
      return `${fill}<path d="${points}" fill="none" stroke="${entry.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`;
    })
    .join('');

  const lastIndex = count - 1;
  const endYs = series.map((entry) => y(entry.values[lastIndex] ?? 0));
  // Converging lines make stacked end-labels detach from their series and read as noise. The
  // documented fallback is to drop them and let the legend and tooltip carry identity.
  const endLabelsFit =
    endYs.length < 2 ||
    endYs.every((value, index) => index === 0 || Math.abs(value - (endYs[index - 1] ?? 0)) >= 13);

  const markers = series
    .map((entry, index) => {
      const cy = (endYs[index] ?? 0).toFixed(1);
      const dot = `<circle cx="${x(lastIndex).toFixed(1)}" cy="${cy}" r="4" fill="${entry.color}" stroke="${SURFACE}" stroke-width="2" />`;
      const label = endLabelsFit
        ? `<text x="${(x(lastIndex) + 10).toFixed(1)}" y="${(Number(cy) + 4).toFixed(1)}" font-size="11" fill="${VALUE_INK}" style="font-variant-numeric:tabular-nums">${escapeText(compact(entry.values[lastIndex] ?? 0))}</text>`
        : '';
      return dot + label;
    })
    .join('');

  // Hit targets span the whole column, not the 8px dot — a pinpoint target is unusable.
  const band = plotW / Math.max(count - 1, 1);
  const hits = labels
    .map((label, index) => {
      const tip = [
        label,
        ...series.map((entry) => `${entry.label}: ${format(entry.values[index] ?? 0)}`),
      ].join('\n');
      return `<rect x="${(x(index) - band / 2).toFixed(1)}" y="${pad.top}" width="${band.toFixed(1)}" height="${plotH}" fill="transparent" tabindex="0" data-tip="${escapeText(tip)}" data-tip-x="${x(index).toFixed(1)}" />`;
    })
    .join('');

  return `<svg class="viz" viewBox="0 0 ${VIEW_W} ${height}" role="img" preserveAspectRatio="xMidYMid meet">
    ${grid}
    <line class="viz-crosshair" x1="0" x2="0" y1="${pad.top}" y2="${pad.top + plotH}" stroke="${AXIS_INK}" stroke-width="1" opacity="0" />
    ${paths}
    ${markers}
    ${xLabels}
    ${hits}
  </svg>`;
}

export interface BarRow {
  label: string;
  value: number;
}

/**
 * One measure across nominal categories, so every bar is the same color. Shading bars
 * darker-where-bigger would double-encode length as hue and burn the only free channel on
 * information the bar already shows.
 */
export function categoryBarChart(options: {
  rows: BarRow[];
  color: string;
  format: (value: number) => string;
}): string {
  const { rows, color, format } = options;
  if (rows.length === 0) return `<p class="viz-empty">Nothing recorded in this range.</p>`;

  const rowH = 26;
  const barH = 14;
  const labelW = 200;
  const valueW = 74;
  const plotW = VIEW_W - labelW - valueW;
  const height = rows.length * rowH + 4;
  const top = niceMax(Math.max(...rows.map((row) => row.value), 0));

  const bars = rows
    .map((row, index) => {
      // Rows are spaced by rowH against a barH of 14, so touching bars are already separated by
      // surface rather than by a stroke drawn around them.
      const yTop = index * rowH + (rowH - barH) / 2 + 2;
      const width = Math.max((row.value / top) * plotW, 0);
      const radius = Math.min(4, width);
      // Rounded at the data end, square at the baseline.
      const path =
        width <= radius
          ? `<rect x="${labelW}" y="${yTop}" width="${width.toFixed(1)}" height="${barH}" fill="${color}" />`
          : `<path d="M${labelW} ${yTop} H${(labelW + width - radius).toFixed(1)} A${radius} ${radius} 0 0 1 ${(labelW + width).toFixed(1)} ${yTop + radius} V${yTop + barH - radius} A${radius} ${radius} 0 0 1 ${(labelW + width - radius).toFixed(1)} ${yTop + barH} H${labelW} Z" fill="${color}" />`;
      return `<g>
        <text x="0" y="${yTop + barH - 2}" font-size="12" fill="${AXIS_INK}">${escapeText(truncate(row.label, 28))}</text>
        ${path}
        <text x="${(labelW + width + 8).toFixed(1)}" y="${yTop + barH - 2}" font-size="12" fill="${VALUE_INK}" style="font-variant-numeric:tabular-nums">${escapeText(format(row.value))}</text>
        <rect x="0" y="${index * rowH}" width="${VIEW_W}" height="${rowH}" fill="transparent" tabindex="0" data-tip="${escapeText(`${row.label}\n${format(row.value)}`)}" />
      </g>`;
    })
    .join('');

  return `<svg class="viz" viewBox="0 0 ${VIEW_W} ${height}" role="img" preserveAspectRatio="xMidYMid meet">${bars}</svg>`;
}

/** A legend is the dependable identity channel; two or more series always get one. */
export function legend(series: ChartSeries[]): string {
  if (series.length < 2) return '';
  return `<div class="viz-legend">${series
    .map(
      (entry) =>
        `<span class="viz-key"><i style="background:${entry.color}"></i>${escapeText(entry.label)}</span>`,
    )
    .join('')}</div>`;
}

/** The table twin. Tooltips enhance; they never gate access to a value. */
export function seriesTable(
  labels: string[],
  series: ChartSeries[],
  format: (value: number) => string,
): string {
  return `<details class="viz-table">
    <summary>Data table</summary>
    <table>
      <thead><tr><th>Date</th>${series.map((entry) => `<th>${escapeText(entry.label)}</th>`).join('')}</tr></thead>
      <tbody>
        ${labels
          .map(
            (label, index) =>
              `<tr><td>${escapeText(label)}</td>${series
                .map((entry) => `<td>${escapeText(format(entry.values[index] ?? 0))}</td>`)
                .join('')}</tr>`,
          )
          .join('')}
      </tbody>
    </table>
  </details>`;
}

/**
 * One shared tooltip element for every chart on the page. Bound to focus as well as hover so the
 * same values are reachable from the keyboard.
 */
export function wireChartTooltips(): void {
  const existing = document.querySelector<HTMLDivElement>('#vizTooltip');
  const tooltip = existing ?? document.createElement('div');
  if (!existing) {
    tooltip.id = 'vizTooltip';
    tooltip.className = 'viz-tooltip';
    document.body.append(tooltip);
  }
  tooltip.style.opacity = '0';

  const show = (target: SVGElement, clientX?: number, clientY?: number): void => {
    const tip = target.getAttribute('data-tip');
    if (!tip) return;
    tooltip.textContent = tip;
    tooltip.style.opacity = '1';
    const box = target.getBoundingClientRect();
    const left = clientX ?? box.left + box.width / 2;
    const topEdge = clientY ?? box.top;
    tooltip.style.left = `${String(Math.round(left))}px`;
    tooltip.style.top = `${String(Math.round(topEdge + window.scrollY - 12))}px`;

    const crosshairX = target.getAttribute('data-tip-x');
    const crosshair = target.ownerSVGElement?.querySelector<SVGLineElement>('.viz-crosshair');
    if (crosshair && crosshairX) {
      crosshair.setAttribute('x1', crosshairX);
      crosshair.setAttribute('x2', crosshairX);
      crosshair.setAttribute('opacity', '0.35');
    }
  };

  const hide = (target: SVGElement): void => {
    tooltip.style.opacity = '0';
    target.ownerSVGElement
      ?.querySelector<SVGLineElement>('.viz-crosshair')
      ?.setAttribute('opacity', '0');
  };

  document.querySelectorAll<SVGElement>('[data-tip]').forEach((target) => {
    target.addEventListener('mousemove', (event) => {
      show(target, event.clientX, event.clientY);
    });
    target.addEventListener('mouseleave', () => {
      hide(target);
    });
    target.addEventListener('focus', () => {
      show(target);
    });
    target.addEventListener('blur', () => {
      hide(target);
    });
  });
}
