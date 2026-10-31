// One list, two layouts: a table on tablets/desktops (md and up), stacked cards
// on phones, where a 7-column table would force sideways scrolling and hide
// the columns that matter (amount, status).
import type { ReactNode } from 'react';
import { cx } from './ui';

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  align?: 'left' | 'right';
  /**
   * How the column appears on a phone card:
   *  title  - first line, left (e.g. amount or reference)
   *  badge  - first line, right (e.g. status)
   *  field  - label/value pair under the title (default)
   *  hide   - not shown on phones
   */
  mobile?: 'title' | 'badge' | 'field' | 'hide';
  /** Phone-only column (e.g. a combined value the table already shows in two columns). */
  desktopHide?: boolean;
}

interface DataListProps<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  empty?: boolean;
  footer?: ReactNode;
}

export function DataList<T>({ rows, columns, rowKey, onRowClick, empty, footer }: DataListProps<T>) {
  const titles = columns.filter((c) => c.mobile === 'title');
  const badges = columns.filter((c) => c.mobile === 'badge');
  const fields = columns.filter((c) => !c.mobile || c.mobile === 'field');
  const tableColumns = columns.filter((c) => !c.desktopHide);
  const clickable = onRowClick ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50' : '';

  return (
    <>
      {/* Phones: cards */}
      <ul className="-mx-4 divide-y divide-slate-100 md:hidden dark:divide-slate-800">
        {rows.map((row) => (
          <li
            key={rowKey(row)}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={cx('px-4 py-3', clickable)}
          >
            {(titles.length > 0 || badges.length > 0) && (
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-0.5 break-words font-medium">
                  {titles.map((c) => (
                    <div key={c.header}>{c.cell(row)}</div>
                  ))}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {badges.map((c) => (
                    <div key={c.header}>{c.cell(row)}</div>
                  ))}
                </div>
              </div>
            )}
            {fields.length > 0 && (
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                {fields.map((c) => (
                  <div key={c.header} className="min-w-0">
                    <dt className="text-xs text-slate-500 dark:text-slate-400">{c.header}</dt>
                    <dd className="break-words">{c.cell(row)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </li>
        ))}
        {footer && <li className="px-4 py-2">{footer}</li>}
      </ul>

      {/* Tablets and up: table */}
      <div className="-mx-4 hidden overflow-x-auto md:block">
        <table className="min-w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
              {tableColumns.map((c) => (
                <th key={c.header} className={cx('whitespace-nowrap px-4 py-2 font-medium', c.align === 'right' && 'text-right')}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((row) => (
              <tr key={rowKey(row)} onClick={onRowClick ? () => onRowClick(row) : undefined} className={clickable}>
                {tableColumns.map((c) => (
                  <td key={c.header} className={cx('whitespace-nowrap px-4 py-2', c.align === 'right' && 'tabular text-right')}>
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
            {footer && (
              <tr>
                <td colSpan={tableColumns.length} className="px-4 py-2">
                  {footer}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {empty && <div className="px-4 py-8 text-center text-sm text-slate-500">Nothing here yet.</div>}
    </>
  );
}
