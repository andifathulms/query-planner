/**
 * B+tree over one column, supporting equality and range lookups.
 *
 * Leaves are chained so a range scan is a descent followed by a linear walk,
 * which is what makes the index scan's cost model (height random reads, then
 * sequential leaf reads) honest rather than asserted.
 */
import { compareValues, type RowId, type Value } from './table.js';

/** Children per node. An in-memory choice, and not what a page holds. */
const FANOUT = 64;

/**
 * Bytes of overhead per index entry: the heap pointer and the item header.
 *
 * `pages` must describe what an 8 KB Postgres leaf page would actually hold, not
 * how this in-memory tree is arranged — the cost model reads it, and deriving it
 * from FANOUT would make every index look about six times larger than the real
 * one and price index scans out of every plan.
 */
const ENTRY_OVERHEAD = 12;
const PAGE_BYTES = 8192;

interface Leaf {
  kind: 'leaf';
  keys: Value[];
  /** Row ids per key; duplicates share a key entry. */
  rows: RowId[][];
  next: Leaf | null;
}

interface Internal {
  kind: 'internal';
  /** keys[i] is the smallest key in children[i + 1]. */
  keys: Value[];
  children: Node[];
}

type Node = Leaf | Internal;

export interface IndexStats {
  /** Distinct keys held. */
  entries: number;
  height: number;
  /** Leaf pages, at FANOUT entries per page. The cost model reads these. */
  pages: number;
}

export class BTreeIndex {
  private root: Node;
  private firstLeaf: Leaf;
  readonly entries: number;
  readonly height: number;
  /** Average key width in bytes, measured from the keys held. */
  readonly keyWidth: number;

  constructor(readonly table: string, readonly column: string, values: Value[]) {
    // Build bottom-up from sorted key groups. Bulk loading, not repeated insert:
    // the data is static once generated and this keeps the tree fully packed,
    // which is also what a freshly-built Postgres index looks like.
    const order: RowId[] = [];
    for (let i = 0; i < values.length; i++) if (values[i] !== null) order.push(i);
    order.sort((a, b) => compareValues(values[a], values[b]) || a - b);

    const keys: Value[] = [];
    const rows: RowId[][] = [];
    for (const id of order) {
      const v = values[id];
      if (keys.length > 0 && compareValues(keys[keys.length - 1], v) === 0) {
        rows[rows.length - 1].push(id);
      } else {
        keys.push(v);
        rows.push([id]);
      }
    }
    this.entries = keys.length;
    this.keyWidth = averageWidth(keys);

    const leaves: Leaf[] = [];
    for (let i = 0; i < keys.length; i += FANOUT) {
      leaves.push({
        kind: 'leaf',
        keys: keys.slice(i, i + FANOUT),
        rows: rows.slice(i, i + FANOUT),
        next: null,
      });
    }
    if (leaves.length === 0) leaves.push({ kind: 'leaf', keys: [], rows: [], next: null });
    for (let i = 0; i < leaves.length - 1; i++) leaves[i].next = leaves[i + 1];
    this.firstLeaf = leaves[0];

    let level: Node[] = leaves;
    let height = 1;
    while (level.length > 1) {
      const parents: Node[] = [];
      for (let i = 0; i < level.length; i += FANOUT) {
        const children = level.slice(i, i + FANOUT);
        parents.push({
          kind: 'internal',
          keys: children.slice(1).map((c) => firstKey(c)),
          children,
        });
      }
      level = parents;
      height++;
    }
    this.root = level[0];
    this.height = height;
  }

  /** Leaf pages, as an 8 KB Postgres page would pack them. */
  get pages(): number {
    const perPage = Math.max(1, Math.floor(PAGE_BYTES / (this.keyWidth + ENTRY_OVERHEAD)));
    return Math.max(1, Math.ceil(this.entries / perPage));
  }

  get stats(): IndexStats {
    return { entries: this.entries, height: this.height, pages: this.pages };
  }

  /** Row ids for one key, in physical order. */
  lookup(key: Value): RowId[] {
    const leaf = this.descend(key);
    const i = lowerBound(leaf.keys, key);
    if (i < leaf.keys.length && compareValues(leaf.keys[i], key) === 0) return leaf.rows[i];
    return [];
  }

  /**
   * Row ids for a key range. `null` bounds mean unbounded. Yields lazily so a
   * LIMIT above an index scan really does stop early — that early termination is
   * the reason LIMIT changes which plan wins (PRD §5.7).
   */
  *range(
    low: Value | null, lowInclusive: boolean,
    high: Value | null, highInclusive: boolean,
  ): Generator<RowId> {
    let leaf = low === null ? this.firstLeaf : this.descend(low);
    let i = low === null ? 0 : lowerBound(leaf.keys, low);
    for (;;) {
      while (i < leaf.keys.length) {
        const k = leaf.keys[i];
        if (low !== null) {
          const c = compareValues(k, low);
          if (c < 0 || (c === 0 && !lowInclusive)) { i++; continue; }
        }
        if (high !== null) {
          const c = compareValues(k, high);
          if (c > 0 || (c === 0 && !highInclusive)) return;
        }
        for (const id of leaf.rows[i]) yield id;
        i++;
      }
      if (leaf.next === null) return;
      leaf = leaf.next;
      i = 0;
    }
  }

  /** Every row id in key order. Feeds an index scan used purely for its ordering. */
  *ordered(): Generator<RowId> {
    yield* this.range(null, true, null, true);
  }

  private descend(key: Value): Leaf {
    let node = this.root;
    while (node.kind === 'internal') {
      let i = 0;
      while (i < node.keys.length && compareValues(key, node.keys[i]) >= 0) i++;
      node = node.children[i];
    }
    return node;
  }
}

function averageWidth(keys: Value[]): number {
  if (keys.length === 0) return 8;
  // Sample rather than measure every key; widths within a column barely vary.
  const step = Math.max(1, Math.floor(keys.length / 256));
  let total = 0, n = 0;
  for (let i = 0; i < keys.length; i += step) {
    const v = keys[i];
    total += typeof v === 'string' ? v.length + 1 : typeof v === 'boolean' ? 1 : 8;
    n++;
  }
  return total / n;
}

function firstKey(n: Node): Value {
  while (n.kind === 'internal') n = n.children[0];
  return n.keys[0];
}

/** First position whose key is >= target. */
function lowerBound(keys: Value[], target: Value): number {
  let lo = 0, hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareValues(keys[mid], target) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
