/**
 * Placeholder until real villa photography exists: a soft gradient in the
 * villa's palette with a quiet line pattern. Decorative only, so screen
 * readers skip it; the villa name is always in nearby text.
 */
export function VillaImage({
  palette = ["#2f5d50", "#c9b48a"],
  className = "",
}: {
  palette?: [string, string];
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={`relative overflow-hidden ${className}`}
      style={{ background: `linear-gradient(135deg, ${palette[0]} 0%, ${palette[1]} 100%)` }}
    >
      <svg className="absolute inset-0 h-full w-full opacity-20" preserveAspectRatio="none" viewBox="0 0 100 60">
        {Array.from({ length: 8 }, (_, i) => (
          <path key={i} d={`M0 ${20 + i * 5} Q 25 ${12 + i * 5} 50 ${20 + i * 5} T 100 ${20 + i * 5}`} fill="none" stroke="#faf7f0" strokeWidth="0.4" />
        ))}
      </svg>
    </div>
  );
}
