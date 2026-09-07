/**
 * The store.
 *
 * One reducer, one memoised engine run, and the URL kept in step. Cost
 * parameters are continuous controls, so they re-plan on the frame with no
 * easing (DESIGN.md §6.1); everything else is a discrete change.
 */
import {
  createContext, useCallback, useContext, useDeferredValue, useEffect, useMemo,
  useReducer, useRef, type ReactNode,
} from 'react';
import { decodeState, encodeState } from './url.js';
import { runQuery, type EngineResult } from './engine.js';
import type { AppState, InstrumentId } from './types.js';
import type { CostParams } from '../planner/types.js';
import type { MultivariateSpec } from '../stats/multivariate/index.js';
import { specKey } from '../stats/multivariate/index.js';
import type { DatasetId } from '../storage/datasets/index.js';

export type Action =
  | { type: 'sql'; sql: string }
  | { type: 'dataset'; dataset: DatasetId }
  | { type: 'generator'; patch: Partial<AppState['generator']> }
  | { type: 'cost'; patch: Partial<CostParams> }
  | { type: 'sampleSize'; value: number }
  | { type: 'seed'; value: number }
  | { type: 'cartesian'; value: boolean }
  | { type: 'createStatistic'; spec: MultivariateSpec }
  | { type: 'dropStatistic'; spec: MultivariateSpec }
  | { type: 'select'; patch: Partial<AppState['selected']> }
  | { type: 'replace'; state: AppState };

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'sql':
      // A new query invalidates the selection: cell keys and node ids belong to
      // the plan they came from.
      return { ...state, sql: action.sql, selected: { ...state.selected, cell: null, node: null } };
    case 'dataset':
      return {
        ...state, dataset: action.dataset,
        // Statistics name columns that may not exist in the new dataset.
        multivariate: [],
        selected: { ...state.selected, cell: null, node: null },
      };
    case 'generator':
      return { ...state, generator: { ...state.generator, ...action.patch } };
    case 'cost':
      return { ...state, costParams: { ...state.costParams, ...action.patch } };
    case 'sampleSize':
      return { ...state, sampleSize: action.value };
    case 'seed':
      return { ...state, seed: action.value };
    case 'cartesian':
      return { ...state, allowCartesian: action.value, selected: { ...state.selected, cell: null } };
    case 'createStatistic': {
      const key = specKey(action.spec);
      if (state.multivariate.some((m) => specKey(m) === key)) return state;
      return { ...state, multivariate: [...state.multivariate, action.spec] };
    }
    case 'dropStatistic': {
      const key = specKey(action.spec);
      return { ...state, multivariate: state.multivariate.filter((m) => specKey(m) !== key) };
    }
    case 'select':
      return { ...state, selected: { ...state.selected, ...action.patch } };
    case 'replace':
      return action.state;
  }
}

interface StoreValue {
  state: AppState;
  dispatch: (action: Action) => void;
  result: EngineResult;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(
    reducer,
    undefined,
    () => decodeState(window.location.hash.replace(/^#/, '')),
  );

  // The generator's inputs are deferred; the cost parameters are not, and the
  // difference is measured rather than assumed.
  //
  // Re-planning and re-executing after a cost parameter moves costs about 11 ms,
  // so it happens on the frame, which is what DESIGN §6.1 asks of a continuous
  // control. Moving a generator input rebuilds the whole table and re-analyses
  // it: 603 ms for one notch of the correlation slider, 360 ms for one notch of
  // sample size. Run on the input event, that is not direct mapping, it is a
  // slider whose own thumb stutters because the main thread is busy.
  //
  // Deferring them keeps the thumb at 60 fps and lets the picture redraw at
  // whatever rate the machine can manage. The correlation sweep PRD §5.3 is
  // built around gets faster this way, not slower: the rectangle still detaches
  // from the cloud as you drag, and the control now tracks your hand while it
  // does.
  const generator = useDeferredValue(state.generator);
  const dataset = useDeferredValue(state.dataset);
  const seed = useDeferredValue(state.seed);
  const sampleSize = useDeferredValue(state.sampleSize);

  const result = useMemo(
    () => runQuery({ ...state, generator, dataset, seed, sampleSize }),
    // `selected` deliberately does not appear: selecting a cell must not re-plan.
    [
      state.sql, dataset, seed, sampleSize, state.allowCartesian,
      generator, state.costParams, state.multivariate,
    ],
  );

  // Keep the URL in step, without adding a history entry per keystroke.
  const frame = useRef(0);
  useEffect(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const encoded = encodeState(state);
      const next = `${window.location.pathname}${window.location.search}${encoded ? `#${encoded}` : ''}`;
      window.history.replaceState(null, '', next);
    });
    return () => cancelAnimationFrame(frame.current);
  }, [state]);

  // A shared link must restore the state it encodes, including on back and
  // forward.
  useEffect(() => {
    const onPop = (): void => {
      dispatch({ type: 'replace', state: decodeState(window.location.hash.replace(/^#/, '')) });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const value = useMemo(() => ({ state, dispatch, result }), [state, result]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) throw new Error('useStore must be used inside a StoreProvider');
  return value;
}

export function useSelected(): [AppState['selected'], (patch: Partial<AppState['selected']>) => void] {
  const { state, dispatch } = useStore();
  const set = useCallback(
    (patch: Partial<AppState['selected']>) => dispatch({ type: 'select', patch }),
    [dispatch],
  );
  return [state.selected, set];
}

export function useInstrument(): [InstrumentId, (id: InstrumentId) => void] {
  const [selected, set] = useSelected();
  return [selected.instrument, (instrument) => set({ instrument })];
}
