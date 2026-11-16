import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { SortState } from '@/hooks/useTableState';
import { cn } from '@/utils/format';
import { EmptyState } from '@/components/common/Misc';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  sortable?: boolean;
  align?: 'left' | 'right' | 'center';
  className?: string;
  /** Hide below the lg breakpoint (tablet). */
  hideOnTablet?: boolean | 'wide';
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  sort?: SortState;
  onSort?: (key: string) => void;
  onRowClick?: (row: T) => void;
  emptyTitle?: string;
  emptyDescription?: string;
  footer?: ReactNode;
  rowClassName?: (row: T) => string | undefined;
  selection?: { selected: Set<string>; onToggle: (id: string) => void; onToggleAll: (ids: string[]) => void; isSelectable?: (row: T) => boolean };
}

export function DataTable<T>({ columns, rows, rowKey, sort, onSort, onRowClick, emptyTitle = 'No records found', emptyDescription, footer, rowClassName, selection }: DataTableProps<T>) {
  const alignClass = (a?: Column<T>['align']) => (a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left');
  const visibility = (c: Column<T>) => (c.hideOnTablet === 'wide' ? 'hidden 2xl:table-cell' : c.hideOnTablet ? 'hidden xl:table-cell' : undefined);
  /** The actions column stays pinned to the right edge so row actions are always reachable. */
  const pinned = (c: Column<T>, header: boolean) =>
    c.key === 'actions' ? cn('sticky right-0 z-[1] shadow-[-10px_0_10px_-10px_rgba(15,23,42,0.18)]', header ? 'bg-slate-50' : 'bg-white group-hover:bg-slate-50') : undefined;
  const selectableIds = selection ? rows.filter((r) => selection.isSelectable?.(r) ?? true).map(rowKey) : [];
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selection?.selected.has(id));

  return (
    <div className="relative overflow-x-auto">
      <table className="w-full min-w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50/80">
            {selection && (
              <th className="w-10 px-4 py-2.5">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={allSelected}
                  disabled={!selectableIds.length}
                  onChange={() => selection.onToggleAll(allSelected ? [] : selectableIds)}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                />
              </th>
            )}
            {columns.map((col) => {
              const active = sort?.key === col.key;
              const SortIcon = active ? (sort?.direction === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
              return (
                <th
                  key={col.key}
                  scope="col"
                  className={cn(
                    'whitespace-nowrap px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500',
                    alignClass(col.align),
                    visibility(col),
                    pinned(col, true),
                    col.className,
                  )}
                >
                  {col.sortable && onSort ? (
                    <button onClick={() => onSort(col.key)} className={cn('inline-flex items-center gap-1 uppercase hover:text-slate-800', active && 'text-slate-800')}>
                      {col.header}
                      <SortIcon className={cn('h-3 w-3', !active && 'opacity-40')} />
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => {
            const id = rowKey(row);
            const canSelect = selection ? selection.isSelectable?.(row) ?? true : false;
            return (
              <tr
                key={id}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn('group transition-colors', onRowClick && 'cursor-pointer hover:bg-slate-50', rowClassName?.(row))}
              >
                {selection && (
                  <td className="w-10 px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label="Select row"
                      disabled={!canSelect}
                      checked={selection.selected.has(id)}
                      onChange={() => selection.onToggle(id)}
                      className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 disabled:opacity-30"
                    />
                  </td>
                )}
                {columns.map((col) => (
                  <td key={col.key} className={cn('px-4 py-3 align-middle text-slate-700', alignClass(col.align), visibility(col), pinned(col, false), col.className)}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <EmptyState title={emptyTitle} description={emptyDescription} />}
      {footer}
    </div>
  );
}

/** Toolbar row placed above a table inside a Card. */
export function TableToolbar({ children, right }: { children?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
      <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">{children}</div>
      {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
    </div>
  );
}
