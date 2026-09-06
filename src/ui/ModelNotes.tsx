/**
 * Where this model differs from Postgres (PRD §6.1, §6.2, DESIGN.md §7).
 *
 * Every simplification, and the oracle's divergence list beside it — because a
 * documented record of exactly which simplifications change a decision is more
 * credible than a claim that none of them do.
 *
 * The per-number statements live next to their numbers; this is the place a
 * reader goes when they want the whole list, and it is one disclosure away
 * rather than on a separate page.
 */
import { SIMPLIFICATIONS } from '../planner/index.js';
import { divergencesBySimplification, DIVERGENCES } from '../planner/divergences.js';
import { plural } from './format.js';
import './ModelNotes.css';

export function ModelNotes() {
  const byKey = divergencesBySimplification();
  const keys = Object.keys(SIMPLIFICATIONS);

  return (
    <details className="model-notes disclosure">
      <summary>
        Where this model differs from Postgres
        {DIVERGENCES.length > 0
          && ` · ${DIVERGENCES.length} documented ${plural(DIVERGENCES.length, 'divergence')}`}
      </summary>

      <div className="model-notes-body">
        <p className="t-prose model-notes-lede">
          This is a real cost model with real parameters, and it is not Postgres. Estimates
          and actuals here come from one engine, which makes their pairing exact and also
          means real Postgres would give different numbers. Every simplification is listed,
          and the ones the oracle caught changing a decision are named.
        </p>

        <ul className="model-notes-list">
          {keys.map((key) => {
            const divergences = byKey.get(key) ?? [];
            return (
              <li key={key} className="model-note">
                <code className="t-data model-note-key">{key}</code>
                <p className="t-prose">{SIMPLIFICATIONS[key]}</p>
                {divergences.map((d) => (
                  <div key={d.match} className="model-note-divergence">
                    <code className="t-micro">{d.match}</code>
                    <p className="t-prose">{d.reason}</p>
                  </div>
                ))}
              </li>
            );
          })}
        </ul>
      </div>
    </details>
  );
}
