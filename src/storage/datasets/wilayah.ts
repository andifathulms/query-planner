/**
 * The realistic dataset: an Indonesian administrative hierarchy.
 *
 * Chosen because it carries genuine functional dependencies —  kelurahan
 * determines kecamatan determines kabupaten determines provinsi — which is the
 * independence failure in its purest form (PRD §4.7). The denormalised `kota`
 * and `provinsi` columns on `kelurahan` exist so the two-predicate case in the
 * thesis can be written against a single table.
 */
import { Table, type ColumnDef, type Value } from '../table.js';
import { BTreeIndex } from '../btree.js';
import { correlatedCategory, generatorRng, physicallyCluster, zipfSampler, type GeneratorParams } from '../generator.js';

const PROVINSI = [
  ['Aceh', 'Sumatra'], ['Sumatera Utara', 'Sumatra'], ['Sumatera Barat', 'Sumatra'],
  ['Riau', 'Sumatra'], ['Jambi', 'Sumatra'], ['Sumatera Selatan', 'Sumatra'],
  ['Bengkulu', 'Sumatra'], ['Lampung', 'Sumatra'], ['Kepulauan Riau', 'Sumatra'],
  ['DKI Jakarta', 'Jawa'], ['Jawa Barat', 'Jawa'], ['Jawa Tengah', 'Jawa'],
  ['DI Yogyakarta', 'Jawa'], ['Jawa Timur', 'Jawa'], ['Banten', 'Jawa'],
  ['Bali', 'Nusa Tenggara'], ['Nusa Tenggara Barat', 'Nusa Tenggara'],
  ['Nusa Tenggara Timur', 'Nusa Tenggara'],
  ['Kalimantan Barat', 'Kalimantan'], ['Kalimantan Tengah', 'Kalimantan'],
  ['Kalimantan Selatan', 'Kalimantan'], ['Kalimantan Timur', 'Kalimantan'],
  ['Kalimantan Utara', 'Kalimantan'],
  ['Sulawesi Utara', 'Sulawesi'], ['Sulawesi Tengah', 'Sulawesi'],
  ['Sulawesi Selatan', 'Sulawesi'], ['Sulawesi Tenggara', 'Sulawesi'],
  ['Gorontalo', 'Sulawesi'], ['Sulawesi Barat', 'Sulawesi'],
  ['Maluku', 'Maluku'], ['Maluku Utara', 'Maluku'],
  ['Papua', 'Papua'], ['Papua Barat', 'Papua'], ['Papua Selatan', 'Papua'],
  ['Papua Tengah', 'Papua'], ['Papua Pegunungan', 'Papua'], ['Papua Barat Daya', 'Papua'],
] as const;

const KOTA_STEM = [
  'Balikpapan', 'Samarinda', 'Bontang', 'Bandung', 'Bekasi', 'Depok', 'Bogor',
  'Surabaya', 'Malang', 'Kediri', 'Semarang', 'Solo', 'Yogyakarta', 'Denpasar',
  'Medan', 'Binjai', 'Padang', 'Pekanbaru', 'Palembang', 'Bandar Lampung',
  'Pontianak', 'Banjarmasin', 'Makassar', 'Manado', 'Palu', 'Kendari', 'Ambon',
  'Jayapura', 'Sorong', 'Mataram', 'Kupang', 'Ternate', 'Gorontalo', 'Serang',
  'Tangerang', 'Cilegon', 'Jakarta Pusat', 'Jakarta Selatan', 'Jakarta Timur',
  'Jakarta Barat', 'Jakarta Utara',
] as const;

const PEKERJAAN = [
  'petani', 'pedagang', 'karyawan swasta', 'pegawai negeri', 'nelayan', 'guru',
  'buruh', 'wiraswasta', 'pelajar', 'pensiunan',
] as const;

const def = (name: string, type: ColumnDef['type'], width: number): ColumnDef => ({ name, type, width });

export interface BuiltDataset {
  tables: Map<string, Table>;
  indexes: Map<string, BTreeIndex>;
}

export function buildWilayah(params: GeneratorParams): BuiltDataset {
  // Table sizes are derived from the single `rows` control so the whole schema
  // scales together and join cardinalities stay plausible.
  const nPenduduk = Math.max(1000, Math.round(params.rows));
  const nKelurahan = Math.max(200, Math.round(nPenduduk / 12));
  const nKecamatan = Math.max(60, Math.round(nKelurahan / 9));
  const nKabupaten = Math.max(20, Math.round(nKecamatan / 14));
  const nProvinsi = PROVINSI.length;

  // provinsi
  const provinsiRows = Array.from({ length: nProvinsi }, (_, i) => [i, PROVINSI[i][0], PROVINSI[i][1]] as Value[]);
  const provinsi = fromRows('provinsi', [
    def('id', 'int', 4), def('nama', 'text', 18), def('pulau', 'text', 12),
  ], provinsiRows);

  // kabupaten — each belongs to exactly one provinsi.
  const rngKab = generatorRng(params, 'kabupaten');
  const kabProvinsi: number[] = [];
  for (let i = 0; i < nKabupaten; i++) kabProvinsi.push(i % nProvinsi);
  const kabupatenRows = kabProvinsi.map((p, i) => [
    i, p,
    `${i % 4 === 0 ? 'Kota' : 'Kabupaten'} ${KOTA_STEM[i % KOTA_STEM.length]}`,
    i % 4 === 0 ? 'kota' : 'kabupaten',
    Math.round(200 + rngKab.next() * 4800),
  ] as Value[]);
  const kabupaten = fromRows('kabupaten', [
    def('id', 'int', 4), def('provinsi_id', 'int', 4), def('nama', 'text', 22),
    def('tipe', 'text', 10), def('luas_km2', 'int', 4),
  ], kabupatenRows);

  // kecamatan
  const rngKec = generatorRng(params, 'kecamatan');
  const kecamatanRows = Array.from({ length: nKecamatan }, (_, i) => [
    i, i % nKabupaten, `Kecamatan ${i}`, Math.round(5 + rngKec.next() * 60),
  ] as Value[]);
  const kecamatan = fromRows('kecamatan', [
    def('id', 'int', 4), def('kabupaten_id', 'int', 4), def('nama', 'text', 20),
    def('jumlah_desa', 'int', 4),
  ], kecamatanRows);

  // kelurahan — the demonstration table. `kota` and `provinsi` are denormalised
  // onto it and correlated at the requested strength.
  const rngKel = generatorRng(params, 'kelurahan');
  const kotaPick = zipfSampler(KOTA_STEM.length, params.zipf, rngKel);
  const kotaIdx = Array.from({ length: nKelurahan }, () => kotaPick());
  const provIdx = correlatedCategory(kotaIdx, nProvinsi, params.correlation, rngKel);

  interface Kel { kecamatanId: number; kota: string; prov: string; penduduk: number; luas: number }
  let kelurahanEntries: Kel[] = kotaIdx.map((k, i) => ({
    kecamatanId: i % nKecamatan,
    kota: KOTA_STEM[k],
    prov: PROVINSI[provIdx[i]][0],
    penduduk: Math.max(80, Math.round(3000 + rngKel.normal() * 2200)),
    luas: Math.max(1, Math.round(rngKel.next() * 40 * 100) / 100),
  }));
  // Physical clustering by kota, so an index on kota has a real correlation
  // value and the index-scan cost model has something to work with.
  kelurahanEntries = physicallyCluster(kelurahanEntries, (e) => e.kota, params.correlation, rngKel);

  const kelurahanRows = kelurahanEntries.map((e, i) => [
    i, e.kecamatanId, `Kelurahan ${i}`, e.kota, e.prov, e.penduduk, e.luas,
  ] as Value[]);
  const kelurahan = fromRows('kelurahan', [
    def('id', 'int', 4), def('kecamatan_id', 'int', 4), def('nama', 'text', 20),
    def('kota', 'text', 16), def('provinsi', 'text', 18),
    def('penduduk', 'int', 4), def('luas_km2', 'float', 8),
  ], kelurahanRows);

  // penduduk — the fact table.
  const rngPen = generatorRng(params, 'penduduk');
  const pekerjaanPick = zipfSampler(PEKERJAAN.length, params.zipf, rngPen);
  const pendudukRows = Array.from({ length: nPenduduk }, (_, i) => {
    const umur = Math.min(95, Math.max(0, Math.round(28 + rngPen.normal() * 18)));
    // Income tracks age, weakly. A second correlated pair, on numeric columns,
    // so the histogram view has a range predicate worth estimating.
    const pendapatan = Math.max(
      0,
      Math.round((1_500_000 + umur * 90_000 + rngPen.normal() * 1_800_000) / 1000) * 1000,
    );
    return [
      i,
      rngPen.int(nKelurahan),
      umur,
      pendapatan,
      PEKERJAAN[pekerjaanPick()],
      rngPen.next() < 0.02 ? null : rngPen.next() < 0.5 ? 'L' : 'P',
    ] as Value[];
  });
  const penduduk = fromRows('penduduk', [
    def('id', 'int', 4), def('kelurahan_id', 'int', 4), def('umur', 'int', 4),
    def('pendapatan', 'int', 8), def('pekerjaan', 'text', 15), def('jenis_kelamin', 'text', 2),
  ], pendudukRows);

  const tables = new Map<string, Table>([
    ['provinsi', provinsi], ['kabupaten', kabupaten], ['kecamatan', kecamatan],
    ['kelurahan', kelurahan], ['penduduk', penduduk],
  ]);

  return { tables, indexes: buildIndexes(tables, [
    'provinsi.id', 'kabupaten.id', 'kabupaten.provinsi_id', 'kecamatan.id',
    'kecamatan.kabupaten_id', 'kelurahan.id', 'kelurahan.kecamatan_id',
    'kelurahan.kota', 'kelurahan.provinsi', 'penduduk.id', 'penduduk.kelurahan_id',
    'penduduk.umur', 'penduduk.pendapatan',
  ]) };
}

export function fromRows(name: string, columns: ColumnDef[], rows: Value[][]): Table {
  const data: Value[][] = columns.map(() => new Array<Value>(rows.length));
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < columns.length; c++) data[c][r] = rows[r][c];
  }
  return new Table(name, columns, data);
}

export function buildIndexes(tables: Map<string, Table>, keys: string[]): Map<string, BTreeIndex> {
  const indexes = new Map<string, BTreeIndex>();
  for (const key of keys) {
    const [t, c] = key.split('.');
    const table = tables.get(t);
    if (!table) continue;
    indexes.set(key, new BTreeIndex(t, c, table.column(c)));
  }
  return indexes;
}
