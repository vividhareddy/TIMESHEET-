import { useMemo } from 'react';
import type { Notification, Role } from '@/types';
import { useAppData } from '@/context/AppDataContext';
import { useCurrentUser, useLookups } from './useLookups';
import { formatWeekRange, currentWeekStart } from '@/utils/date';
import { deriveTimesheetStatus } from '@/utils/timesheet';

export interface BadgeCounts {
  approvals: number;
  overtime: number;
  returned: number;
  leave: number;
}

/** Role-aware counts for sidebar badges and the notification menu. */
export function useNotifications(): { counts: BadgeCounts; items: Notification[] } {
  const user = useCurrentUser();
  const role = user.systemRole;
  const { timesheets, overtime, leaves, projects, employees } = useAppData();
  const { employeeName, projectName } = useLookups();

  return useMemo(() => {
    const items: Notification[] = [];
    const counts: BadgeCounts = { approvals: 0, overtime: 0, returned: 0, leave: 0 };
    const r = role as Role;

    if (r === 'manager' || r === 'admin') {
      const myProjects = new Set(projects.filter((p) => r === 'admin' || p.managerId === user.id).map((p) => p.id));
      const pendingEntries = timesheets.flatMap((t) => t.entries.filter((e) => e.status === 'pending' && myProjects.has(e.projectId)).map(() => t));
      counts.approvals = pendingEntries.length;
      counts.overtime = overtime.filter((o) => o.status === 'pending' && myProjects.has(o.projectId)).length;
      const directReports = new Set(employees.filter((e) => r === 'admin' || e.managerId === user.id).map((e) => e.id));
      counts.leave = leaves.filter((l) => l.status === 'pending' && directReports.has(l.employeeId)).length;
      const base = r === 'admin' ? '/admin/approvals' : '/manager';
      if (counts.approvals)
        items.push({ id: 'n-appr', title: `${counts.approvals} timesheet entries awaiting approval`, description: 'Review submitted project hours.', to: r === 'admin' ? base : `${base}/approvals`, tone: 'warning' });
      if (counts.overtime)
        items.push({ id: 'n-ot', title: `${counts.overtime} overtime requests pending`, description: 'Additional hours need a decision.', to: r === 'admin' ? `${base}?tab=overtime` : `${base}/overtime`, tone: 'info' });
      if (counts.leave)
        items.push({ id: 'n-lv', title: `${counts.leave} leave requests pending`, description: 'Team members are waiting for approval.', to: r === 'admin' ? `${base}?tab=leave` : `${base}/calendar`, tone: 'info' });
    }

    if (r === 'associate') {
      const mine = timesheets.filter((t) => t.employeeId === user.id);
      for (const t of mine) {
        const status = deriveTimesheetStatus(t);
        if (status === 'returned' || status === 'rejected') {
          counts.returned += 1;
          const entry = t.entries.find((e) => e.status === 'returned' || e.status === 'rejected');
          items.push({
            id: `n-ret-${t.id}`,
            title: `${projectName(entry?.projectId)} hours ${status} — ${formatWeekRange(t.weekStart)}`,
            description: entry?.managerComment ?? 'Please review and resubmit.',
            to: `/associate/timesheet?week=${t.weekStart}`,
            tone: 'danger',
          });
        }
      }
      const current = mine.find((t) => t.weekStart === currentWeekStart());
      if (deriveTimesheetStatus(current) === 'draft' || !current) {
        items.push({ id: 'n-cur', title: 'This week\'s timesheet is not submitted', description: `Week of ${formatWeekRange(currentWeekStart())}.`, to: '/associate/timesheet', tone: 'warning' });
      }
      for (const l of leaves.filter((x) => x.employeeId === user.id && x.status !== 'pending' && x.reviewerId).slice(-2)) {
        items.push({ id: `n-lv-${l.id}`, title: `Leave on ${l.date} ${l.status}`, description: l.reviewerComment ?? `Reviewed by ${employeeName(l.reviewerId)}.`, to: '/associate/leave', tone: l.status === 'approved' ? 'success' : 'danger' });
      }
    }
    return { counts, items };
  }, [role, user.id, timesheets, overtime, leaves, projects, employees, employeeName, projectName]);
}
