import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Mail, MapPin, Pencil, Phone, Plus } from 'lucide-react';
import type { Allocation, Timesheet } from '@/types';
import { useAppData } from '@/context/AppDataContext';
import { useLookups, useReferenceData } from '@/hooks/useLookups';
import { DAY_SHORT, formatDate, formatWeekRange, todayISO } from '@/utils/date';
import { formatHours, percent, sum } from '@/utils/format';
import { activeAllocationsOn, allocationHealth, dailyTarget, deriveTimesheetStatus, timesheetTotal } from '@/utils/timesheet';
import { Avatar, EmptyState, InfoRow, ProjectDot, ProgressBar } from '@/components/common/Misc';
import { Card, CardBody, CardHeader } from '@/components/common/Card';
import { Button, IconButton } from '@/components/common/Button';
import { Badge, StatusBadge } from '@/components/common/Badge';
import { StackedBar } from '@/components/common/Charts';
import { EmployeeFormModal } from '@/components/forms/EmployeeFormModal';
import { AllocationFormModal } from '@/components/forms/AllocationFormModal';
import { TimesheetDetailModal } from '@/components/timesheet/TimesheetDetailModal';
import { LeaveRequestTable } from '@/components/tables/LeaveRequestTable';

export function EmployeeDetailPage() {
  const { id } = useParams();
  const { allocations, timesheets, leaves } = useAppData();
  const { employee, employeeName, calendarOf, project } = useLookups();
  const ref = useReferenceData();
  const emp = employee(id);
  const [editing, setEditing] = useState(false);
  const [alloc, setAlloc] = useState<Allocation | null | undefined>(undefined);
  const [viewing, setViewing] = useState<Timesheet | null>(null);

  if (!emp) {
    return (
      <Card>
        <EmptyState title="Employee not found" action={<Link to="/admin/employees" className="text-sm font-medium text-brand-600">Back to employees</Link>} />
      </Card>
    );
  }

  const myAllocs = allocations.filter((a) => a.employeeId === emp.id).sort((a, b) => b.startDate.localeCompare(a.startDate));
  const current = activeAllocationsOn(myAllocs, todayISO());
  const total = sum(current.map((a) => a.weeklyHours));
  const health = allocationHealth(total, emp.weeklyCapacity);
  const recent = timesheets.filter((t) => t.employeeId === emp.id).sort((a, b) => b.weekStart.localeCompare(a.weekStart)).slice(0, 8);

  return (
    <div>
      <Link to="/admin/employees" className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="h-4 w-4" /> Employees
      </Link>

      <Card className="mb-5">
        <div className="flex flex-wrap items-start justify-between gap-4 p-5">
          <div className="flex items-center gap-4">
            <Avatar name={emp.name} size="lg" />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-semibold text-slate-900">{emp.name}</h1>
                <StatusBadge status={emp.status} />
                <Badge tone="blue">{ref.label(ref.roles, emp.systemRole)}</Badge>
              </div>
              <p className="mt-0.5 text-sm text-slate-500">{emp.employeeCode} · {emp.designation} · {emp.department}</p>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                <span className="flex items-center gap-1"><Mail className="h-3.5 w-3.5" />{emp.email}</span>
                <span className="flex items-center gap-1"><Phone className="h-3.5 w-3.5" />{emp.phone || '—'}</span>
                <span className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{emp.workLocation}</span>
              </div>
            </div>
          </div>
          <Button variant="secondary" icon={Pencil} onClick={() => setEditing(true)}>Edit employee</Button>
        </div>
      </Card>

      <div className="grid gap-5 xl:grid-cols-3">
        <Card>
          <CardHeader title="Employment details" />
          <CardBody className="divide-y divide-slate-100 py-2">
            <InfoRow label="Reporting manager">{emp.managerId ? employeeName(emp.managerId) : '—'}</InfoRow>
            <InfoRow label="Holiday calendar">{calendarOf(emp)?.name}</InfoRow>
            <InfoRow label="Weekly target">{formatHours(emp.weeklyCapacity)}</InfoRow>
            <InfoRow label="Working schedule">
              {calendarOf(emp)
                ? `${calendarOf(emp)!.workingDays.map((d) => DAY_SHORT[(d + 6) % 7]).join(', ')} · ${formatHours(dailyTarget(emp, calendarOf(emp)))}/day`
                : 'No calendar assigned'}
            </InfoRow>
            <InfoRow label="Join date">{formatDate(emp.joinDate)}</InfoRow>
          </CardBody>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader
            title="Project allocations"
            description={`${formatHours(total)} of ${formatHours(emp.weeklyCapacity)} allocated this week (${percent(total, emp.weeklyCapacity)}%)`}
            actions={
              <>
                <StatusBadge status={health} />
                {emp.status === 'active' && <Button size="sm" icon={Plus} onClick={() => setAlloc(null)}>Allocate</Button>}
              </>
            }
          />
          <CardBody>
            <StackedBar total={emp.weeklyCapacity} segments={current.map((a) => ({ value: a.weeklyHours, color: project(a.projectId)?.color ?? '#94a3b8', label: project(a.projectId)?.name ?? '' }))} className="h-3" />
            <ul className="mt-4 divide-y divide-slate-100">
              {myAllocs.map((a) => {
                const p = project(a.projectId);
                const isActive = current.includes(a);
                return (
                  <li key={a.id} className="flex flex-wrap items-center gap-3 py-3">
                    <span className="flex min-w-[140px] items-center gap-2 font-medium text-slate-800"><ProjectDot color={p?.color ?? '#94a3b8'} />{p?.name}</span>
                    <span className="text-sm text-slate-500">{a.projectRole}</span>
                    <span className="text-xs text-slate-500">{formatDate(a.startDate)} → {formatDate(a.endDate)}</span>
                    <span className="ml-auto flex items-center gap-3">
                      {!isActive && <Badge>Inactive period</Badge>}
                      <span className="w-28 text-right text-sm tabular-nums">
                        <span className="font-semibold">{formatHours(a.weeklyHours)}</span> <span className="text-slate-400">({percent(a.weeklyHours, emp.weeklyCapacity)}%)</span>
                      </span>
                      <IconButton icon={Pencil} label="Edit allocation" onClick={() => setAlloc(a)} />
                    </span>
                  </li>
                );
              })}
              {myAllocs.length === 0 && <li className="py-4 text-sm text-slate-500">No allocations yet.</li>}
            </ul>
          </CardBody>
        </Card>

        <Card className="xl:col-span-3">
          <CardHeader title="Recent timesheets" description="Click a week to view details and approval history." />
          <div className="relative overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-2.5 text-left font-semibold">Week</th>
                  <th className="px-5 py-2.5 text-right font-semibold">Hours</th>
                  <th className="px-5 py-2.5 text-left font-semibold">Approval progress</th>
                  <th className="px-5 py-2.5 text-left font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {recent.map((t) => {
                  const approved = t.entries.filter((e) => e.status === 'approved').length;
                  return (
                    <tr key={t.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setViewing(t)}>
                      <td className="px-5 py-3 font-medium text-slate-800">{formatWeekRange(t.weekStart)}</td>
                      <td className="px-5 py-3 text-right tabular-nums">{formatHours(timesheetTotal(t))}</td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <ProgressBar value={approved} max={t.entries.length} tone="green" className="w-28" />
                          <span className="text-xs text-slate-500">{approved}/{t.entries.length}</span>
                        </div>
                      </td>
                      <td className="px-5 py-3"><StatusBadge status={deriveTimesheetStatus(t)} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {recent.length === 0 && <EmptyState title="No timesheets yet" />}
          </div>
        </Card>

        <Card className="xl:col-span-3">
          <CardHeader title="Leave history" />
          <LeaveRequestTable leaves={leaves.filter((l) => l.employeeId === emp.id)} showEmployee={false} />
        </Card>
      </div>

      <EmployeeFormModal open={editing} employee={emp} onClose={() => setEditing(false)} />
      <AllocationFormModal open={alloc !== undefined} allocation={alloc} defaults={{ employeeId: emp.id }} onClose={() => setAlloc(undefined)} />
      <TimesheetDetailModal timesheet={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
