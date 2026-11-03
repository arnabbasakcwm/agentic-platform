// Agentic Platform — count-up hook for KPI tiles (Usage / Admin).
// Usage: const shown = useCountUp(370100); then format `shown` as you already do.
import { useEffect, useRef, useState } from 'react';

export function useCountUp(target, { duration = 600 } = {}) {
  const [value, setValue] = useState(0);
  const fromRef = useRef(0);

  useEffect(() => {
    const end = Number(target) || 0;
    const reduce = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || duration <= 0) { setValue(end); fromRef.current = end; return; }

    const start = fromRef.current;
    let raf;
    const t0 = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      setValue(start + (end - start) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = end;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  return value;
}
