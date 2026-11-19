import {
  BarChart3,
  CalendarDays,
  CalendarRange,
  CheckSquare,
  ClipboardCheck,
  ClipboardList,
  Clock,
  FileClock,
  FolderKanban,
  LayoutDashboard,
  Network,
  Settings,
  ShieldCheck,
  Timer,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { Role } from '@/types';

export interface NavItem {
  label: string;
  path: string;
  icon: LucideIcon;
  /** Key used to attach a live count badge in the sidebar. */
  badgeKey?: 'approvals' | 'overtime' | 'returned' | 'leave';
}

export const NAVIGATION: Record<Role, NavItem[]> = {
  admin: [
    { label: 'Dashboard', path: '/admin/dashboard', icon: LayoutDashboard },
    { label: 'Employees', path: '/admin/employees', icon: Users },
    { label: 'Projects', path: '/admin/projects', icon: FolderKanban },
    { label: 'Resource Allocation', path: '/admin/allocations', icon: Network },
    { label: 'Timesheets', path: '/admin/timesheets', icon: ClipboardList },
    { label: 'Approvals', path: '/admin/approvals', icon: ClipboardCheck, badgeKey: 'approvals' },
    { label: 'Calendars', path: '/admin/calendars', icon: CalendarDays },
    { label: 'Overtime & Policies', path: '/admin/overtime-policies', icon: ShieldCheck },
    { label: 'Reports & Analytics', path: '/admin/reports', icon: BarChart3 },
    { label: 'Settings', path: '/admin/settings', icon: Settings },
  ],
  // My Projects, My Calendar, Leave Requests and Overtime are intentionally not listed here — their
  // routes, APIs and business logic are untouched (still reachable at /associate/projects etc.), only
  // the sidebar entry point was removed per the simplified Associate nav (Dashboard/My Timesheet/My
  // Submissions + My LMS, the last one rendered inline by Sidebar.tsx rather than from this array).
  associate: [
    { label: 'Dashboard', path: '/associate/dashboard', icon: LayoutDashboard },
    { label: 'My Timesheet', path: '/associate/timesheet', icon: Clock, badgeKey: 'returned' },
    { label: 'My Submissions', path: '/associate/submissions', icon: FileClock },
  ],
  manager: [
    { label: 'Dashboard', path: '/manager/dashboard', icon: LayoutDashboard },
    { label: 'My Team', path: '/manager/team', icon: Users },
    { label: 'Project Allocation', path: '/manager/allocation', icon: Network },
    { label: 'Timesheet Approvals', path: '/manager/approvals', icon: CheckSquare, badgeKey: 'approvals' },
    { label: 'Overtime Approvals', path: '/manager/overtime', icon: Timer, badgeKey: 'overtime' },
    { label: 'Reports', path: '/manager/reports', icon: BarChart3 },
    { label: 'Team Calendar', path: '/manager/calendar', icon: CalendarRange, badgeKey: 'leave' },
  ],
};


export const homePath = (role: Role) => NAVIGATION[role][0].path;
