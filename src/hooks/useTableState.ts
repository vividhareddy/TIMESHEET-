import { useMemo, useState } from 'react';

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  key: string;
  direction: SortDirection;
}

type Accessor<T> = (row: T) => string | number | boolean | null | undefined;

/**
 * Client-side search + sort for tables.
 * `searchText` returns the searchable text of a row; `accessors` map sort keys to values.
 */
export function useTableState<T>(
  rows: T[],
  options: {
    searchText?: (row: T) => string;
    accessors?: Record<string, Accessor<T>>;
    initialSort?: SortState;
  } = {},
) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortState | undefined>(options.initialSort);
  const { searchText, accessors } = options;

  const result = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = q && searchText ? rows.filter((r) => searchText(r).toLowerCase().includes(q)) : rows;
    if (sort && accessors?.[sort.key]) {
      const get = accessors[sort.key];
      const dir = sort.direction === 'asc' ? 1 : -1;
      list = [...list].sort((a, b) => {
        const va = get(a);
        const vb = get(b);
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
        return String(va).localeCompare(String(vb), undefined, { numeric: true }) * dir;
      });
    }
    return list;
  }, [rows, query, sort, searchText, accessors]);

  const toggleSort = (key: string) =>
    setSort((s) => (s?.key === key ? { key, direction: s.direction === 'asc' ? 'desc' : 'asc' } : { key, direction: 'asc' }));

  return { rows: result, query, setQuery, sort, toggleSort };
}
