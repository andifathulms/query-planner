/**
 * The lattice fill animation (DESIGN.md §6.3).
 *
 * Hand-rolled, one rAF loop, as the house rule requires. The fill must replay
 * the real search order recorded by the enumerator, not an idealised sweep:
 * cells that considered many candidates must visibly consider many, and the
 * order they resolve in is the order the DP actually filled them.
 *
 * Play, pause, step by level and step by cell, because a reader who wants to
 * follow the algorithm needs to stop it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Per-cell resolve duration and stagger, from DESIGN.md §6.2. */
const CELL_MS = 380;
const STAGGER_MS = 12;

export interface FillStep {
  key: string;
  level: number;
  /** When this cell begins resolving, in milliseconds from the start. */
  startMs: number;
}

export interface FillState {
  /** 0 before the cell starts, 1 once it has resolved. */
  progress: (key: string) => number;
  elapsed: number;
  duration: number;
  playing: boolean;
  /** True once every cell has resolved. */
  complete: boolean;
  /** The level currently resolving, 1-based; 0 before the first. */
  currentLevel: number;
  play: () => void;
  pause: () => void;
  restart: () => void;
  stepCell: () => void;
  stepLevel: () => void;
  finish: () => void;
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (): void => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/**
 * Schedule the cells: levels in sequence, cells within a level staggered.
 *
 * The enumerator's fill order is already level by level, so this only has to
 * assign times to it.
 */
export function scheduleFill(cells: Array<{ key: string; level: number }>): {
  steps: FillStep[];
  duration: number;
} {
  const steps: FillStep[] = [];
  let levelStart = 0;
  let currentLevel = cells[0]?.level ?? 1;
  let indexInLevel = 0;

  for (const cell of cells) {
    if (cell.level !== currentLevel) {
      // The next level cannot start until this one has resolved: level n is
      // built from level n-1's winners, and showing otherwise would misdescribe
      // the algorithm.
      levelStart += (indexInLevel - 1) * STAGGER_MS + CELL_MS;
      currentLevel = cell.level;
      indexInLevel = 0;
    }
    steps.push({ key: cell.key, level: cell.level, startMs: levelStart + indexInLevel * STAGGER_MS });
    indexInLevel++;
  }

  const duration = steps.length === 0
    ? 0
    : Math.max(...steps.map((s) => s.startMs)) + CELL_MS;
  return { steps, duration };
}

export function useFill(
  cells: Array<{ key: string; level: number }>,
  reducedMotion: boolean,
): FillState {
  const { steps, duration } = useMemo(() => scheduleFill(cells), [cells]);
  const byKey = useMemo(() => new Map(steps.map((s) => [s.key, s])), [steps]);

  const [elapsed, setElapsed] = useState(reducedMotion ? duration : 0);
  const [playing, setPlaying] = useState(!reducedMotion);
  const frame = useRef(0);
  const last = useRef(0);

  // A new search restarts the animation — but under reduced motion it fills
  // instantly and completely, with the stepper still available (§6.7).
  useEffect(() => {
    setElapsed(reducedMotion ? duration : 0);
    setPlaying(!reducedMotion && duration > 0);
  }, [steps, duration, reducedMotion]);

  useEffect(() => {
    if (!playing) return;
    last.current = performance.now();
    const tick = (now: number): void => {
      const delta = now - last.current;
      last.current = now;
      setElapsed((e) => {
        const next = e + delta;
        if (next >= duration) { setPlaying(false); return duration; }
        return next;
      });
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [playing, duration]);

  const progress = useCallback((key: string): number => {
    const step = byKey.get(key);
    if (!step) return 0;
    if (elapsed <= step.startMs) return 0;
    if (elapsed >= step.startMs + CELL_MS) return 1;
    return (elapsed - step.startMs) / CELL_MS;
  }, [byKey, elapsed]);

  const currentLevel = useMemo(() => {
    let level = 0;
    for (const step of steps) if (elapsed >= step.startMs) level = step.level;
    return level;
  }, [steps, elapsed]);

  const stepCell = useCallback(() => {
    setPlaying(false);
    setElapsed((e) => {
      const next = steps.find((s) => s.startMs + CELL_MS > e + 0.01);
      return next ? next.startMs + CELL_MS : duration;
    });
  }, [steps, duration]);

  const stepLevel = useCallback(() => {
    setPlaying(false);
    setElapsed((e) => {
      const level = steps.filter((s) => s.startMs <= e).at(-1)?.level ?? 0;
      const remaining = steps.filter((s) => s.level > level);
      if (remaining.length === 0) return duration;
      const nextLevel = remaining[0].level;
      const lastOfLevel = steps.filter((s) => s.level === nextLevel).at(-1)!;
      return lastOfLevel.startMs + CELL_MS;
    });
  }, [steps, duration]);

  return {
    progress,
    elapsed,
    duration,
    playing,
    complete: elapsed >= duration,
    currentLevel,
    play: useCallback(() => {
      // Playing from the end restarts, which is what a play button after a
      // finished animation is asking for.
      setElapsed((e) => (e >= duration ? 0 : e));
      setPlaying(true);
    }, [duration]),
    pause: useCallback(() => setPlaying(false), []),
    restart: useCallback(() => { setElapsed(0); setPlaying(true); }, []),
    finish: useCallback(() => { setElapsed(duration); setPlaying(false); }, [duration]),
    stepCell,
    stepLevel,
  };
}
