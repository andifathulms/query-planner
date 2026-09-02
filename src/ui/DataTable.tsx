/**
 * A keyboard-reachable table equivalent (PRD §8.9).
 *
 * Every instrument has one. A chart that only exists as geometry is unreachable
 * to anyone not looking at it, and the numbers behind these charts are the point
 * — so each view carries its own figures in a disclosure beneath it, in the same
 * order the drawing puts them.
 */
import './DataTable.css';

export interface DataTableProps {
  caption: string;
  columns: string[];
  rows: Array<Array<string | number>>;
  /** Collapsed by default: the drawing is the primary reading. */
  open?: boolean;
}

export function DataTable({ caption, columns, rows, open = false }: DataTableProps) {
  if (rows.length === 0) return null;
  return (
    <details className="data-table" open={open}>
      <summary className="t-small">{caption} as a table</summary>
      <div className="data-table-scroll scroll-x">
        <table className="t-data">
          <caption className="visually-hidden">{caption}</caption>
          <thead>
            <tr>{columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  j === 0
                    ? <th key={j} scope="row">{cell}</th>
                    : <td key={j}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
