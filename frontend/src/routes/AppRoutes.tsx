import { useEffect } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import type { Role } from '@/types';
import { useSession } from '@/context/SessionContext';
import { AppDataProvider } from '@/context/AppDataContext';
import { AppLayout } from '@/layouts/AppLayout';
import { homePath } from './navigation';
import { LoginPage } from '@/pages/LoginPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { ErrorScreen, LoadingScreen } from '@/components/common/StatusScreen';

import { AdminDashboard } from '@/pages/admin/AdminDashboard';
import { EmployeesPage } from '@/pages/admin/EmployeesPage';
import { EmployeeDetailPage } from '@/pages/admin/EmployeeDetailPage';
import { ProjectsPage } from '@/pages/admin/ProjectsPage';
import { AllocationsPage } from '@/pages/admin/AllocationsPage';
import { AdminTimesheetsPage } from '@/pages/admin/AdminTimesheetsPage';
import { AdminApprovalsPage } from '@/pages/admin/AdminApprovalsPage';
import { CalendarsPage } from '@/pages/admin/CalendarsPage';
import { OvertimePoliciesPage } from '@/pages/admin/OvertimePoliciesPage';
import { AdminReportsPage } from '@/pages/admin/AdminReportsPage';
import { SettingsPage } from '@/pages/admin/SettingsPage';

import { AssociateDashboard } from '@/pages/associate/AssociateDashboard';
import { MyProjectsPage } from '@/pages/associate/MyProjectsPage';
import { MyTimesheetPage } from '@/pages/associate/MyTimesheetPage';
import { MyCalendarPage } from '@/pages/associate/MyCalendarPage';
import { LeaveRequestsPage } from '@/pages/associate/LeaveRequestsPage';
import { MyOvertimePage } from '@/pages/associate/MyOvertimePage';
import { MySubmissionsPage } from '@/pages/associate/MySubmissionsPage';

import { ManagerDashboard } from '@/pages/manager/ManagerDashboard';
import { MyTeamPage } from '@/pages/manager/MyTeamPage';
import { ProjectAllocationPage } from '@/pages/manager/ProjectAllocationPage';
import { TimesheetApprovalsPage } from '@/pages/manager/TimesheetApprovalsPage';
import { OvertimeApprovalsPage } from '@/pages/manager/OvertimeApprovalsPage';
import { ManagerReportsPage } from '@/pages/manager/ManagerReportsPage';
import { TeamCalendarPage } from '@/pages/manager/TeamCalendarPage';

/** Only users whose role matches the section may enter; others are sent to their own workspace. */
function RoleGuard({ role }: { role: Role }) {
  const { user } = useSession();
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  if (!user) return null;
  if (user.systemRole !== role) return <Navigate to={homePath(user.systemRole)} replace />;
  return <AppLayout role={role} />;
}

/** Resolves the session before any business data is requested. */
function SessionGate() {
  const session = useSession();
  if (session.status === 'checking') return <LoadingScreen label="Checking your session…" />;
  if (session.status === 'error') return <ErrorScreen title="Unable to reach the server" message={session.error ?? undefined} onRetry={session.retry} />;
  if (session.status === 'anonymous' || !session.user) return <LoginPage />;
  return (
    <AppDataProvider>
      <Outlet />
    </AppDataProvider>
  );
}

function HomeRedirect() {
  const { user } = useSession();
  return user ? <Navigate to={homePath(user.systemRole)} replace /> : null;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<SessionGate />}>
        <Route path="/" element={<HomeRedirect />} />
        <Route path="/login" element={<HomeRedirect />} />

      <Route path="/admin" element={<RoleGuard role="admin" />}>
        <Route index element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<AdminDashboard />} />
        <Route path="employees" element={<EmployeesPage />} />
        <Route path="employees/:id" element={<EmployeeDetailPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="allocations" element={<AllocationsPage />} />
        <Route path="timesheets" element={<AdminTimesheetsPage />} />
        <Route path="approvals" element={<AdminApprovalsPage />} />
        <Route path="calendars" element={<CalendarsPage />} />
        <Route path="overtime-policies" element={<OvertimePoliciesPage />} />
        <Route path="reports" element={<AdminReportsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>

      <Route path="/associate" element={<RoleGuard role="associate" />}>
        <Route index element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<AssociateDashboard />} />
        <Route path="projects" element={<MyProjectsPage />} />
        <Route path="timesheet" element={<MyTimesheetPage />} />
        <Route path="calendar" element={<MyCalendarPage />} />
        <Route path="leave" element={<LeaveRequestsPage />} />
        <Route path="overtime" element={<MyOvertimePage />} />
        <Route path="submissions" element={<MySubmissionsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>

      <Route path="/manager" element={<RoleGuard role="manager" />}>
        <Route index element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<ManagerDashboard />} />
        <Route path="team" element={<MyTeamPage />} />
        <Route path="allocation" element={<ProjectAllocationPage />} />
        <Route path="approvals" element={<TimesheetApprovalsPage />} />
        <Route path="overtime" element={<OvertimeApprovalsPage />} />
        <Route path="reports" element={<ManagerReportsPage />} />
        <Route path="calendar" element={<TeamCalendarPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
