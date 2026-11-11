/**
 * Scan completion ring.
 *
 * Shows how many of the stored scans reached a "completed" terminal state. It
 * is a completion rate over real rows — never a security score. The centre
 * carries the raw fraction, so the ring is readable without the colour.
 */
export function CompletionRing({
  completed,
  total,
  size = 148,
  stroke = 12,
}: {
  completed: number;
  total: number;
  size?: number;
  stroke?: number;
}) {
  const ratio = total > 0 ? Math.min(1, completed / total) : 0;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = circumference * ratio;

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${completed} of ${total} scans completed`}>
        <defs>
          <linearGradient id="ss-ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--mint)" />
            <stop offset="100%" stopColor="var(--teal)" />
          </linearGradient>
        </defs>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--line-strong)"
          strokeWidth={stroke}
          opacity="0.55"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="url(#ss-ring)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference - dash}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: "stroke-dasharray 600ms cubic-bezier(0.2,0.7,0.2,1)" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="figure text-[1.75rem] leading-none">{Math.round(ratio * 100)}%</span>
        <span className="mono mt-1.5 text-[10px] tracking-[0.1em] text-faint uppercase">completed</span>
      </div>
    </div>
  );
}
