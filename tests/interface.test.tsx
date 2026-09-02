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
import { render, screen, cleanup, within } from '@testing-library/react';
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
