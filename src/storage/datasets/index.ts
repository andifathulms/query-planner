import type { Schema } from '../table.js';
import type { GeneratorParams } from '../generator.js';
import { buildWilayah } from './wilayah.js';
import { buildSintetis } from './sintetis.js';

export type DatasetId = 'wilayah' | 'sintetis';

export interface DatasetInfo {
  id: DatasetId;
  label: string;
  description: string;
}

export const DATASETS: DatasetInfo[] = [
  {
    id: 'wilayah',
    label: 'wilayah',
    description:
      'An Indonesian administrative hierarchy. kelurahan determines kecamatan determines '
      + 'kabupaten determines provinsi, so the dependencies are real rather than imposed.',
  },
  {
    id: 'sintetis',
    label: 'sintetis',
    description:
      'Two categorical columns whose correlation is exactly the slider, with known '
      + 'cardinalities. For control rather than credibility.',
  },
];

export function buildDataset(id: DatasetId, params: GeneratorParams): Schema {
  const built = id === 'wilayah' ? buildWilayah(params) : buildSintetis(params);
  const info = DATASETS.find((d) => d.id === id)!;
  return { id, label: info.label, tables: built.tables, indexes: built.indexes };
}
