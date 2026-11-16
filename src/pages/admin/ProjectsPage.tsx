import { useState } from 'react';
import { FolderKanban, Pencil, Plus, Power, Search, Trash2 } from 'lucide-react';
import type { Project } from '@/types';
import { useAppData } from '@/context/AppDataContext';
import { useLookups } from '@/hooks/useLookups';
import { useTableState } from '@/hooks/useTableState';
import { useAsyncAction } from '@/hooks/useAsyncAction';
import { formatDate, todayISO } from '@/utils/date';
import { formatHours, sum } from '@/utils/format';
import { activeAllocationsOn } from '@/utils/timesheet';
import { PageHeader, PersonCell, ProjectDot, Segmented } from '@/components/common/Misc';
import { Card } from '@/components/common/Card';
import { Button, IconButton } from '@/components/common/Button';
import { Badge, StatusBadge } from '@/components/common/Badge';
import { DataTable, TableToolbar, type Column } from '@/components/tables/DataTable';
import { SearchInput } from '@/components/forms/FormControls';
import { ProjectFormModal } from '@/components/forms/ProjectFormModal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';

export function ProjectsPage() {
  const { projects, allocations, timesheets, setProjectStatus, deleteProject } = useAppData();
  const { employeeName } = useLookups();
  const { busy, run } = useAsyncAction();
  const [editing, setEditing] = useState<Project | null | undefined>(undefined);
  const [toggling, setToggling] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [view, setView] = useState<'cards' | 'table'>('cards');

  const active = activeAllocationsOn(allocations, todayISO());
  const stats = (p: Project) => {
    const allocs = active.filter((a) => a.projectId === p.id);
    const logged = sum(timesheets.flatMap((t) => t.entries.filter((e) => e.projectId === p.id && e.status === 'approved').map((e) => sum(e.hours))));
    const pending = timesheets.flatMap((t) => t.entries).filter((e) => e.projectId === p.id && e.status === 'pending').length;
    return { people: allocs.length, hours: sum(allocs.map((a) => a.weeklyHours)), logged, pending };
  };

  const table = useTableState(projects, {
    searchText: (p) => `${p.name} ${p.client} ${p.code} ${employeeName(p.managerId)}`,
    accessors: { name: (p) => p.name, start: (p) => p.startDate, end: (p) => p.endDate, status: (p) => p.status },
  });

  const actions = (p: Project) => (
    <div className="flex justify-end gap-0.5">
      <IconButton icon={Pencil} label="Edit project" onClick={() => setEditing(p)} />
      <IconButton icon={Power} label={p.status === 'inactive' ? 'Reactivate' : 'Deactivate'} tone={p.status === 'inactive' ? 'success' : 'danger'} onClick={() => setToggling(p)} />
      <IconButton icon={Trash2} label="Delete project" tone="danger" onClick={() => setDeleting(p)} />
    </div>
  );

  const columns: Column<Project>[] = [
    { key: 'name', header: 'Project', sortable: true, render: (p) => <div className="flex items-center gap-2"><ProjectDot color={p.color} /><div><p className="font-medium text-slate-800">{p.name}</p><p className="text-xs text-slate-500">{p.code} · {p.client}</p></div></div> },
    { key: 'manager', header: 'Project manager', render: (p) => <PersonCell name={employeeName(p.managerId)} /> },
    { key: 'start', header: 'Start', sortable: true, render: (p) => formatDate(p.startDate) },
    { key: 'end', header: 'End', sortable: true, render: (p) => formatDate(p.endDate) },
    { key: 'team', header: 'Resources', align: 'right', render: (p) => stats(p).people },
    { key: 'hours', header: 'Weekly hours', align: 'right', render: (p) => formatHours(stats(p).hours) },
    { key: 'status', header: 'Status', sortable: true, render: (p) => <StatusBadge status={p.status} /> },
    { key: 'actions', header: <span className="sr-only">Actions</span>, align: 'right', render: actions },
  ];

  return (
    <div>
      <PageHeader
        title="Projects"
        description="Client projects, project managers and delivery dates."
        actions={
          <>
            <Segmented value={view} onChange={setView} options={[{ value: 'cards', label: 'Cards' }, { value: 'table', label: 'Table' }]} />
            <Button icon={Plus} onClick={() => setEditing(null)}>Add project</Button>
          </>
        }
      />

      {view === 'cards' ? (
        <>
          <div className="mb-4"><SearchInput value={table.query} onChange={table.setQuery} placeholder="Search projects…" /></div>
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {table.rows.map((p) => {
              const s = stats(p);
              return (
                <Card key={p.id} className={p.status === 'inactive' ? 'opacity-70' : undefined}>
                  <div className="h-1 rounded-t-lg" style={{ backgroundColor: p.color }} />
                  <div className="p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="text-base font-semibold text-slate-900">{p.name}</h3>
                        <p className="text-xs text-slate-500">{p.code} · {p.client}</p>
                      </div>
                      <StatusBadge status={p.status} />
                    </div>
                    <p className="mt-3 line-clamp-2 min-h-[40px] text-sm text-slate-600">{p.description}</p>
                    <div className="mt-4 grid grid-cols-3 gap-3 rounded-md bg-slate-50 p-3 text-center">
                      <div><p className="text-lg font-semibold text-slate-900">{s.people}</p><p className="text-[11px] text-slate-500">Resources</p></div>
                      <div><p className="text-lg font-semibold text-slate-900">{formatHours(s.hours)}</p><p className="text-[11px] text-slate-500">Weekly alloc.</p></div>
                      <div><p className="text-lg font-semibold text-slate-900">{s.pending}</p><p className="text-[11px] text-slate-500">Pending</p></div>
                    </div>
                    <div className="mt-4 flex items-center justify-between gap-2 text-sm">
                      <PersonCell name={employeeName(p.managerId)} sub="Project manager" />
                      {p.billable ? <Badge tone="green">Billable</Badge> : <Badge>Non-billable</Badge>}
                    </div>
                    <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-slate-500">
                      <span>{formatDate(p.startDate)} → {formatDate(p.endDate)}</span>
                      {actions(p)}
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
          {table.rows.length === 0 && (
            <Card>
              {projects.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
                  <FolderKanban className="h-8 w-8 text-slate-300" />
                  <p className="text-sm font-medium text-slate-700">No projects yet</p>
                  <p className="text-sm text-slate-500">Create your first client project to start allocating people to it.</p>
                  <Button icon={Plus} className="mt-2" onClick={() => setEditing(null)}>Add project</Button>
                </div>
              ) : (
                <p className="flex items-center gap-2 p-6 text-sm text-slate-500"><Search className="h-4 w-4" />No projects match "{table.query}".</p>
              )}
            </Card>
          )}
        </>
      ) : (
        <Card>
          <TableToolbar>
            <SearchInput value={table.query} onChange={table.setQuery} placeholder="Search projects…" />
          </TableToolbar>
          <DataTable
            columns={columns}
            rows={table.rows}
            rowKey={(p) => p.id}
            sort={table.sort}
            onSort={table.toggleSort}
            emptyTitle={projects.length === 0 ? 'No projects yet' : 'No matching projects'}
            emptyDescription={projects.length === 0 ? 'Use Add project to create the first one.' : 'Try a different search term.'}
          />
        </Card>
      )}

      <ConfirmDialog
        open={!!deleting}
        title="Delete project?"
        tone="danger"
        confirmLabel="Delete"
        busy={busy}
        message={`${deleting?.name ?? ''} (${deleting?.code ?? ''}) will be permanently removed. This cannot be undone. To keep its history, deactivate it instead.`}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          const ok = await run(() => deleteProject(deleting.id), { title: 'Project deleted', message: deleting.name });
          if (ok) setDeleting(null);
        }}
      />
      <ProjectFormModal open={editing !== undefined} project={editing} onClose={() => setEditing(undefined)} />
      <ConfirmDialog
        open={!!toggling}
        title={toggling?.status === 'inactive' ? 'Reactivate project?' : 'Deactivate project?'}
        tone={toggling?.status === 'inactive' ? 'primary' : 'danger'}
        confirmLabel={toggling?.status === 'inactive' ? 'Reactivate' : 'Deactivate'}
        busy={busy}
        message={
          toggling?.status === 'inactive'
            ? `${toggling?.name} will be available for allocations again.`
            : `${toggling?.name} will no longer accept new allocations. Existing timesheet data and approvals are retained.`
        }
        onCancel={() => setToggling(null)}
        onConfirm={async () => {
          if (!toggling) return;
          const next = toggling.status === 'inactive' ? 'active' : 'inactive';
          const ok = await run(() => setProjectStatus(toggling.id, next), { title: next === 'active' ? 'Project reactivated' : 'Project deactivated', message: toggling.name });
          if (ok) setToggling(null);
        }}
      />
    </div>
  );
}
