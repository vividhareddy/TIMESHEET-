import type { ReactNode } from 'react';
import { MessageSquare } from 'lucide-react';
import type { Timesheet } from '@/types';
import { Modal } from '@/components/common/Modal';
import { StatusBadge } from '@/components/common/Badge';
import { ProjectDot } from '@/components/common/Misc';
import { useAppData } from '@/context/AppDataContext';
import { useLookups } from '@/hooks/useLookups';
import { formatWeekRange } from '@/utils/date';
import { formatHours } from '@/utils/format';
import { allocationsForWeek, deriveTimesheetStatus, expectedWeekHours, timesheetTotal } from '@/utils/timesheet';
import { HoursTable } from './HoursTable';
import { ApprovalHistory } from './ApprovalHistory';

interface Props {
  timesheet: Timesheet | null;
  onClose: () => void;
  actions?: ReactNode;
}

export function TimesheetDetailModal({ timesheet, onClose, actions }: Props) {
  const { allocations, leaves, policy } = useAppData();
  const { employee, calendarOf, project } = useLookups();
  if (!timesheet) return null;
  const emp = employee(timesheet.employeeId);
  const cal = calendarOf(emp);
  const expected = emp ? expectedWeekHours(emp, cal, leaves, timesheet.weekStart) : 0;
  const total = timesheetTotal(timesheet);
  const allocs = allocationsForWeek(allocations, timesheet.employeeId, timesheet.weekStart);

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={`${emp?.name ?? 'Employee'} — ${formatWeekRange(timesheet.weekStart)}`}
      description={`${emp?.designation ?? ''} · ${cal?.name ?? ''}`}
      footer={actions}
    >
      <div className="grid gap-4 sm:grid-cols-4">
        {[
          ['Status', <StatusBadge key="s" status={deriveTimesheetStatus(timesheet)} />],
          ['Actual hours', formatHours(total)],
          ['Expected hours', formatHours(expected)],
          ['Variance', <span key="v" className={total > expected ? 'text-amber-700' : total < expected ? 'text-rose-600' : 'text-emerald-700'}>{total - expected > 0 ? '+' : ''}{formatHours(total - expected)}</span>],
        ].map(([label, value]) => (
          <div key={label as string} className="rounded-md border border-slate-200 px-4 py-3">
            <p className="text-xs text-slate-500">{label}</p>
            <div className="mt-1 text-base font-semibold text-slate-900">{value}</div>
          </div>
        ))}
      </div>

      <div className="mt-5">
        <HoursTable entries={timesheet.entries} weekStart={timesheet.weekStart} calendar={cal} allocations={allocs} dailyThreshold={policy.dailyThreshold} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div>
          <h4 className="mb-3 text-sm font-semibold text-slate-800">Work descriptions & comments</h4>
          <div className="space-y-3">
            {timesheet.entries.map((e) => (
              <div key={e.projectId} className="rounded-md border border-slate-200 p-3">
                <p className="flex items-center gap-2 text-sm font-medium text-slate-800">
                  <ProjectDot color={project(e.projectId)?.color ?? '#94a3b8'} /> {project(e.projectId)?.name}
                </p>
                <p className="mt-1 text-sm text-slate-600">{e.description || <span className="italic text-slate-400">No description provided.</span>}</p>
                {e.managerComment && (
                  <p className="mt-2 flex gap-2 rounded bg-slate-50 px-2.5 py-2 text-xs text-slate-600">
                    <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" /> {e.managerComment}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
        <div>
          <h4 className="mb-3 text-sm font-semibold text-slate-800">Approval history</h4>
          <ApprovalHistory events={timesheet.history} />
        </div>
      </div>
    </Modal>
  );
}
