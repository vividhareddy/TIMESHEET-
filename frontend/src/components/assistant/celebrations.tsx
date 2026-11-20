import { useMemo, type CSSProperties } from 'react';

/**
 * Purely decorative celebration effects for the assistant (CSS animations, no libraries). Every element is
 * aria-hidden and pointer-events-none, and index.css hides them all when the user prefers reduced motion.
 */

const COLORS = ['#3b6db3', '#5b8fd8', '#0f8a7a', '#2dd4bf', '#f59e0b', '#fbbf24', '#7a5bb8', '#a78bfa', '#f472b6', '#38bdf8'];

/** Small deterministic pseudo-random numbers, so each burst looks varied without Math.random in render. */
function rand(seed: number): () => number {
  let s = seed % 2147483647 || 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

type Shape = 'rect' | 'circle' | 'streamer';
const SHAPE_CLASS: Record<Shape, string> = {
  rect: 'h-2.5 w-1.5 rounded-[1px]',
  circle: 'h-2 w-2 rounded-full',
  streamer: 'h-4 w-[3px] rounded-full',
};

/** Party poppers: confetti shoots up from both bottom corners and falls away. */
export function PartyBurst({ seed }: { seed: number }) {
  const bits = useMemo(() => {
    const r = rand(seed);
    const shapes: Shape[] = ['rect', 'circle', 'streamer'];
    return Array.from({ length: 56 }, (_, i) => {
      const fromLeft = i % 2 === 0;
      const spread = 60 + r() * 260;
      return {
        left: fromLeft,
        shape: shapes[Math.floor(r() * 3)]!,
        color: COLORS[Math.floor(r() * COLORS.length)]!,
        style: {
          '--x': `${fromLeft ? spread : -spread}px`,
          '--peak': `${-(220 + r() * 300)}px`,
          '--fall': `${-(40 + r() * 140)}px`,
          '--r': `${(r() > 0.5 ? 1 : -1) * (180 + r() * 540)}deg`,
          '--dur': `${1500 + r() * 900}ms`,
          '--delay': `${r() * 220}ms`,
        } as CSSProperties,
      };
    });
  }, [seed]);
  return (
    <div className="pointer-events-none absolute inset-0 z-[60] overflow-hidden" aria-hidden>
      {bits.map((b, i) => (
        <span
          key={i}
          className={`party-bit absolute bottom-6 ${b.left ? 'left-6' : 'right-6'} ${SHAPE_CLASS[b.shape]}`}
          style={{ ...b.style, background: b.color }}
        />
      ))}
    </div>
  );
}

/** Confetti rain over the whole panel (used when a leave request is sent). */
export function ConfettiRain({ seed }: { seed: number }) {
  const bits = useMemo(() => {
    const r = rand(seed);
    const shapes: Shape[] = ['rect', 'circle', 'streamer'];
    return Array.from({ length: 48 }, () => ({
      shape: shapes[Math.floor(r() * 3)]!,
      color: COLORS[Math.floor(r() * COLORS.length)]!,
      style: {
        left: `${r() * 100}%`,
        '--x': `${(r() - 0.5) * 120}px`,
        '--fall': `${420 + r() * 320}px`,
        '--r': `${(r() > 0.5 ? 1 : -1) * (240 + r() * 600)}deg`,
        '--dur': `${1800 + r() * 1200}ms`,
        '--delay': `${r() * 500}ms`,
      } as CSSProperties,
    }));
  }, [seed]);
  return (
    <div className="pointer-events-none absolute inset-0 z-[60] overflow-hidden" aria-hidden>
      {bits.map((b, i) => (
        <span key={i} className={`rain-bit absolute -top-3 ${SHAPE_CLASS[b.shape]}`} style={{ ...b.style, background: b.color }} />
      ))}
    </div>
  );
}

export interface SparkleBurst {
  id: number;
  x: number;
  y: number;
}

/** Tiny stars that burst out from where the user clicked an option. */
export function Sparkles({ bursts }: { bursts: SparkleBurst[] }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-[65] overflow-hidden" aria-hidden>
      {bursts.map((b) =>
        Array.from({ length: 8 }, (_, i) => {
          const angle = (i / 8) * Math.PI * 2;
          const dist = 22 + (i % 2) * 10;
          return (
            <span
              key={`${b.id}-${i}`}
              className="sparkle-bit absolute text-[10px] leading-none"
              style={
                {
                  left: b.x,
                  top: b.y,
                  color: COLORS[(b.id + i) % COLORS.length],
                  '--x': `${Math.cos(angle) * dist}px`,
                  '--y': `${Math.sin(angle) * dist}px`,
                } as CSSProperties
              }
            >
              ✦
            </span>
          );
        }),
      )}
    </div>
  );
}

/** A check mark that draws itself, for success messages. */
export function DrawnCheck() {
  return (
    <span className="pop-bounce mr-2 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500 align-[-4px] text-white shadow-sm">
      <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none">
        <path className="check-draw" d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
