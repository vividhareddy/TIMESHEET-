import { Fragment, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Allocation, Employee } from '@/types';
import { useAppData } from '@/context/AppDataContext';
import { useLookups } from '@/hooks/useLookups';
import { useTableState } from '@/hooks/useTableState';
import { useAsyncAction } from '@/hooks/useAsyncAction';
import { formatDate, todayISO } from '@/utils/date';
import { cn, formatHours, percent, sum } from '@/utils/format';
import { activeAllocationsOn, allocationHealth, type AllocationHealth } from '@/utils/timesheet';
import { Card } from '@/components/common/Card';
import { Button, IconButton } from '@/components/common/Button';
import { Badge, StatusBadge } from '@/components/common/Badge';
import { PersonCell, ProjectDot, Segmented } from '@/components/common/Misc';
import { StackedBar } from '@/components/common/Charts';
import { DataTable, TableToolbar, type Column } from '@/components/tables/DataTable';
import { FilterSelect, SearchInput } from '@/components/forms/FormControls';
import { AllocationFormModal } from '@/components/forms/AllocationFormModal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { StatCard } from '@/components/common/StatCard';
import { AlertTriangle, CheckCircle2, Network, TrendingDown } from 'lucide-react';

interface Props {
  /** Restrict editing / listing to these projects (manager). */
  projectIds?: string[];
}

interface CapacityRow {
  employee: Employee;
  allocs: Allocation[];
  total: number;
  health: AllocationHealth;
}

function periodStatus(a: Allocation, today: string): { label: string; tone: 'green' | 'blue' | 'slate' } {
  if (a.startDate > today) return { label: 'Upcoming', tone: 'blue' };
  if (a.endDate < today) return { label: 'Ended', tone: 'slate' };
  return { label: 'Active', tone: 'green' };
}

export function AllocationBoard({ projectIds }: Props) {
  const { allocations, employees, projects, deleteAllocation } = useAppData();
  const { project, employeeName } = useLookups();
  const { busy, run } = useAsyncAction();
  const today = todayISO();
  const [view, setView] = useState<'capacity' | 'list'>('capacity');
  const [projectFilter, setProjectFilter] = useState('all');
  const [healthFilter, setHealthFilter] = useState('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Allocation | null | undefined>(undefined);
  const [defaults, setDefaults] = useState<{ employeeId?: string }>({});
  const [removing, setRemoving] = useState<Allocation | null>(null);

  const scope = useMemo(() => new Set(projectIds ?? projects.map((p) => p.id)), [projectIds, projects]);
  const scopedProjects = projects.filter((p) => scope.has(p.id));
  const canEdit = (a: Allocation) => scope.has(a.projectId);
  const editingAllowed = !editing || scope.has(editing.projectId);
  const removingAllowed = removing !== null && scope.has(removing.projectId);

  useEffect(() => {
    if (projectFilter !== 'all' && !scope.has(projectFilter)) setProjectFilter('all');
    if (!editingAllowed) setEditing(undefined);
    if (!removingAllowed) setRemoving(null);
  }, [scope, projectFilter, editingAllowed, removingAllowed]);

  const active = activeAllocationsOn(allocations, today);

  /** Capacity considers ALL of an employee's active allocations, even outside the manager's scope. */
  const capacityRows = useMemo<CapacityRow[]>(() => {
    const inScope = new Set(allocations.filter((a) => scope.has(a.projectId)).map((a) => a.employeeId));
    return employees
      .filter((e) => e.status === 'active' && e.systemRole === 'associate' && (!projectIds || inScope.has(e.id)))
      .map((employee) => {
        const allocs = active.filter((a) => a.employeeId === employee.id);
        const total = sum(allocs.map((a) => a.weeklyHours));
        return { employee, allocs, total, health: allocationHealth(total, employee.weeklyCapacity) };
      })
      .filter((r) => (projectFilter === 'all' || r.allocs.some((a) => a.projectId === projectFilter)) && (healthFilter === 'all' || r.health === healthFilter));
  }, [employees, active, allocations, scope, projectIds, projectFilter, healthFilter]);

  const capTable = useTableState(capacityRows, {
    searchText: (r) => `${r.employee.name} ${r.employee.designation}`,
    accessors: { name: (r) => r.employee.name, total: (r) => r.total, pct: (r) => r.total / r.employee.weeklyCapacity },
    initialSort: { key: 'name', direction: 'asc' },
  });

  const listRows = useMemo(
    () => allocations.filter((a) => scope.has(a.projectId) && (projectFilter === 'all' || a.projectId === projectFilter)),
    [allocations, scope, projectFilter],
  );
  const listTable = useTableState(listRows, {
    searchText: (a) => `${employeeName(a.employeeId)} ${project(a.projectId)?.name} ${a.projectRole}`,
    accessors: { employee: (a) => employeeName(a.employeeId), project: (a) => project(a.projectId)?.name, hours: (a) => a.weeklyHours, start: (a) => a.startDate, end: (a) => a.endDate },
    initialSort: { key: 'employee', direction: 'asc' },
  });

  const allCap = employees.filter((e) => e.status === 'active' && e.systemRole === 'associate').map((e) => {
    const t = sum(active.filter((a) => a.employeeId === e.id).map((a) => a.weeklyHours));
    return allocationHealth(t, e.weeklyCapacity);
  });

  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const openNew = (employeeId?: string) => {
    setDefaults({ employeeId });
    setEditing(null);
  };

  const rowActions = (a: Allocation) =>
    canEdit(a) ? (
      <div className="flex justify-end gap-0.5">
        <IconButton icon={Pencil} label="Edit allocation" onClick={() => setEditing(a)} />
        <IconButton icon={Trash2} label="Remove allocation" tone="danger" onClick={() => setRemoving(a)} />
      </div>
    ) : (
      <span className="text-xs text-slate-400">Other PM</span>
    );

  const listColumns: Column<Allocation>[] = [
    { key: 'employee', header: 'Employee', sortable: true, render: (a) => <PersonCell name={employeeName(a.employeeId)} /> },
    { key: 'project', header: 'Project', sortable: true, render: (a) => <span className="flex items-center gap-2"><ProjectDot color={project(a.projectId)?.color ?? '#94a3b8'} />{project(a.projectId)?.name}</span> },
    { key: 'role', header: 'Role', render: (a) => <span className="text-slate-600">{a.projectRole}</span> },
    { key: 'hours', header: 'Weekly hours', align: 'right', sortable: true, render: (a) => <span className="font-semibold tabular-nums">{formatHours(a.weeklyHours)}</span> },
    { key: 'pct', header: 'Allocation', align: 'right', render: (a) => `${percent(a.weeklyHours, employees.find((e) => e.id === a.employeeId)?.weeklyCapacity ?? 40)}%` },
    { key: 'start', header: 'Start', sortable: true, render: (a) => formatDate(a.startDate) },
    { key: 'end', header: 'End', sortable: true, render: (a) => formatDate(a.endDate) },
    { key: 'status', header: 'Period', render: (a) => { const s = periodStatus(a, today); return <Badge tone={s.tone}>{s.label}</Badge>; } },
    { key: 'actions', header: <span className="sr-only">Actions</span>, align: 'right', render: rowActions },
  ];

  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard label="Active allocations" value={active.filter((a) => scope.has(a.projectId)).length} icon={Network} />
        <StatCard label="Fully allocated" value={allCap.filter((h) => h === 'optimal').length} icon={CheckCircle2} tone="green" hint="At 100% of capacity" />
        <StatCard label="Under-allocated" value={allCap.filter((h) => h === 'under').length} icon={TrendingDown} tone="amber" hint="Capacity available" />
        <StatCard label="Over-allocated" value={allCap.filter((h) => h === 'over').length} icon={AlertTriangle} tone="red" hint="Above weekly capacity" />
      </div>

      <Card>
        <TableToolbar
          right={
            <>
              <Segmented value={view} onChange={setView} options={[{ value: 'capacity', label: 'Capacity view' }, { value: 'list', label: 'All allocations' }]} />
              <Button icon={Plus} onClick={() => openNew()}>Allocate resource</Button>
            </>
          }
        >
          {view === 'capacity' ? (
            <SearchInput value={capTable.query} onChange={capTable.setQuery} placeholder="Search employees…" />
          ) : (
            <SearchInput value={listTable.query} onChange={listTable.setQuery} placeholder="Search allocations…" />
          )}
          {scopedProjects.length > 1 && (
            <FilterSelect label="Project" value={projectFilter} onChange={setProjectFilter} options={[{ value: 'all', label: 'All projects' }, ...scopedProjects.map((p) => ({ value: p.id, label: p.name }))]} />
          )}
          {view === 'capacity' && (
            <FilterSelect
              label="Allocation health"
              value={healthFilter}
              onChange={setHealthFilter}
              options={[{ value: 'all', label: 'All levels' }, { value: 'under', label: 'Under-allocated' }, { value: 'optimal', label: 'Fully allocated' }, { value: 'over', label: 'Over-allocated' }]}
            />
          )}
        </TableToolbar>

        {view === 'capacity' ? (
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2.5 text-left font-semibold">
                    <button onClick={() => capTable.toggleSort('name')} className="uppercase hover:text-slate-800">Employee</button>
                  </th>
                  <th className="px-4 py-2.5 text-left font-semibold">Projects</th>
                  <th className="w-[28%] px-4 py-2.5 text-left font-semibold">Allocation vs capacity</th>
                  <th className="px-4 py-2.5 text-right font-semibold">
                    <button onClick={() => capTable.toggleSort('total')} className="uppercase hover:text-slate-800">Allocated</button>
                  </th>
                  <th className="px-4 py-2.5 text-left font-semibold">Health</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {capTable.rows.map((r) => {
                  const open = expanded.has(r.employee.id);
                  const pct = percent(r.total, r.employee.weeklyCapacity);
                  return (
                    <Fragment key={r.employee.id}>
                      <tr className={cn('cursor-pointer hover:bg-slate-50', r.health === 'over' && 'bg-rose-50/30')} onClick={() => toggle(r.employee.id)}>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            {open ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
                            <PersonCell name={r.employee.name} sub={r.employee.designation} />
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {r.allocs.map((a) => (
                              <span key={a.id} className="inline-flex items-center gap-1 rounded border border-slate-200 px-1.5 py-0.5 text-xs text-slate-600">
                                <ProjectDot color={project(a.projectId)?.color ?? '#94a3b8'} />
                                {project(a.projectId)?.name} · {formatHours(a.weeklyHours)}
                              </span>
                            ))}
                            {r.allocs.length === 0 && <span className="text-xs text-slate-400">Unallocated</span>}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <StackedBar total={r.employee.weeklyCapacity} segments={r.allocs.map((a) => ({ value: a.weeklyHours, color: project(a.projectId)?.color ?? '#94a3b8', label: project(a.projectId)?.name ?? '' }))} />
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          <span className={cn('font-semibold', r.health === 'over' ? 'text-rose-600' : r.health === 'under' ? 'text-amber-700' : 'text-slate-800')}>{formatHours(r.total)}</span>
                          <span className="text-slate-400"> / {formatHours(r.employee.weeklyCapacity)}</span>
                          <div className="text-[11px] text-slate-500">{pct}%</div>
                        </td>
                        <td className="px-4 py-3"><StatusBadge status={r.health} /></td>
                        <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                          <Button size="sm" variant="secondary" icon={Plus} onClick={() => openNew(r.employee.id)}>Add</Button>
                        </td>
                      </tr>
                      {open && (
                        <tr className="bg-slate-50/60">
                          <td colSpan={6} className="px-4 pb-3 pt-1">
                            <div className="ml-6 overflow-hidden rounded-md border border-slate-200 bg-white">
                              <table className="w-full text-sm">
                                <thead className="bg-slate-50 text-xs text-slate-500">
                                  <tr>
                                    <th className="px-3 py-2 text-left font-semibold">Project</th>
                                    <th className="px-3 py-2 text-left font-semibold">Role</th>
                                    <th className="px-3 py-2 text-right font-semibold">Weekly hours</th>
                                    <th className="px-3 py-2 text-right font-semibold">%</th>
                                    <th className="px-3 py-2 text-left font-semibold">Dates</th>
                                    <th className="px-3 py-2" />
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                  {allocations
                                    .filter((a) => a.employeeId === r.employee.id)
                                    .map((a) => {
                                      const s = periodStatus(a, today);
                                      return (
                                        <tr key={a.id}>
                                          <td className="px-3 py-2"><span className="flex items-center gap-2"><ProjectDot color={project(a.projectId)?.color ?? '#94a3b8'} />{project(a.projectId)?.name}</span></td>
                                          <td className="px-3 py-2 text-slate-600">{a.projectRole}</td>
                                          <td className="px-3 py-2 text-right font-medium tabular-nums">{formatHours(a.weeklyHours)}</td>
                                          <td className="px-3 py-2 text-right tabular-nums text-slate-500">{percent(a.weeklyHours, r.employee.weeklyCapacity)}%</td>
                                          <td className="px-3 py-2 text-xs text-slate-500">{formatDate(a.startDate)} → {formatDate(a.endDate)} <Badge tone={s.tone} className="ml-1">{s.label}</Badge></td>
                                          <td className="px-3 py-2">{rowActions(a)}</td>
                                        </tr>
                                      );
                                    })}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            {capTable.rows.length === 0 && <p className="px-5 py-10 text-center text-sm text-slate-500">No employees match these filters.</p>}
          </div>
        ) : (
          <DataTable columns={listColumns} rows={listTable.rows} rowKey={(a) => a.id} sort={listTable.sort} onSort={listTable.toggleSort} emptyTitle="No allocations found" />
        )}
      </Card>

      <AllocationFormModal open={editing !== undefined && editingAllowed} allocation={editing} defaults={defaults} projectIds={projectIds} onClose={() => setEditing(undefined)} />
      <ConfirmDialog
        open={removingAllowed}
        title="Remove allocation?"
        tone="danger"
        confirmLabel="Remove"
        busy={busy}
        message={removing && `${employeeName(removing.employeeId)} will no longer be allocated to ${project(removing.projectId)?.name} (${formatHours(removing.weeklyHours)}/week). Submitted timesheets are not affected.`}
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing || !canEdit(removing)) return;
          const ok = await run(() => deleteAllocation(removing.id), { title: 'Allocation removed' });
          if (ok) setRemoving(null);
        }}
      />
    </>
  );
}
