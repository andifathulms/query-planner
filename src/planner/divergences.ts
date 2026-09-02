/**
 * The divergence list (PRD §7.1, DESIGN.md §7).
 *
 * Every query in the oracle corpus whose plan shape disagrees with Postgres,
 * with the reason. This list is a feature rather than a backlog: a documented
 * record of which simplifications actually change a decision is more credible
 * than a claim that none of them do.
 *
 * It lives in `src/` rather than in the tests because the interface shows it —
 * reachable from the same place as the simplification statements, since a reader
 * weighing one wants the other. `tests/oracle.test.ts` asserts that every entry
 * still diverges and that none names a query outside the corpus, so the list
 * cannot quietly go stale.
 *
 * Each entry names a key in `SIMPLIFICATIONS` (src/planner/cost.ts).
 */
export interface Divergence {
  /** A distinctive fragment of the query, whitespace-normalised. */
  match: string;
  reason: string;
  /** Key in SIMPLIFICATIONS. */
  simplification: string;
}

export const DIVERGENCES: Divergence[] = [
  {
    match: 'FROM penduduk p WHERE p.umur = 40',
    reason:
      'Postgres chooses a bitmap heap scan: it collects the matching row ids from the '
      + 'index, sorts them into physical order, then reads each heap page once. That '
      + 'turns thousands of random reads into one ordered pass, and it is why the plan '
      + 'beats both a plain index scan and a sequential scan here. This engine has no '
      + 'bitmap layer, so it must choose between the two extremes and picks the '
      + 'sequential scan.',
    simplification: 'bitmap',
  },
  {
    match: 'WHERE p.umur BETWEEN 30 AND 35',
    reason:
      'The same bitmap heap scan, on a range rather than an equality. A moderately '
      + 'selective range over an uncorrelated column is the case bitmap scans exist '
      + 'for: too many rows for a plain index scan to be worth its random reads, too '
      + 'few for a sequential scan to be free. Without the bitmap layer this engine '
      + 'has nothing in between.',
    simplification: 'bitmap',
  },
  {
    match: 'WHERE p.kelurahan_id = 12',
    reason:
      'A bitmap heap scan again, and the clearest instance of the classic "why did it '
      + 'not use my index" question. The predicate matches a few thousand rows spread '
      + 'across the whole table; Postgres reads the index, sorts the row ids and makes '
      + 'one pass over the heap. This engine prices a plain index scan at one random '
      + 'read per row and rejects it.',
    simplification: 'bitmap',
  },
];

/** Divergences grouped by the simplification that causes them. */
export function divergencesBySimplification(): Map<string, Divergence[]> {
  const out = new Map<string, Divergence[]>();
  for (const d of DIVERGENCES) {
    out.set(d.simplification, [...(out.get(d.simplification) ?? []), d]);
  }
  return out;
}

export function divergenceFor(sql: string): Divergence | undefined {
  const normalised = sql.replace(/\s+/g, ' ');
  return DIVERGENCES.find((d) => normalised.includes(d.match));
}
