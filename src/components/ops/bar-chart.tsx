/**
 * A single-series bar chart in plain HTML: thin bars on a shared baseline,
 * 2px gaps, rounded data ends, a recessive axis, and a tooltip on hover or
 * keyboard focus. Every value is also available in the table under it.
 */
export function BarChart({
  title,
  points,
  max,
  format,
  tableLabel,
  columnLabel,
}: {
  title: string;
  points: Array<{ key: string; label: string; short: string; value: number }>;
  /** Top of the scale (for example 1 for a share). */
  max?: number;
  format: (value: number) => string;
  tableLabel: string;
  columnLabel: string;
}) {
  const top = Math.max(max ?? 0, ...points.map((p) => p.value), 1e-9);
  const every = Math.max(1, Math.ceil(points.length / 8));
  return (
    <figure className="rounded-xl border border-line bg-white/70 p-4">
      <figcaption className="text-sm font-medium text-ink">{title}</figcaption>
      <div className="mt-3 grid grid-cols-[auto_1fr] gap-x-2">
        <div className="flex h-36 flex-col justify-between text-right text-[11px] text-stone">
          <span>{format(top)}</span>
          <span>{format(0)}</span>
        </div>
        <div className="relative h-36 border-b border-line">
          <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-line/70" />
          <div className="absolute inset-0 flex items-end gap-[2px]">
            {points.map((p) => (
              <div key={p.key} tabIndex={0} className="group relative flex h-full flex-1 items-end outline-none" aria-label={`${p.label}: ${format(p.value)}`}>
                <div
                  className="w-full rounded-t-[4px] bg-lagoon group-hover:bg-lagoon-deep group-focus-visible:bg-lagoon-deep"
                  style={{ height: `${Math.max(0, (p.value / top) * 100)}%`, minHeight: p.value > 0 ? 2 : 0 }}
                />
                <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-line bg-white px-2 py-1 text-[11px] text-ink shadow-md group-hover:block group-focus-visible:block">
                  {p.label}: <span className="font-medium">{format(p.value)}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
        <span />
        <div className="relative mt-1 h-4 text-[10px] text-stone">
          {points.map((p, i) =>
            i % every === 0 ? (
              <span key={p.key} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${((i + 0.5) / points.length) * 100}%` }}>
                {p.short}
              </span>
            ) : null,
          )}
        </div>
      </div>
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer text-lagoon">{tableLabel}</summary>
        <table className="mt-2 w-full text-left">
          <thead className="text-stone">
            <tr>
              <th className="py-1 font-normal" />
              <th className="py-1 text-right font-normal">{columnLabel}</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.key} className="border-t border-line/60">
                <td className="py-1 text-ink">{p.label}</td>
                <td className="py-1 text-right text-ink">{format(p.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
