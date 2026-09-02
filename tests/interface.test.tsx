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
    const leaf = screen.getAllByRole('treeitem').at(-1)!;
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
