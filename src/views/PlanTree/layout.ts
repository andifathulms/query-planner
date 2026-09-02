/**
 * Reingold-Tilford tidy tree, written directly (CLAUDE.md §7).
 *
 * Plans are small and shallow — a dozen nodes, five levels — and a general graph
 * layout library would be weight for nothing and would fight the fixed
 * root-at-top shape this needs.
 *
 * The algorithm in one line: lay each subtree out independently, then push
 * sibling subtrees apart by the smallest distance that keeps every level clear,
 * and centre each parent over its children.
 */
import { planChildren, type Plan } from '../../planner/types.js';

export interface LaidOutNode {
  plan: Plan;
  x: number;
  y: number;
  depth: number;
  parent: LaidOutNode | null;
  children: LaidOutNode[];
}

export interface TreeLayout {
  nodes: LaidOutNode[];
  root: LaidOutNode | null;
  width: number;
  height: number;
}

export interface LayoutOptions {
  nodeWidth: number;
  nodeHeight: number;
  /** Minimum horizontal gap between adjacent subtrees. */
  gapX: number;
  gapY: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  nodeWidth: 168, nodeHeight: 52, gapX: 20, gapY: 34,
};

interface Working {
  plan: Plan;
  depth: number;
  children: Working[];
  parent: Working | null;
  /** Position relative to this subtree's own origin, before shifting. */
  x: number;
  /** Accumulated shift applied to this subtree and everything under it. */
  shift: number;
}

export function layoutPlan(plan: Plan | null, options = DEFAULT_LAYOUT): TreeLayout {
  if (!plan) return { nodes: [], root: null, width: 0, height: 0 };

  const build = (p: Plan, depth: number, parent: Working | null): Working => {
    const node: Working = { plan: p, depth, children: [], parent, x: 0, shift: 0 };
    node.children = planChildren(p).map((c) => build(c, depth + 1, node));
    return node;
  };
  const root = build(plan, 0, null);

  const step = options.nodeWidth + options.gapX;

  /**
   * Place a subtree and return its left and right extents per level.
   *
   * Contours are kept per depth rather than as linked threads: the trees here
   * are at most a few levels deep, and an array indexed by depth is both faster
   * and far easier to read than the threaded version.
   */
  const place = (node: Working): { left: number[]; right: number[] } => {
    if (node.children.length === 0) {
      node.x = 0;
      return { left: [0], right: [0] };
    }

    const contours = node.children.map(place);

    // Push each child subtree far enough right of the ones before it that no
    // level overlaps.
    let accumulated = contours[0];
    node.children[0].shift = 0;
    for (let i = 1; i < node.children.length; i++) {
      const contour = contours[i];
      let required = 0;
      const overlap = Math.min(accumulated.right.length, contour.left.length);
      for (let d = 0; d < overlap; d++) {
        required = Math.max(required, accumulated.right[d] - contour.left[d] + step);
      }
      node.children[i].shift = required;

      // Merge the two contours into one describing the pair.
      const merged = { left: [...accumulated.left], right: [...accumulated.right] };
      for (let d = 0; d < contour.left.length; d++) {
        const l = contour.left[d] + required;
        const r = contour.right[d] + required;
        if (d < merged.left.length) {
          merged.left[d] = Math.min(merged.left[d], l);
          merged.right[d] = Math.max(merged.right[d], r);
        } else {
          merged.left[d] = l;
          merged.right[d] = r;
        }
      }
      accumulated = merged;
    }

    // A parent sits over the midpoint of its children.
    const first = node.children[0];
    const last = node.children[node.children.length - 1];
    node.x = (first.x + first.shift + last.x + last.shift) / 2;

    return {
      left: [node.x, ...accumulated.left],
      right: [node.x, ...accumulated.right],
    };
  };

  place(root);

  // Resolve the relative shifts into absolute positions.
  const nodes: LaidOutNode[] = [];
  const byWorking = new Map<Working, LaidOutNode>();

  const resolve = (node: Working, offset: number): void => {
    const x = node.x + offset;
    const laid: LaidOutNode = {
      plan: node.plan,
      x,
      y: node.depth * (options.nodeHeight + options.gapY),
      depth: node.depth,
      parent: node.parent ? byWorking.get(node.parent) ?? null : null,
      children: [],
    };
    byWorking.set(node, laid);
    laid.parent?.children.push(laid);
    nodes.push(laid);
    for (const child of node.children) resolve(child, offset + child.shift);
  };
  resolve(root, 0);

  // Normalise so the leftmost node sits at half a node width from the origin.
  const minX = Math.min(...nodes.map((n) => n.x));
  const maxX = Math.max(...nodes.map((n) => n.x));
  const maxY = Math.max(...nodes.map((n) => n.y));
  for (const n of nodes) n.x += -minX + options.nodeWidth / 2;

  return {
    nodes,
    root: byWorking.get(root) ?? null,
    width: maxX - minX + options.nodeWidth,
    height: maxY + options.nodeHeight,
  };
}
