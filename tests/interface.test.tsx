// @vitest-environment jsdom
/**
 * The interface renders, and the derivation it draws is the one the engine
 * produced.
 *
 * Not a screenshot test: what is checked here is that the plan tree shows the
 * operators the planner actually chose, that the paired encoding reaches the
 * DOM, and that a rejected query says what is unsupported rather than failing
 * obscurely.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import { StoreProvider } from '../src/state/store.js';
import { App } from '../src/App.js';

function renderApp(hash = ''): void {
  window.location.hash = hash;
  render(<StoreProvider><App /></StoreProvider>);
}

beforeEach(() => { window.location.hash = ''; });
afterEach(cleanup);

describe('the shell', () => {
  it('renders the derivation with a plan and a result', () => {
    // A small dataset, so the test does not generate a million rows.
    renderApp('n=6000&s=2000');
    expect(screen.getByRole('heading', { name: 'Query planner' })).toBeTruthy();

    const tree = screen.getByRole('tree', { name: 'The chosen plan' });
    const nodes = within(tree).getAllByRole('treeitem');
    expect(nodes.length).toBeGreaterThan(0);
    // Postgres's own words, which is what makes the transfer to real EXPLAIN
    // output possible.
    expect(nodes[0].getAttribute('aria-label')).toMatch(/Seq Scan|Index Scan|Hash Join|Nested Loop|Merge Join/);
  });

  it('draws the paired encoding, not two bare numbers', () => {
    renderApp('n=6000&s=2000');
    const tree = screen.getByRole('tree', { name: 'The chosen plan' });
    expect(tree.querySelectorAll('.mark-believed').length).toBeGreaterThan(0);
    expect(tree.querySelectorAll('.mark-true').length).toBeGreaterThan(0);
  });

  it('states the estimate and the actual on every node', () => {
    renderApp('n=6000&s=2000');
    const nodes = screen.getAllByRole('treeitem');
    for (const node of nodes) {
      const label = node.getAttribute('aria-label') ?? '';
      expect(label).toMatch(/estimated [\d,]+ rows/);
      expect(label).toMatch(/actual [\d,]+ rows/);
    }
  });

  it('names the limitation when a query is out of scope', () => {
    renderApp(`n=6000&s=2000&q=${encodeURIComponent('SELECT row_number() OVER () FROM kelurahan k')}`);
    expect(screen.getByRole('alert').textContent).toMatch(/Window functions are not supported/);
  });

  it('names the column when a query references one that does not exist', () => {
    renderApp(`n=6000&s=2000&q=${encodeURIComponent('SELECT k.nonexistent FROM kelurahan k')}`);
    expect(screen.getByRole('alert').textContent).toMatch(/nonexistent does not exist/);
  });

  it('offers every cost parameter as a slider, with random_page_cost among them', () => {
    renderApp('n=6000&s=2000');
    const group = screen.getByRole('group', { name: 'Cost parameters' });
    const sliders = within(group).getAllByRole('slider');
    expect(sliders).toHaveLength(7);
    expect(within(group).getByText('random_page_cost')).toBeTruthy();
  });
});

describe('state round-trips through the URL', () => {
  it('restores cost parameters from a link', () => {
    renderApp('n=6000&s=2000&rpc=1.1');
    const group = screen.getByRole('group', { name: 'Cost parameters' });
    const values = within(group).getAllByText('1.10');
    expect(values.length).toBeGreaterThan(0);
  });

  it('restores the query from a link', () => {
    const sql = 'SELECT k.nama FROM kelurahan k';
    renderApp(`n=6000&s=2000&q=${encodeURIComponent(sql)}`);
    expect((screen.getByLabelText('SQL query') as HTMLTextAreaElement).value).toBe(sql);
  });
});

describe('the lattice', () => {
  it('draws a level per subset size, with the cells in a stable order', () => {
    const sql = 'SELECT k.nama, c.nama FROM kelurahan k JOIN kecamatan c ON k.kecamatan_id = c.id';
    renderApp(`n=6000&s=2000&q=${encodeURIComponent(sql)}`);

    // Two relations: level 1 with two cells, level 2 with one.
    expect(screen.getByRole('group', { name: /Level 1: 2 subsets/ })).toBeTruthy();
    expect(screen.getByRole('group', { name: /Level 2: 1 subset/ })).toBeTruthy();
  });

  it('labels each cell with its operator, cost and candidate count', () => {
    const sql = 'SELECT k.nama, c.nama FROM kelurahan k JOIN kecamatan c ON k.kecamatan_id = c.id';
    renderApp(`n=6000&s=2000&q=${encodeURIComponent(sql)}`);
    const cells = screen.getAllByRole('button', { name: /candidate/ });
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.some((c) => /Hash Join|Merge Join|Nested Loop/.test(c.getAttribute('aria-label') ?? ''))).toBe(true);
  });

  it('shows disconnected subsets as unfilled rather than omitting them', () => {
    // A chain k-c-b: the subset {k, b} has no clause connecting it.
    const sql = `SELECT k.nama, c.nama, b.nama FROM kelurahan k
      JOIN kecamatan c ON k.kecamatan_id = c.id
      JOIN kabupaten b ON c.kabupaten_id = b.id`;
    renderApp(`n=6000&s=2000&q=${encodeURIComponent(sql)}`);
    const level2 = screen.getByRole('group', { name: /Level 2: 3 subsets/ });
    expect(level2.querySelectorAll('.lattice-cell.is-empty').length).toBe(1);
  });

  it('offers play, step and fill controls', () => {
    renderApp('n=6000&s=2000');
    for (const name of ['step cell', 'step level', 'fill']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });
});

describe('the cost breakdown', () => {
  it('shows the chosen plan when no cell is selected', () => {
    renderApp('n=6000&s=2000');
    const table = screen.getByRole('table', { name: 'Candidate plans by cost' });
    expect(within(table).getAllByRole('row').length).toBeGreaterThan(0);
  });

  it('decomposes each bar into the terms the cost model produced', () => {
    const sql = 'SELECT k.nama, c.nama FROM kelurahan k JOIN kecamatan c ON k.kecamatan_id = c.id';
    renderApp(`n=6000&s=2000&q=${encodeURIComponent(sql)}`);
    const table = screen.getByRole('table', { name: 'Candidate plans by cost' });
    // Terms are drawn, and the two kinds are told apart by hatch rather than hue.
    expect(table.querySelectorAll('.term-cpu, .term-io').length).toBeGreaterThan(1);
    expect(within(table).getAllByRole('row')[0].getAttribute('aria-label')).toMatch(/cost [\d.]+/);
  });

  it('states the simplification beside the numbers it affects', () => {
    renderApp('n=6000&s=2000');
    const panel = screen.getByRole('region', { name: 'Cost breakdown' });
    expect(panel.querySelector('.cost-breakdown-note')?.textContent?.length).toBeGreaterThan(30);
  });
});

describe('the instrument bay', () => {
  it('offers all five instruments, with recovery marked as the one that acts', () => {
    renderApp('n=6000&s=2000');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      'correlation', 'histogram', 'sample', 'timeline', 'recovery',
    ]);
    expect(screen.getByRole('tab', { name: 'recovery' }).className).toMatch(/is-acting/);
  });

  it('draws the independence rectangle and the truth beside it', () => {
    renderApp('n=6000&s=2000');
    const plot = screen.getByRole('img', { name: /Scatter of/ });
    // The wrong belief is hollow and dashed; the matching rows are solid.
    expect(plot.querySelectorAll('.mark-believed').length).toBe(1);
    expect(plot.querySelectorAll('.correlation-point.is-match').length).toBeGreaterThan(0);
    expect(plot.getAttribute('aria-label')).toMatch(/Independence predicts .* the truth is/);
  });

  it('shows the histogram with its predicate and its trace', () => {
    renderApp('n=6000&s=2000');
    fireEvent.click(screen.getByRole('tab', { name: 'histogram' }));
    expect(screen.getByRole('img', { name: /Statistics for/ })).toBeTruthy();
    // Every estimate states its method and its assumptions.
    expect(screen.getByRole('tabpanel').textContent).toMatch(/independence|most-common values|histogram/);
  });

  it('shows which rows the statistics saw', () => {
    renderApp('n=6000&s=2000');
    fireEvent.click(screen.getByRole('tab', { name: 'sample' }));
    expect(screen.getByRole('img', { name: /rows were sampled/ })).toBeTruthy();
  });

  it('shows a track per plan node on the timeline', () => {
    renderApp('n=6000&s=2000');
    fireEvent.click(screen.getByRole('tab', { name: 'timeline' }));
    const chart = screen.getByRole('img', { name: /Execution timeline/ });
    expect(chart.querySelectorAll('.timeline-track').length).toBeGreaterThan(0);
    expect(chart.querySelectorAll('.timeline-startup').length).toBeGreaterThan(0);
  });

  it('moves between tabs with the arrow keys', () => {
    renderApp('n=6000&s=2000');
    const first = screen.getByRole('tab', { name: 'correlation' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'histogram' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('the recovery', () => {
  it('offers all three statistic kinds with what each repairs and costs', () => {
    renderApp('n=6000&s=2000');
    fireEvent.click(screen.getByRole('tab', { name: 'recovery' }));
    const panel = screen.getByRole('tabpanel');
    for (const kind of ['dependencies', 'ndistinct', 'mcv']) {
      expect(within(panel).getByText(kind)).toBeTruthy();
    }
    expect(within(panel).getAllByRole('button', { name: 'create' }).length).toBe(3);
  });

  it('moves the estimate towards the truth when a statistic is created', () => {
    renderApp('n=6000&s=2000');
    fireEvent.click(screen.getByRole('tab', { name: 'recovery' }));

    const { estimated: before, actual } = rootNumbers();
    fireEvent.click(within(screen.getByRole('tabpanel')).getAllByRole('button', { name: 'create' })[0]);
    const { estimated: after } = rootNumbers();

    // The claim is not a fixed multiple — that depends on the table size and the
    // distinct counts. The claim is that independence understates, and that the
    // dependency corrects towards the measured truth.
    expect(before).toBeLessThan(actual);
    expect(after).toBeGreaterThan(before);
    expect(Math.abs(after - actual)).toBeLessThan(Math.abs(before - actual));

    expect(screen.getByRole('heading', { name: 'Before and after' })).toBeTruthy();
    expect(screen.getByRole('tabpanel').textContent).toMatch(/the estimate/);
  });

  it('turns the statistic off again when dropped', () => {
    renderApp('n=6000&s=2000');
    fireEvent.click(screen.getByRole('tab', { name: 'recovery' }));
    const panel = () => screen.getByRole('tabpanel');

    const before = rootNumbers().estimated;
    fireEvent.click(within(panel()).getAllByRole('button', { name: 'create' })[0]);
    expect(rootNumbers().estimated).not.toBe(before);
    fireEvent.click(within(panel()).getByRole('button', { name: 'drop' }));
    expect(rootNumbers().estimated).toBe(before);
  });

  function rootNumbers(): { estimated: number; actual: number } {
    const root = screen.getAllByRole('treeitem')[0];
    const label = root.getAttribute('aria-label') ?? '';
    const estimated = /estimated ([\d,]+) rows/.exec(label)?.[1] ?? '0';
    const actual = /actual ([\d,]+) rows/.exec(label)?.[1] ?? '0';
    return {
      estimated: Number(estimated.replace(/,/g, '')),
      actual: Number(actual.replace(/,/g, '')),
    };
  }
});

describe('every instrument has a keyboard-reachable table', () => {
  for (const [tab, caption] of [
    ['correlation', 'The estimates as a table'],
    ['histogram', /statistics as a table/],
    ['sample', 'The estimates as a table'],
    ['timeline', 'The timeline as a table'],
  ] as const) {
    it(`${tab} carries its figures`, () => {
      renderApp('n=6000&s=2000');
      fireEvent.click(screen.getByRole('tab', { name: tab }));
      const summary = screen.getByText(caption);
      // Opening the disclosure exposes a real table with a header row.
      fireEvent.click(summary);
      const table = within(summary.closest('details')!).getByRole('table');
      expect(within(table).getAllByRole('columnheader').length).toBeGreaterThan(1);
      expect(within(table).getAllByRole('row').length).toBeGreaterThan(1);
    });
  }

  it('the lattice and the plan tree carry theirs too', () => {
    renderApp('n=6000&s=2000');
    for (const caption of ['The search as a table', 'The plan as a table']) {
      const summary = screen.getByText(caption);
      fireEvent.click(summary);
      expect(within(summary.closest('details')!).getByRole('table')).toBeTruthy();
    }
  });
});

describe('selecting a plan node opens its trace', () => {
  it('names the method and the assumptions', () => {
    renderApp('n=6000&s=2000');
    // The scan carrying the WHERE clause: a leaf with no predicate on it has no
    // selectivity to explain, and correctly shows only its cost.
    const leaf = screen.getAllByRole('treeitem')
      .find((n) => /kelurahan/.test(n.getAttribute('aria-label') ?? ''))!;
    fireEvent.click(leaf);

    const detail = document.querySelector('.plan-detail')!;
    expect(detail).toBeTruthy();
    expect(detail.textContent).toMatch(/How the estimate was made/);
    // Not a bare number: the assumption is named.
    expect(detail.querySelector('.trace-assumptions')?.textContent?.length).toBeGreaterThan(10);
    // And the model's own limitation sits beside it.
    expect(detail.querySelector('.plan-detail-simplification')?.textContent?.length).toBeGreaterThan(30);
  });

  it('traverses the tree with the arrow keys', () => {
    // A join, so the tree has something below its root to move to.
    const sql = 'SELECT k.nama, c.nama FROM kelurahan k JOIN kecamatan c ON k.kecamatan_id = c.id';
    renderApp(`n=6000&s=2000&q=${encodeURIComponent(sql)}`);
    const tree = screen.getByRole('tree', { name: 'The chosen plan' });
    const root = screen.getAllByRole('treeitem')[0];
    fireEvent.click(root);
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    const selected = screen.getAllByRole('treeitem').filter((n) => n.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]).not.toBe(root);
  });
});

describe('the model notes', () => {
  it('list every simplification and the divergences the oracle found', () => {
    renderApp('n=6000&s=2000');
    const summary = screen.getByText(/Where this model differs from Postgres/);
    fireEvent.click(summary);
    const body = summary.closest('details')!;
    expect(within(body).getByText('bitmap')).toBeTruthy();
    expect(body.querySelectorAll('.model-note-divergence').length).toBeGreaterThan(0);
    // Stated once, plainly (PRD §6.2).
    expect(body.textContent).toMatch(/real Postgres would give different numbers/);
  });
});

describe('the generator controls', () => {
  it('put the seed, size and skew in the address bar', () => {
    renderApp('n=6000&s=2000');
    fireEvent.click(screen.getByText('Generator'));
    const seed = screen.getByLabelText('seed') as HTMLInputElement;
    expect(seed.value).toBe('1');
    fireEvent.change(seed, { target: { value: '7' } });
    expect((screen.getByLabelText('seed') as HTMLInputElement).value).toBe('7');
  });

  it('offers the cartesian toggle', () => {
    renderApp('n=6000&s=2000');
    fireEvent.click(screen.getByText('Generator'));
    const toggle = screen.getByLabelText('allow cartesian products') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });
});

describe('prefers-reduced-motion', () => {
  function withReducedMotion(reduce: boolean): void {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: reduce && query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
  }

  it('fills the lattice completely and at once, with the stepper still there', () => {
    withReducedMotion(true);
    renderApp('n=6000&s=2000');

    // Every cell has already resolved: nothing is waiting to animate.
    const cells = screen.getAllByRole('button', { name: /candidate/ });
    expect(cells.length).toBeGreaterThan(0);
    // SVG elements expose className as an SVGAnimatedString, not a string.
    for (const cell of cells) expect(cell.getAttribute('class')).toMatch(/is-resolved/);

    // The controls remain, so the search is still steppable by hand (§6.7).
    expect(screen.getByRole('button', { name: 'step level' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'replay' })).toBeTruthy();
  });

  it('shows the plan tree immediately rather than waiting for the descent', () => {
    withReducedMotion(true);
    renderApp('n=6000&s=2000');
    const panel = screen.getByRole('region', { name: 'The chosen plan' });
    expect(panel.className).not.toMatch(/is-waiting/);
    expect(panel.getAttribute('aria-busy')).toBe('false');
  });

  it('plays the fill when motion is not reduced', () => {
    withReducedMotion(false);
    renderApp('n=6000&s=2000');
    expect(screen.getByRole('button', { name: 'pause' })).toBeTruthy();
  });
});

describe('the empty state', () => {
  it('opens on a lattice with something in it', () => {
    // A single-relation default gives the app's hero exactly one cell. Three
    // relations is seven cells over three levels: small enough to read at a
    // glance, large enough to be a lattice.
    renderApp('n=6000&s=2000');
    for (const level of [1, 2, 3]) {
      expect(screen.getByRole('group', { name: new RegExp(`Level ${level}:`) })).toBeTruthy();
    }
    expect(screen.getAllByRole('button', { name: /candidate/ }).length).toBeGreaterThan(3);
  });

  it('opens on an under-estimate, which is what the app is about', () => {
    renderApp('n=6000&s=2000');
    const root = screen.getAllByRole('treeitem')[0];
    const label = root.getAttribute('aria-label') ?? '';
    const estimated = Number((/estimated ([\d,]+) rows/.exec(label)?.[1] ?? '0').replace(/,/g, ''));
    const actual = Number((/actual ([\d,]+) rows/.exec(label)?.[1] ?? '0').replace(/,/g, ''));
    expect(estimated).toBeLessThan(actual);
    expect(document.querySelector('.plan-tree-verdict.is-under')).toBeTruthy();
  });

  it('gives the sample view a relation that has a predicate on it', () => {
    // The first relation in the FROM clause frequently has no WHERE clause on
    // it, and the comparison this view exists for needs something to estimate.
    renderApp('n=6000&s=2000');
    fireEvent.click(screen.getByRole('tab', { name: 'sample' }));
    expect(screen.getByText('The estimates as a table')).toBeTruthy();
  });
});

describe('the correlation plot draws selectivity as area', () => {
  it('puts the belief and the truth on one scale, with the gap between them', () => {
    renderApp('n=6000&s=2000');
    const plot = screen.getByRole('img', { name: /Scatter of/ });

    const believed = plot.querySelector('.mark-believed')!;
    const truth = plot.querySelector('.correlation-truth-edge')!;
    expect(believed).toBeTruthy();
    expect(truth).toBeTruthy();

    const area = (el: Element) =>
      Number(el.getAttribute('width')) * Number(el.getAttribute('height'));

    // Independence under-estimates these predicates badly, so the measured area
    // is the larger one — and the region it missed is tinted as an under-shoot
    // rather than left as bare field.
    expect(area(truth)).toBeGreaterThan(area(believed));
    expect(plot.querySelector('.correlation-truth.gap-under')).toBeTruthy();
  });
});

describe('the interface does not state anything untrue about itself', () => {
  it('draws every row it claims to be showing', () => {
    // "showing the first 500" beside a grid holding 60 is the one kind of lie an
    // app about wrong estimates cannot afford.
    renderApp('n=6000&s=2000');
    const region = screen.getByRole('region', { name: 'Result' });
    const claimed = /showing the first ([\d,]+)/.exec(region.textContent ?? '')?.[1];
    const drawn = region.querySelectorAll('tbody tr').length;
    if (claimed) expect(drawn).toBe(Number(claimed.replace(/,/g, '')));
    else expect(drawn).toBeGreaterThan(0);
  });

  it('qualifies a result heading when the bare name is ambiguous', () => {
    // SELECT k.nama, c.nama returns `nama` twice, as Postgres does. The engine
    // keeps that; the grid says which is which.
    const sql = `SELECT k.nama, c.nama FROM kelurahan k
      JOIN kecamatan c ON k.kecamatan_id = c.id`;
    renderApp(`n=6000&s=2000&q=${encodeURIComponent(sql)}`);
    const region = screen.getByRole('region', { name: 'Result' });
    const headings = [...region.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(headings).toEqual(['k.nama', 'c.nama']);
  });

  it('leaves an unambiguous heading unqualified', () => {
    const sql = 'SELECT k.nama, k.penduduk FROM kelurahan k';
    renderApp(`n=6000&s=2000&q=${encodeURIComponent(sql)}`);
    const region = screen.getByRole('region', { name: 'Result' });
    const headings = [...region.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(headings).toEqual(['nama', 'penduduk']);
  });

  it('keeps plan node subtitles inside their box', () => {
    // SVG text neither wraps nor clips on its own, and a parameterized index
    // scan's subtitle is half again as long as the node is wide.
    renderApp('n=6000&s=2000');
    const subs = document.querySelectorAll('.plan-node-sub');
    expect(subs.length).toBeGreaterThan(0);
    for (const sub of subs) expect((sub.textContent ?? '').length).toBeLessThanOrEqual(22);
    // And at least one of them actually needed the truncation.
    expect([...subs].some((s) => (s.textContent ?? '').endsWith('…'))).toBe(true);
  });
});

describe('the cost breakdown bars stay inside their panel', () => {
  it('leaves the total its own room rather than drawing the bar under it', () => {
    // A percentage inside a translated <g> resolves against the whole viewport,
    // not the group, so the longest bar was drawn LABEL_W wider than the panel
    // and ran underneath its own figure. The track is a nested viewport now.
    renderApp('n=6000&s=2000');
    const table = screen.getByRole('table', { name: 'Candidate plans by cost' });
    const track = table.querySelector('.cost-bar-track')!;
    expect(track.tagName.toLowerCase()).toBe('svg');
    expect(track.getAttribute('width')).toMatch(/^calc\(100% - \d+px\)$/);
  });
});

describe("the maker's mark", () => {
  it('credits the author with a link to their portfolio', () => {
    renderApp('n=6000&s=2000');
    const name = screen.getByRole('link', { name: 'Andi Fathul Mukminin' });
    expect(name.getAttribute('href')).toBe('https://andifathulms.github.io/en/');
    expect(document.querySelector('.maker-credit')?.textContent)
      .toMatch(/^Designed & built by Andi Fathul Mukminin · © \d{4}$/);
  });

  it('sets the year from the clock rather than from a literal', () => {
    renderApp('n=6000&s=2000');
    expect(document.querySelector('.maker-year')?.textContent)
      .toBe(`© ${new Date().getFullYear()}`);
  });

  it('names every platform for a screen reader and opens each one safely', () => {
    renderApp('n=6000&s=2000');
    const links = [...document.querySelectorAll('.maker-link')];
    expect(links.map((a) => a.getAttribute('aria-label')))
      .toEqual(['Portfolio', 'GitHub', 'LinkedIn', 'Instagram']);
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank');
      // Without noopener the opened tab can reach back through window.opener.
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('stays out of the cost bar, which is a control surface and not a footer', () => {
    renderApp('n=6000&s=2000');
    const bar = screen.getByRole('group', { name: 'Cost parameters' });
    expect(bar.querySelector('.maker')).toBeNull();
    expect(document.querySelector('.app-main .maker')).toBeTruthy();
  });

  it('adds one seam and no boxes', () => {
    // A quiet credit, not a badge: a single hairline above it and nothing
    // inside it ruled, boxed or elevated.
    renderApp('n=6000&s=2000');
    const maker = document.querySelector('.maker')!;
    expect(maker.querySelector('.panel')).toBeNull();
    expect(maker.querySelectorAll('hr').length).toBe(0);
  });
});

describe('a stranger can tell what this is', () => {
  it('explains the app in prose at reading size, above the derivation', () => {
    // The only explanation used to be an 11.5 px tagline between the title and a
    // dropdown. Prose that orients a newcomer is 16 px and comes first.
    renderApp('n=6000&s=2000');
    const lede = screen.getByRole('region', { name: 'What this is' });
    expect(lede.querySelector('.lede-copy')?.className).toMatch(/t-prose/);
    expect(lede.textContent).toMatch(/guess how many rows/);
    expect(document.querySelector('.app-main')!.compareDocumentPosition(lede))
      .toBe(Node.DOCUMENT_POSITION_PRECEDING);
  });

  it('puts the finding at the top, not only below the fold', () => {
    renderApp('n=6000&s=2000');
    const verdict = document.querySelector('.lede-verdict')!;
    expect(verdict).toBeTruthy();
    // The same ratio the plan tree prints, so the two cannot disagree.
    const figure = verdict.querySelector('.lede-verdict-figure')!.textContent;
    expect(document.querySelector('.plan-tree-verdict-figure')!.textContent).toBe(figure);
    expect(figure).toMatch(/^[\d.]+×$/);
  });

  it('says what a lattice cell is, since the labels are bare aliases', () => {
    renderApp('n=6000&s=2000');
    const search = screen.getByRole('region', { name: 'The search' });
    expect(search.querySelector('.app-search-key')?.textContent)
      .toMatch(/combination of the tables in your query/);
  });

  it('states the paired encoding in words, not only as two marks', () => {
    renderApp('n=6000&s=2000');
    const plan = screen.getByRole('region', { name: 'The chosen plan' });
    const key = plan.querySelector('.app-plan-key')?.textContent ?? '';
    expect(key).toMatch(/hollow and dashed/);
    expect(key).toMatch(/solid/);
    expect(key).toMatch(/distance between the two marks is the error/);
  });

  it('spells out the search summary rather than naming three jargon counts', () => {
    // Reduced motion, so the fill has already resolved and the status line shows
    // its summary rather than "filling level 1".
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
    renderApp('n=6000&s=2000');
    expect(document.querySelector('.lattice-status')?.textContent)
      .toMatch(/table combinations planned .* candidate plans .* kept for their sort order/);
  });
});

describe('the error is attributed, not just measured', () => {
  it('names the node that added the error rather than the one carrying it', () => {
    renderApp('n=6000&s=2000');
    const source = document.querySelector('.plan-tree-source');
    expect(source).toBeTruthy();
    expect(source!.textContent).toMatch(/Most of it entered at/);
    // It names a real node of this plan. That the ranking is by error added
    // rather than error carried is asserted on hand-computed trees in
    // errorSource.test.ts, where the two can be made to disagree on purpose.
    const named = source!.querySelector('strong')!.textContent!;
    const labels = screen.getAllByRole('treeitem')
      .map((n) => n.getAttribute('aria-label') ?? '');
    expect(labels.some((l) => l.startsWith(named))).toBe(true);
  });

  it('splits a selected node error into inherited and introduced', () => {
    renderApp('n=6000&s=2000');
    // A join, so there are children whose error can arrive from below.
    const join = screen.getAllByRole('treeitem')
      .find((n) => /Nested Loop|Hash Join|Merge Join/.test(n.getAttribute('aria-label') ?? ''))!;
    fireEvent.click(join);
    const detail = document.querySelector('.plan-detail')!;
    expect(detail.textContent).toMatch(/added here/);
  });
});

describe('the app distinguishes a close decision from a decisive one', () => {
  it('states how far ahead the winning plan is', () => {
    const sql = `SELECT k.nama, c.nama FROM kelurahan k
      JOIN kecamatan c ON k.kecamatan_id = c.id`;
    renderApp(`n=6000&s=2000&q=${encodeURIComponent(sql)}`);
    const panel = screen.getByRole('region', { name: 'Cost breakdown' });
    expect(panel.querySelector('.cost-breakdown-margin')?.textContent)
      .toMatch(/cheaper than the next candidate/);
  });
});

describe('the sample view separates the two kinds of error', () => {
  it('says how much of the gap a bigger sample could not close', () => {
    renderApp('n=6000&s=2000');
    fireEvent.click(screen.getByRole('tab', { name: 'sample' }));
    const split = document.querySelector('.sample-split')!;
    expect(split).toBeTruthy();
    expect(split.textContent).toMatch(/is the model rather than the sample/);
    // Both halves are named, so neither can be mistaken for the whole.
    expect(split.textContent).toMatch(/sampling error/);
    expect(split.textContent).toMatch(/model error/);
  });
});

describe('empty panels say what would be there', () => {
  // An unsupported query empties four panels at once, which is the moment a
  // newcomer is most likely to be lost. Stating the absence teaches nothing.
  const UNSUPPORTED = 'SELECT row_number() OVER () FROM kelurahan k';

  it('explains each empty panel rather than naming the void', () => {
    renderApp(`n=6000&s=2000&q=${encodeURIComponent(UNSUPPORTED)}`);
    for (const [selector, expected] of [
      ['.lattice-empty', /every combination of its tables/],
      ['.plan-tree-empty', /once the query above parses/],
      ['.cost-breakdown-empty', /costed here, cheapest first/],
      ['.app-placeholder', /once the query above parses and runs/],
    ] as const) {
      expect(document.querySelector(selector)?.textContent).toMatch(expected);
    }
  });

  it('still names the limitation once, where the query is', () => {
    // The panels describe themselves; only the parser says what was wrong.
    renderApp(`n=6000&s=2000&q=${encodeURIComponent(UNSUPPORTED)}`);
    expect(screen.getByRole('alert').textContent).toMatch(/Window functions are not supported/);
  });

  it('does not repeat one sentence across every empty panel', () => {
    renderApp(`n=6000&s=2000&q=${encodeURIComponent(UNSUPPORTED)}`);
    const texts = ['.lattice-empty', '.plan-tree-empty', '.cost-breakdown-empty', '.app-placeholder']
      .map((s) => document.querySelector(s)?.textContent?.trim().replace(/\s+/g, ' ') ?? '');
    expect(new Set(texts).size).toBe(texts.length);
  });
});

describe('the heading outline has no gaps', () => {
  it('gives the active instrument a heading between the panel and its contents', () => {
    renderApp('n=6000&s=2000');
    fireEvent.click(screen.getByRole('tab', { name: 'recovery' }));
    const panel = screen.getByRole('tabpanel');
    const heading = within(panel).getByRole('heading', { level: 2 });
    expect(heading.textContent).toBe('recovery');
    // Hidden, because the tab strip already says this visually.
    expect(heading.className).toMatch(/visually-hidden/);
    // And the h3 inside Recovery now has an h2 above it rather than none.
    expect(within(panel).getAllByRole('heading', { level: 3 }).length).toBeGreaterThan(0);
  });

  it('renames the heading with the tab', () => {
    renderApp('n=6000&s=2000');
    fireEvent.click(screen.getByRole('tab', { name: 'timeline' }));
    expect(within(screen.getByRole('tabpanel')).getByRole('heading', { level: 2 }).textContent)
      .toBe('timeline');
  });
});
