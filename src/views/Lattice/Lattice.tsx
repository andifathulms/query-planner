/**
 * The lattice (DESIGN.md §5.1, PRD §5.1) — the hero.
 *
 * Selinger's dynamic programming table, animated as it fills. Level 1 at the
 * bottom, every single relation with its best access path; level 2 every pair,
 * each built from the level-1 results; up to the root.
 *
 * Nobody visualises this, and it is the strongest single reason to build the
 * app. Each cell resolves to a winner while its alternatives drain to
 * `--pruned`, so the density of losers is visible — a level-4 cell often
 * considered a dozen plans and kept one.
 *
 * Selecting a cell turns the lattice from an animation that plays once into a
 * navigable record of the entire search.
 */
import { useCallback, useMemo, useState } from 'react';
import { OperatorGlyph } from '../PlanTree/glyphs.js';
import type { useFill } from '../../ui/useFill.js';
import { cost as formatCost, exact, plural } from '../../ui/format.js';
import type { DpCell } from '../../planner/selinger.js';
import type { EnumerationResult } from '../../planner/index.js';
import { DataTable } from '../../ui/DataTable.js';
import { cost as cellCost } from '../../ui/format.js';
import './Lattice.css';

const CELL_W = 64;
const CELL_H = 40;
const GAP = 6;

export interface LatticeProps {
  planning: EnumerationResult | null;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  /** Owned by the shell, because the plan tree's descent waits on it (§6.3). */
  fill: ReturnType<typeof useFill>;
}

export function Lattice({ planning, selectedKey, onSelect, fill }: LatticeProps) {
  // Cells within a level are ordered by relation set and that order never
  // changes between renders: a cell must not move.
  const levels = useMemo(() => groupByLevel(planning?.cells ?? []), [planning]);

  // Levels top to bottom, as painted, so arrow keys move the way the eye does.
  const rows = useMemo(
    () => [...levels].reverse().map((cells) => cells.filter((c) => c.best !== null)),
    [levels],
  );

  // One tab stop for the whole lattice, arrows to move inside it. Every cell
  // carried tabIndex 0, so an eight-table search put 255 stops between the query
  // and the plan tree below: reachable, and not operable (WCAG 2.1.1). This is
  // the composite-widget pattern the plan tree already uses.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const firstKey = rows.flat()[0]?.key ?? null;
  const roving = rows.some((r) => r.some((c) => c.key === focusKey)) ? focusKey : firstKey;

  const move = useCallback((from: string, key: string): void => {
    let r = rows.findIndex((row) => row.some((c) => c.key === from));
    if (r < 0) return;
    let col = rows[r].findIndex((c) => c.key === from);

    if (key === 'ArrowLeft') col -= 1;
    else if (key === 'ArrowRight') col += 1;
    else if (key === 'ArrowUp') r -= 1;
    else if (key === 'ArrowDown') r += 1;
    else if (key === 'Home') col = 0;
    else if (key === 'End') col = rows[r].length - 1;
    else return;

    // Clamp rather than wrap: a lattice has edges and pretending otherwise
    // loses a reader who is counting levels.
    r = Math.min(Math.max(r, 0), rows.length - 1);
    col = Math.min(Math.max(col, 0), Math.max(rows[r].length - 1, 0));

    const next = rows[r][col];
    if (!next) return;
    setFocusKey(next.key);
    document.querySelector<SVGGElement>(`[data-cell="${next.key}"]`)?.focus();
  }, [rows]);

  if (!planning) {
    return <p className="t-prose lattice-empty">
        Nothing to search. Once the query above parses, every combination of its tables
        appears here with the cheapest plan found for it.
      </p>;
  }

  const rootKey = planning.cells.find((c) => c.level === levels.length)?.key ?? null;

  return (
    <div className="lattice">
      {/* The diagram sits on a sunken canvas: drawn straight onto panel ground
          it has no edge and no floor (DESIGN.md §4.5). */}
      <div className="lattice-levels canvas">
        {/* Level 1 at the bottom, so the search reads upward as it builds.
            Reversed here rather than with column-reverse: laying it out in
            reverse put the tab order at odds with the visual order, walking the
            screen bottom to top (WCAG 2.4.3). The direction the algorithm runs
            is not a reason to make a reader tab backwards through it. */}
        {[...levels].reverse().map((cells) => (
          <Level
            key={cells[0].level}
            cells={cells}
            fill={fill}
            selectedKey={selectedKey}
            rootKey={rootKey}
            onSelect={onSelect}
            rovingKey={roving}
            onMove={move}
          />
        ))}
      </div>

      <Controls fill={fill} planning={planning} />

      <DataTable
        caption="The search"
        columns={['subset', 'level', 'winner', 'cost', 'candidates', 'orders kept']}
        rows={planning.cells.map((cell) => [
          [...cell.relations].sort().join(''),
          cell.level,
          cell.best?.operator ?? 'not joined',
          cell.best ? cellCost(cell.best.cost.total) : '-',
          cell.considered.length,
          cell.bestByOrder.size,
        ])}
      />
    </div>
  );
}

function Level({
  cells, fill, selectedKey, rootKey, onSelect, rovingKey, onMove,
}: {
  cells: DpCell[];
  fill: ReturnType<typeof useFill>;
  selectedKey: string | null;
  rootKey: string | null;
  onSelect: (key: string | null) => void;
  rovingKey: string | null;
  onMove: (from: string, key: string) => void;
}) {
  const level = cells[0].level;
  const width = cells.length * (CELL_W + GAP);

  // One listener on the level group, hit-tested by data attribute (CLAUDE.md
  // §7). At level 4 of an 8-relation search there are 70 cells, and attaching a
  // listener to each is the thing that makes a lattice this size feel slow.
  const onClick = useCallback((event: React.MouseEvent) => {
    const target = (event.target as Element).closest('[data-cell]');
    const key = target?.getAttribute('data-cell');
    if (key) onSelect(key === selectedKey ? null : key);
  }, [onSelect, selectedKey]);

  return (
    <div className="lattice-level">
      {/* The level label is pinned left while the cells scroll (§4.5). */}
      <div className="lattice-level-label t-micro" aria-hidden="true">L{level}</div>
      <div className="lattice-level-scroll scroll-x">
        <svg
          width={Math.max(width, 1)}
          height={CELL_H + 2}
          role="group"
          aria-label={`Level ${level}: ${cells.length} ${plural(cells.length, 'subset')}`}
        >
          <g onClick={onClick}>
            {cells.map((cell, i) => (
              <Cell
                key={cell.key}
                cell={cell}
                x={i * (CELL_W + GAP)}
                progress={fill.progress(cell.key)}
                rovingKey={rovingKey}
                onMove={onMove}
                selected={cell.key === selectedKey}
                isRoot={cell.key === rootKey}
                onSelect={onSelect}
              />
            ))}
          </g>
        </svg>
      </div>
    </div>
  );
}

function Cell({
  cell, x, progress, selected, isRoot, onSelect, rovingKey, onMove,
}: {
  cell: DpCell;
  x: number;
  progress: number;
  selected: boolean;
  isRoot: boolean;
  onSelect: (key: string | null) => void;
  rovingKey: string | null;
  onMove: (from: string, key: string) => void;
}) {
  const label = [...cell.relations].sort().join('');
  const resolved = progress >= 1;
  const winner = cell.best;

  // A cell with no plan is not a gap in the picture: it is a subset the search
  // declined to join because nothing connects it. Drawn recessed, it shows
  // exactly what the cartesian toggle excludes.
  if (!winner) {
    return (
      <g className="lattice-cell is-empty" data-cell={cell.key} transform={`translate(${x}, 1)`}>
        <title>{`${label}: no clause connects these relations`}</title>
        <rect width={CELL_W} height={CELL_H} rx={2} className="lattice-cell-box" />
        <text className="t-micro lattice-cell-label" x={CELL_W / 2} y={CELL_H / 2 + 3}>{label}</text>
      </g>
    );
  }

  const orders = cell.bestByOrder.size;

  const description = `${label}: ${winner.operator}, cost ${formatCost(winner.cost.total)}, `
    + `${exact(cell.considered.length)} ${plural(cell.considered.length, 'candidate')}`
    + (orders > 0 ? `, ${orders} ${plural(orders, 'order')} retained` : '');

  return (
    <g
      className={`lattice-cell${resolved ? ' is-resolved' : ''}${selected ? ' is-selected' : ''}${isRoot ? ' is-root' : ''}`}
      data-cell={cell.key}
      transform={`translate(${x}, 1)`}
      role="button"
      tabIndex={cell.key === rovingKey ? 0 : -1}
      aria-pressed={selected}
      aria-label={description}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(selected ? null : cell.key);
          return;
        }
        // Arrows, Home and End move within the lattice. Everything else, Tab
        // included, leaves it, which is the whole point of one tab stop.
        if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') {
          e.preventDefault();
          onMove(cell.key, e.key);
        }
      }}
      style={{ opacity: progress === 0 ? 0.28 : 1 }}
    >
      {/* No <title>: it repeated aria-label word for word, which buys a tooltip
          at the cost of every screen reader hearing the cell twice. */}
      <rect width={CELL_W} height={CELL_H} rx={2} className="lattice-cell-box" />

      <text className="t-micro lattice-cell-label" x={5} y={11}>{label}</text>

      {/* Candidates drawn as small marks: the winner in ink, the losers drained.
          The density of losers is the point. */}
      <g className="lattice-cell-candidates" transform={`translate(5, ${CELL_H - 15})`}>
        {cell.considered.slice(0, 14).map((candidate, i) => (
          <rect
            key={candidate.id}
            x={(i % 7) * 4}
            y={Math.floor(i / 7) * 4}
            width={2.5}
            height={2.5}
            className={i === 0 && resolved ? 'is-winner' : 'is-pruned'}
            style={{ opacity: resolved ? 1 : Math.max(0, progress * 2 - 0.5) }}
          />
        ))}
      </g>

      {resolved && (
        <>
          <g transform={`translate(${CELL_W - 18}, 4)`}>
            <OperatorGlyph operator={winner.operator} size={11} />
          </g>
          <text className="t-micro lattice-cell-cost" x={CELL_W - 5} y={CELL_H - 5}>
            {formatCost(winner.cost.total)}
          </text>
        </>
      )}

      {/* A cell may hold two plans: the cheapest, and the cheapest sorted. The
          second carries its own small mark, because that retention is what lets
          a merge join ever win. */}
      {orders > 0 && resolved && (
        <rect className="lattice-cell-order" x={CELL_W - 4} y={2} width={2} height={CELL_H - 4} rx={1}>
          <title>{`${orders} ${plural(orders, 'plan')} retained for an interesting order`}</title>
        </rect>
      )}

    </g>
  );
}

function Controls({
  fill, planning,
}: { fill: ReturnType<typeof useFill>; planning: EnumerationResult }) {
  return (
    <div className="lattice-controls">
      <div className="lattice-buttons">
        <button type="button" onClick={fill.playing ? fill.pause : fill.play} className="control">
          {fill.playing ? 'pause' : fill.complete ? 'replay' : 'play'}
        </button>
        <button type="button" onClick={fill.stepCell} className="control" disabled={fill.complete}>
          step cell
        </button>
        <button type="button" onClick={fill.stepLevel} className="control" disabled={fill.complete}>
          step level
        </button>
        <button type="button" onClick={fill.finish} className="control" disabled={fill.complete}>
          fill
        </button>
      </div>
      <p className="lattice-status t-data" role="status">
        {fill.complete
          ? `${exact(planning.stats.filledSubsets)} of ${exact(planning.stats.subsets)} `
            + `table combinations planned · ${exact(planning.stats.candidates)} candidate plans · `
            + `${exact(planning.stats.ordersKept)} kept for their sort order`
          : `filling level ${fill.currentLevel}`}
      </p>
    </div>
  );
}

/** Levels in ascending order, cells within a level ordered by relation set. */
function groupByLevel(cells: DpCell[]): DpCell[][] {
  const levels = new Map<number, DpCell[]>();
  for (const cell of cells) {
    const list = levels.get(cell.level);
    if (list) list.push(cell);
    else levels.set(cell.level, [cell]);
  }
  return [...levels.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, list]) => list.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)));
}
