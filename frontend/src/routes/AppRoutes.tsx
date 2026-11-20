import { useEffect, useRef } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import type { Role } from '@/types';
import { useSession } from '@/context/SessionContext';
import { AppDataProvider, useAppData } from '@/context/AppDataContext';
import { useToast } from '@/context/ToastContext';
import { AppLayout } from '@/layouts/AppLayout';
import { homePath } from './navigation';
import { LoginPage } from '@/pages/LoginPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { ErrorScreen, LoadingScreen } from '@/components/common/StatusScreen';
import { EmbeddedAssistant } from '@/components/assistant/EmbeddedAssistant';

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

const MANAGER_REFRESH_PAGES = new Set(['/manager/dashboard', '/manager/team', '/manager/allocation']);

function ManagerLayout({ pathname, navigationKey }: { pathname: string; navigationKey: string }) {
  const { refresh } = useAppData();
  const toast = useToast();
  const page = pathname.replace(/\/$/, '').toLowerCase();
  // The workspace has already fetched these collections before rendering this layout.
  const previousLocation = useRef({ page, navigationKey });
  const initialRedirect = useRef(page === '/manager');
  const inFlight = useRef(false);

  useEffect(() => {
    const previous = previousLocation.current;
    const entered = previous.page !== page || previous.navigationKey !== navigationKey;
    previousLocation.current = { page, navigationKey };
    const redirectedFromInitialIndex = initialRedirect.current && previous.page === '/manager' && page === '/manager/dashboard';
    if (entered) initialRedirect.current = false;
    if (!MANAGER_REFRESH_PAGES.has(page)) return;

    const update = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        await refresh('projects', 'employees', 'allocations');
      } catch {
        toast.error('Could not refresh manager data', 'Showing the last loaded data.');
      } finally {
        inFlight.current = false;
      }
    };

    const isForeground = () => document.visibilityState === 'visible' && document.hasFocus();
    let wasForeground = isForeground();
    const onForegroundChange = () => {
      const foreground = isForeground();
      const returned = foreground && !wasForeground;
      wasForeground = foreground;
      if (returned) void update();
    };

    if (entered && !redirectedFromInitialIndex) void update();
    document.addEventListener('visibilitychange', onForegroundChange);
    window.addEventListener('focus', onForegroundChange);
    window.addEventListener('blur', onForegroundChange);
    return () => {
      document.removeEventListener('visibilitychange', onForegroundChange);
      window.removeEventListener('focus', onForegroundChange);
      window.removeEventListener('blur', onForegroundChange);
    };
  }, [page, navigationKey, refresh, toast]);

  return <AppLayout role="manager" />;
}

/** Only users whose role matches the section may enter; others are sent to their own workspace. */
function RoleGuard({ role }: { role: Role }) {
  const { user } = useSession();
  const { pathname, key } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  if (!user) return null;
  if (user.systemRole !== role) return <Navigate to={homePath(user.systemRole)} replace />;
  if (role === 'manager') return <ManagerLayout pathname={pathname} navigationKey={key} />;
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
      {/* Only the assistant, framed by the LMS. Outside SessionGate: it handles a missing session itself. */}
      <Route path="/assistant/embed" element={<EmbeddedAssistant />} />
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
