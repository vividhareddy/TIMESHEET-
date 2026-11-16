import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, Eye, Pencil, Power, UserPlus } from 'lucide-react';
import type { Employee } from '@/types';
import { useAppData } from '@/context/AppDataContext';
import { useLookups, useReferenceData } from '@/hooks/useLookups';
import { useTableState } from '@/hooks/useTableState';
import { useAsyncAction } from '@/hooks/useAsyncAction';
import { downloadCsv, formatHours, sum } from '@/utils/format';
import { activeAllocationsOn, allocationHealth } from '@/utils/timesheet';
import { todayISO } from '@/utils/date';
import { PageHeader, PersonCell } from '@/components/common/Misc';
import { Card } from '@/components/common/Card';
import { Button, IconButton } from '@/components/common/Button';
import { Badge, StatusBadge } from '@/components/common/Badge';
import { DataTable, TableToolbar, type Column } from '@/components/tables/DataTable';
import { FilterSelect, SearchInput } from '@/components/forms/FormControls';
import { EmployeeFormModal } from '@/components/forms/EmployeeFormModal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';

export function EmployeesPage() {
  const { employees, allocations, setEmployeeStatus } = useAppData();
  const { employeeName, calendarOf } = useLookups();
  const ref = useReferenceData();
  const navigate = useNavigate();
  const { busy, run } = useAsyncAction();
  const [editing, setEditing] = useState<Employee | null | undefined>(undefined);
  const [toggling, setToggling] = useState<Employee | null>(null);
  const [dept, setDept] = useState('all');
  const [status, setStatus] = useState('active');
  const [country, setCountry] = useState('all');

  const active = activeAllocationsOn(allocations, todayISO());
  const allocatedOf = (id: string) => sum(active.filter((a) => a.employeeId === id).map((a) => a.weeklyHours));

  const filtered = employees.filter((e) => (dept === 'all' || e.department === dept) && (status === 'all' || e.status === status) && (country === 'all' || e.country === country));

  const table = useTableState(filtered, {
    searchText: (e) => `${e.name} ${e.employeeCode} ${e.email} ${e.designation}`,
    accessors: { name: (e) => e.name, code: (e) => e.employeeCode, department: (e) => e.department, location: (e) => e.workLocation, allocation: (e) => allocatedOf(e.id) },
    initialSort: { key: 'code', direction: 'asc' },
  });

  const columns: Column<Employee>[] = [
    { key: 'code', header: 'Emp ID', sortable: true, render: (e) => <span className="font-mono text-xs text-slate-600">{e.employeeCode}</span> },
    { key: 'name', header: 'Employee', sortable: true, render: (e) => <PersonCell name={e.name} sub={e.email} /> },
    { key: 'department', header: 'Department', sortable: true, render: (e) => <div><p className="text-slate-800">{e.department}</p><p className="text-xs text-slate-500">{e.designation}</p></div> },
    { key: 'location', header: 'Work location', sortable: true, render: (e) => <div><p>{e.workLocation}</p><p className="text-xs text-slate-500">{calendarOf(e)?.name}</p></div> },
    { key: 'manager', header: 'Manager', hideOnTablet: true, render: (e) => <span className="text-slate-600">{e.managerId ? employeeName(e.managerId) : '—'}</span> },
    { key: 'role', header: 'Role', hideOnTablet: true, render: (e) => <Badge tone={e.systemRole === 'admin' ? 'violet' : e.systemRole === 'manager' ? 'blue' : 'slate'}>{ref.label(ref.roles, e.systemRole)}</Badge> },
    {
      key: 'allocation',
      header: 'Allocation',
      align: 'right',
      sortable: true,
      render: (e) => {
        if (e.systemRole !== 'associate') return <span className="text-xs text-slate-400">n/a</span>;
        const total = allocatedOf(e.id);
        const h = allocationHealth(total, e.weeklyCapacity);
        return (
          <span className={h === 'over' ? 'font-medium text-rose-600' : h === 'under' ? 'font-medium text-amber-700' : 'text-slate-700'}>
            {formatHours(total)} / {formatHours(e.weeklyCapacity)}
          </span>
        );
      },
    },
    { key: 'status', header: 'Status', render: (e) => <StatusBadge status={e.status} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (e) => (
        <div className="flex justify-end gap-0.5" onClick={(ev) => ev.stopPropagation()}>
          <IconButton icon={Eye} label="View details" onClick={() => navigate(`/admin/employees/${e.id}`)} />
          <IconButton icon={Pencil} label="Edit" onClick={() => setEditing(e)} />
          <IconButton icon={Power} label={e.status === 'active' ? 'Deactivate' : 'Activate'} tone={e.status === 'active' ? 'danger' : 'success'} onClick={() => setToggling(e)} />
        </div>
      ),
    },
  ];

  const exportCsv = () =>
    downloadCsv('employees.csv', [
      ['Employee ID', 'Name', 'Email', 'Department', 'Designation', 'Location', 'Calendar', 'Manager', 'Role', 'Weekly target', 'Status'],
      ...table.rows.map((e) => [e.employeeCode, e.name, e.email, e.department, e.designation, e.workLocation, calendarOf(e)?.name ?? '', e.managerId ? employeeName(e.managerId) : '', e.systemRole, e.weeklyCapacity, e.status]),
    ]);

  return (
    <div>
      <PageHeader
        title="Employees"
        description="Manage employee records, reporting managers, calendars and status."
        actions={
          <>
            <Button variant="secondary" icon={Download} onClick={exportCsv}>Export</Button>
            <Button icon={UserPlus} onClick={() => setEditing(null)}>Add employee</Button>
          </>
        }
      />
      <Card>
        <TableToolbar right={<span className="text-xs text-slate-500">{table.rows.length} of {employees.length} employees</span>}>
          <SearchInput value={table.query} onChange={table.setQuery} placeholder="Search name, ID, email…" />
          <FilterSelect label="Department" value={dept} onChange={setDept} options={[{ value: 'all', label: 'All departments' }, ...ref.departments.map((d) => ({ value: d.name, label: d.name }))]} />
          <FilterSelect label="Country" value={country} onChange={setCountry} options={[{ value: 'all', label: 'All countries' }, ...ref.countries]} />
          <FilterSelect label="Status" value={status} onChange={setStatus} options={[...ref.employeeStatuses, { value: 'all', label: 'All statuses' }]} />
        </TableToolbar>
        <DataTable
          columns={columns}
          rows={table.rows}
          rowKey={(e) => e.id}
          sort={table.sort}
          onSort={table.toggleSort}
          onRowClick={(e) => navigate(`/admin/employees/${e.id}`)}
          emptyTitle="No employees match your filters"
          rowClassName={(e) => (e.status === 'inactive' ? 'opacity-60' : undefined)}
        />
      </Card>

      <EmployeeFormModal open={editing !== undefined} employee={editing} onClose={() => setEditing(undefined)} />
      <ConfirmDialog
        open={!!toggling}
        title={toggling?.status === 'active' ? 'Deactivate employee?' : 'Activate employee?'}
        tone={toggling?.status === 'active' ? 'danger' : 'primary'}
        confirmLabel={toggling?.status === 'active' ? 'Deactivate' : 'Activate'}
        busy={busy}
        message={
          toggling?.status === 'active'
            ? `${toggling?.name} will no longer be able to submit timesheets and will be hidden from allocation lists. Historical data is kept.`
            : `${toggling?.name} will be able to log time again.`
        }
        onCancel={() => setToggling(null)}
        onConfirm={async () => {
          if (!toggling) return;
          const next = toggling.status === 'active' ? 'inactive' : 'active';
          const ok = await run(() => setEmployeeStatus(toggling.id, next), { title: next === 'active' ? 'Employee activated' : 'Employee deactivated', message: toggling.name });
          if (ok) setToggling(null);
        }}
      />
    </div>
  );
}
