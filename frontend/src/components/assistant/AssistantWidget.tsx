import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Award,
  BarChart3,
  Bell,
  Bot,
  BookOpen,
  CalendarCheck,
  CalendarRange,
  CalendarSearch,
  CheckSquare,
  ClipboardList,
  Clock,
  FileClock,
  GraduationCap,
  LibraryBig,
  MessageCircle,
  Minus,
  Network,
  PencilLine,
  Plane,
  RotateCcw,
  SendHorizontal,
  Timer,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { LeaveDuration, Role, TimesheetStatus } from '@/types';
import type { TeamAvailability } from '@/types/api';
import { IS_MOCK_MODE, leaveService } from '@/services';
import { useAppData } from '@/context/AppDataContext';
import { useCurrentUser, useLookups } from '@/hooks/useLookups';
import { useNotifications } from '@/hooks/useNotifications';
import { useLmsLauncher, type LmsPage } from '@/hooks/useLmsLauncher';
import { currentWeekStart, formatWeekRange, todayISO } from '@/utils/date';
import { deriveTimesheetStatus, findHoliday, isWorkingDay, timesheetTotal } from '@/utils/timesheet';
import { cn } from '@/utils/format';
import { takeSignInGreeting } from './greeting';
import { addMonths, dayLabel, monthLabel, monthOf, parseDates, parseMonth, suggestLeaveDays, type ISODate } from './leavePlanner';

/**
 * A guided assistant that pops up right after sign-in and asks where the user wants to go. It offers buttons for
 * the timesheet and the LMS (role-aware, with live counts from the app's data) and understands simple typed
 * keywords. It can also plan leave: it suggests days when no teammate is off and sends the leave request itself.
 * No AI service is involved.
 */

type NodeId = 'welcome' | 'menu' | 'timesheet' | 'lms' | 'attention' | 'leave' | 'plan' | 'overtime' | 'thanks' | 'fallback';

/** Steps of the leave planner. */
type LeaveStep =
  | { to: 'month'; month: string }
  | { to: 'pick'; dates: ISODate[] }
  | { to: 'custom' }
  | { to: 'duration'; duration: LeaveDuration }
  | { to: 'reason'; reason: string }
  | { to: 'send' }
  | { to: 'cancel' };

type Action = { kind: 'node'; node: NodeId } | { kind: 'nav'; to: string } | { kind: 'lms'; page?: LmsPage } | { kind: 'leave'; step: LeaveStep };

/** Where the leave planner is waiting for the user's answer (typed or tapped). */
interface PlanState {
  stage: 'idle' | 'month' | 'dates' | 'duration' | 'reason' | 'confirm';
  month?: string;
  dates?: ISODate[];
  duration?: LeaveDuration;
  reason?: string;
}

const MAX_LEAVE_DAYS = 10;
const REASONS = ['Personal work', 'Family function', 'Medical appointment', 'Vacation'];
const durationLabel = (d: LeaveDuration) => (d === 'half' ? 'Half day' : 'Full day');

interface Option {
  id: string;
  label: string;
  icon?: LucideIcon;
  /** Shown as a small badge, e.g. pending approvals. */
  count?: number;
  /** One-line description, shown on the large cards of the full-screen welcome. */
  hint?: string;
  action: Action;
}

interface Message {
  id: number;
  from: 'bot' | 'user';
  text: string;
  options?: Option[];
}

interface Reply {
  text: string;
  options: Option[];
}

const TYPING_MS = 450;

const STATUS_TEXT: Record<TimesheetStatus, string> = {
  not_started: 'not started yet',
  draft: 'saved as a draft, not submitted yet',
  submitted: 'submitted and waiting for approval',
  partially_approved: 'partly approved',
  approved: 'fully approved',
  returned: 'returned to you for changes',
  rejected: 'has rejected entries',
};

const BACK: Option = { id: 'back', label: 'Main menu', icon: ArrowLeft, action: { kind: 'node', node: 'menu' } };

const greetingForHour = (hour: number) => (hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening');

const formatHoursShort = (hours: number) => `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;

/** Maps typed text to a conversation step. Deliberately simple keyword matching. */
function intentFor(text: string): NodeId {
  const t = text.toLowerCase();
  if (
    /\b(leaves?|vacation|holidays?|time ?off|days? off|break)\b/.test(t) &&
    /\b(suggest\w*|plan\w*|recommend\w*|best|free|clash\w*|when|which|good|ideas?|options?|available|availability)\b/.test(t)
  )
    return 'plan';
  if (/\b(thanks?|thank you|thx|great|cool)\b/.test(t)) return 'thanks';
  if (/\b(hi|hello|hey|menu|start|help|options?)\b/.test(t)) return 'menu';
  if (/\b(leave|vacation|holiday|time ?off|sick)\b/.test(t)) return 'leave';
  if (/\b(overtime|ot|extra hours?)\b/.test(t)) return 'overtime';
  if (/\b(approv\w*|pending|review|attention|to ?do|notifications?|alerts?)\b/.test(t)) return 'attention';
  if (/\b(lms|learn\w*|courses?|training|certificates?|class(es)?|lessons?)\b/.test(t)) return 'lms';
  if (/\b(timesheets?|hours?|week|log|submit\w*|projects?)\b/.test(t)) return 'timesheet';
  return 'fallback';
}

export function AssistantWidget({ role }: { role: Role }) {
  const navigate = useNavigate();
  const user = useCurrentUser();
  const { timesheets, leaves, calendars, applyLeave } = useAppData();
  const { employeeName } = useLookups();
  const { counts, items } = useNotifications();
  const lms = useLmsLauncher();

  const [open, setOpen] = useState(false);
  /** Full-screen welcome shown right after sign-in; otherwise the assistant is a small panel in the corner. */
  const [focus, setFocus] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');

  const nextId = useRef(1);
  const timers = useRef<number[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const plan = useRef<PlanState>({ stage: 'idle' });
  const availabilityCache = useRef(new Map<string, TeamAvailability>());
  /** Bumped by "start over", so a reply still loading from the server is dropped. */
  const epoch = useRef(0);

  const firstName = user.name.split(' ')[0] || user.name;
  const attentionCount = items.length;

  /** Builds a step of the conversation from the latest data. */
  const build = (node: NodeId): Reply => {
    const mainOptions: Option[] = [
      { id: 'go-ts', label: 'Timesheet', icon: Clock, hint: role === 'associate' ? 'Log hours, leave and overtime' : 'Approvals, allocations and reports', action: { kind: 'node', node: 'timesheet' } },
      ...(IS_MOCK_MODE ? [] : [{ id: 'go-lms', label: 'LMS', icon: GraduationCap, hint: 'Courses, training and certificates', action: { kind: 'node', node: 'lms' } } satisfies Option]),
      { id: 'go-plan', label: 'Plan a leave', icon: CalendarSearch, hint: 'Clash-free dates, sent for you', action: { kind: 'node', node: 'plan' } },
      { id: 'go-att', label: 'What needs my attention?', icon: Bell, hint: attentionCount ? 'Pending items and reminders' : "You're all caught up", count: attentionCount || undefined, action: { kind: 'node', node: 'attention' } },
    ];

    switch (node) {
      case 'welcome':
        return {
          text: `${greetingForHour(new Date().getHours())}, ${firstName}! 👋\nWhere do you want to go today?`,
          options: mainOptions,
        };
      case 'menu':
        return { text: 'Sure. Where would you like to go?', options: mainOptions };
      case 'thanks':
        return { text: "You're welcome! Anything else I can help with?", options: mainOptions };
      case 'fallback':
        return {
          text: 'I\'m a guided assistant, so I understand simple requests like "timesheet", "leave", "approvals" or "courses". Or pick one of these:',
          options: mainOptions,
        };
      case 'timesheet':
        return timesheetStep();
      case 'lms':
        return lmsStep();
      case 'attention':
        return attentionStep();
      case 'leave':
        return leaveStep();
      case 'plan': {
        const now = monthOf(todayISO());
        return {
          text: 'Let\'s find days when your teammates are in, so your leave doesn\'t clash with theirs. Which month are you planning for? You can also type one, like "December".',
          options: [
            { id: 'pm-0', label: `This month (${monthLabel(now).split(' ')[0]})`, icon: CalendarSearch, action: { kind: 'leave', step: { to: 'month', month: now } } },
            { id: 'pm-1', label: monthLabel(addMonths(now, 1)), icon: CalendarSearch, action: { kind: 'leave', step: { to: 'month', month: addMonths(now, 1) } } },
            { id: 'pm-2', label: monthLabel(addMonths(now, 2)), icon: CalendarSearch, action: { kind: 'leave', step: { to: 'month', month: addMonths(now, 2) } } },
            BACK,
          ],
        };
      }
      case 'overtime':
        return overtimeStep();
    }
  };

  function timesheetStep(): Reply {
    if (role === 'associate') {
      const week = currentWeekStart();
      const current = timesheets.find((t) => t.employeeId === user.id && t.weekStart === week);
      const status = deriveTimesheetStatus(current);
      const hours = timesheetTotal(current);
      const projects = current?.entries.length ?? 0;
      const summary =
        status === 'not_started'
          ? `You haven't logged any hours for the week of ${formatWeekRange(week)} yet.`
          : `Week of ${formatWeekRange(week)}: ${formatHoursShort(hours)} across ${projects} project${projects === 1 ? '' : 's'}, ${STATUS_TEXT[status]}.`;
      const returned = items.find((i) => i.id.startsWith('n-ret-'));
      return {
        text: `${summary}\nWhat would you like to do?`,
        options: [
          returned
            ? { id: 'ts-fix', label: 'Fix returned hours', icon: RotateCcw, count: counts.returned, action: { kind: 'nav', to: returned.to } }
            : { id: 'ts-subs', label: 'Track my submissions', icon: FileClock, action: { kind: 'nav', to: '/associate/submissions' } },
          { id: 'ts-leave', label: 'Request leave', icon: Plane, action: { kind: 'nav', to: '/associate/leave' } },
          { id: 'ts-ot', label: 'Request overtime', icon: Timer, action: { kind: 'nav', to: '/associate/overtime' } },
          { id: 'ts-go', label: 'Go to my timesheet', icon: Clock, action: { kind: 'nav', to: '/associate/timesheet' } },
          BACK,
        ],
      };
    }
    if (role === 'manager') {
      return {
        text:
          counts.approvals || counts.overtime
            ? `You have ${counts.approvals} timesheet ${counts.approvals === 1 ? 'entry' : 'entries'} and ${counts.overtime} overtime request${counts.overtime === 1 ? '' : 's'} waiting for you.`
            : 'Nothing is waiting for your approval right now. 👍',
        options: [
          { id: 'ts-ot', label: 'Overtime requests', icon: Timer, count: counts.overtime || undefined, action: { kind: 'nav', to: '/manager/overtime' } },
          { id: 'ts-cal', label: 'Team calendar', icon: CalendarRange, count: counts.leave || undefined, action: { kind: 'nav', to: '/manager/calendar' } },
          { id: 'ts-alloc', label: 'Project allocation', icon: Network, action: { kind: 'nav', to: '/manager/allocation' } },
          { id: 'ts-go', label: 'Go to timesheet approvals', icon: CheckSquare, count: counts.approvals || undefined, action: { kind: 'nav', to: '/manager/approvals' } },
          BACK,
        ],
      };
    }
    return {
      text: counts.approvals
        ? `${counts.approvals} timesheet ${counts.approvals === 1 ? 'entry is' : 'entries are'} awaiting approval across all projects.`
        : 'All submitted timesheets are up to date. 👍',
      options: [
        { id: 'ts-appr', label: 'Approvals queue', icon: CheckSquare, count: counts.approvals || undefined, action: { kind: 'nav', to: '/admin/approvals' } },
        { id: 'ts-alloc', label: 'Resource allocation', icon: Network, action: { kind: 'nav', to: '/admin/allocations' } },
        { id: 'ts-rep', label: 'Reports & analytics', icon: BarChart3, action: { kind: 'nav', to: '/admin/reports' } },
        { id: 'ts-go', label: 'Go to timesheets', icon: ClipboardList, action: { kind: 'nav', to: '/admin/timesheets' } },
        BACK,
      ],
    };
  }

  function lmsStep(): Reply {
    if (IS_MOCK_MODE) return { text: "The LMS isn't available in mock mode. Connect the real API to use it.", options: [BACK] };
    return {
      text: "The LMS opens in a new tab and you're signed in automatically. Where would you like to start?",
      options: [
        { id: 'lms-courses', label: 'Continue my learning', icon: BookOpen, action: { kind: 'lms', page: 'courses' } },
        { id: 'lms-catalog', label: 'Browse courses', icon: LibraryBig, action: { kind: 'lms', page: 'catalog' } },
        { id: 'lms-certs', label: 'My certificates', icon: Award, action: { kind: 'lms', page: 'certificates' } },
        { id: 'lms-go', label: 'Go to My LMS', icon: GraduationCap, action: { kind: 'lms' } },
        BACK,
      ],
    };
  }

  function attentionStep(): Reply {
    if (items.length === 0) return { text: "You're all caught up. Nothing is waiting on you right now. 🎉", options: [BACK] };
    return {
      text: `Here ${items.length === 1 ? 'is 1 thing' : `are ${items.length} things`} that need${items.length === 1 ? 's' : ''} your attention:`,
      options: [...items.slice(0, 5).map((i) => ({ id: `att-${i.id}`, label: i.title, icon: Bell, action: { kind: 'nav', to: i.to } }) satisfies Option), BACK],
    };
  }

  function leaveStep(): Reply {
    const planIt: Option = { id: 'lv-plan', label: 'Suggest clash-free dates', icon: CalendarSearch, action: { kind: 'node', node: 'plan' } };
    if (role === 'associate')
      return {
        text: 'I can suggest days when none of your teammates are off and send the leave request for you. Or you can use the Leave Requests page.',
        options: [planIt, { id: 'lv', label: 'Leave Requests page', icon: Plane, action: { kind: 'nav', to: '/associate/leave' } }, BACK],
      };
    if (role === 'manager')
      return { text: "I can plan your own leave around your team's, or you can see their requests on the team calendar.", options: [planIt, { id: 'lv', label: 'Team calendar', icon: CalendarRange, count: counts.leave || undefined, action: { kind: 'nav', to: '/manager/calendar' } }, BACK] };
    return { text: "I can plan your own leave around your team's. Holidays and work calendars are managed under Calendars.", options: [planIt, { id: 'lv', label: 'Calendars', icon: CalendarRange, action: { kind: 'nav', to: '/admin/calendars' } }, BACK] };
  }

  function overtimeStep(): Reply {
    if (role === 'associate')
      return { text: 'You can request overtime for extra hours on a project.', options: [{ id: 'ot', label: 'Request overtime', icon: Timer, action: { kind: 'nav', to: '/associate/overtime' } }, BACK] };
    if (role === 'manager')
      return { text: `${counts.overtime || 'No'} overtime request${counts.overtime === 1 ? ' is' : 's are'} waiting for you.`, options: [{ id: 'ot', label: 'Overtime approvals', icon: Timer, count: counts.overtime || undefined, action: { kind: 'nav', to: '/manager/overtime' } }, BACK] };
    return { text: 'Overtime eligibility and policies are set under Overtime & Policies.', options: [{ id: 'ot', label: 'Overtime & policies', icon: Timer, action: { kind: 'nav', to: '/admin/overtime-policies' } }, BACK] };
  }

  // Timers read the newest data through this ref, not the values captured when they were scheduled.
  const buildRef = useRef(build);
  buildRef.current = build;

  const push = useCallback((from: Message['from'], text: string, options?: Option[]) => {
    setMessages((list) => [...list, { id: nextId.current++, from, text, options }]);
  }, []);

  const later = useCallback((fn: () => void, ms = TYPING_MS) => {
    setTyping(true);
    const id = window.setTimeout(() => {
      setTyping(false);
      fn();
    }, ms);
    timers.current.push(id);
  }, []);

  const botSays = useCallback(
    (node: NodeId) =>
      later(() => {
        const reply = buildRef.current(node);
        push('bot', reply.text, reply.options);
      }),
    [later, push],
  );

  /** Shows the typing dots while `load` runs (at least TYPING_MS), then posts its reply. */
  const botSaysAsync = useCallback(
    (load: () => Promise<Reply>) => {
      const started = Date.now();
      const mine = epoch.current;
      setTyping(true);
      load()
        .catch((err: unknown): Reply => ({
          text: `Sorry, something went wrong: ${err instanceof Error ? err.message : 'please try again.'}`,
          options: [BACK],
        }))
        .then((reply) => {
          const id = window.setTimeout(() => {
            if (epoch.current !== mine) return;
            setTyping(false);
            push('bot', reply.text, reply.options);
          }, Math.max(0, TYPING_MS - (Date.now() - started)));
          timers.current.push(id);
        });
    },
    [push],
  );

  // ------------------------------------------------------------------ leave planner

  const today = todayISO();
  const myCalendar = calendars.find((c) => c.id === user.calendarId);
  const workingDay = (date: ISODate) => isWorkingDay(myCalendar, date);
  const myLeaveDays = new Set(leaves.filter((l) => l.employeeId === user.id && l.status !== 'rejected').map((l) => l.date));
  const approver = user.managerId ? employeeName(user.managerId) : null;

  const resetPlan = () => {
    plan.current = { stage: 'idle' };
  };

  const availability = async (month: string): Promise<TeamAvailability> => {
    const cached = availabilityCache.current.get(month);
    if (cached) return cached;
    const fresh = await leaveService.teamAvailability(month);
    availabilityCache.current.set(month, fresh);
    // Teammates keep booking leave, so a month is re-read after a minute.
    window.setTimeout(() => availabilityCache.current.delete(month), 60_000);
    return fresh;
  };

  const whoIsOff = (av: TeamAvailability, date: ISODate) => av.days.find((d) => d.date === date)?.people ?? [];

  const describePeople = (people: TeamAvailability['days'][number]['people']) =>
    people.map((p) => `${p.name}${p.duration === 'half' ? ' (half day)' : ''}${p.status === 'pending' ? ' (requested)' : ''}`).join(', ');

  const monthChoices = (month: string): Option[] => [
    { id: 'pl-custom', label: 'Pick my own dates', icon: PencilLine, action: { kind: 'leave', step: { to: 'custom' } } },
    { id: 'pl-next', label: `Try ${monthLabel(addMonths(month, 1))}`, icon: CalendarSearch, action: { kind: 'leave', step: { to: 'month', month: addMonths(month, 1) } } },
    BACK,
  ];

  /** Looks up the month and suggests clash-free days. */
  const planMonth = (month: string) => {
    plan.current = { stage: 'dates', month };
    botSaysAsync(async () => {
      const av = await availability(month);
      const name = monthLabel(month);
      const teamBusy = new Set(av.days.map((d) => d.date));
      const suggestions = suggestLeaveDays({
        month,
        today,
        isWorkingDay: workingDay,
        holidayName: (d) => findHoliday(myCalendar, d)?.name,
        teamBusy,
        mine: myLeaveDays,
      });

      const lines: string[] = [`📅 ${name}`];
      if (av.teamSize === 0) lines.push("I couldn't find any teammates for you that month, so every working day is clash-free.");
      else if (av.days.length === 0) lines.push(`None of your ${av.teamSize} teammates has leave booked. 🎉`);
      else {
        lines.push(`Your teammates are off on:`);
        for (const d of av.days.slice(0, 5)) lines.push(`• ${dayLabel(d.date, today)}: ${describePeople(d.people)}`);
        if (av.days.length > 5) lines.push(`• …and ${av.days.length - 5} more day${av.days.length - 5 === 1 ? '' : 's'}`);
      }
      const mineThisMonth = [...myLeaveDays].filter((d) => monthOf(d) === month).sort();
      if (mineThisMonth.length) lines.push(`You already have leave on ${mineThisMonth.map((d) => dayLabel(d, today)).join(', ')}.`);
      if (!suggestions.length) {
        lines.push(`\nThere are no clash-free working days left in ${name}. You can still pick your own dates, or look at another month.`);
        return { text: lines.join('\n'), options: monthChoices(month) };
      }
      lines.push(`\nThese days are free for the whole team${suggestions.some((x) => x.longWeekend) ? ' (🌴 = long weekend)' : ''}. Tap one to request it, or pick your own:`);
      return {
        text: lines.join('\n'),
        options: [
          ...suggestions.map(
            (x): Option => ({
              id: `sg-${x.date}`,
              label: `${dayLabel(x.date, today)}${x.longWeekend ? ' 🌴' : ''}${x.note && x.note !== 'long weekend' ? ` · ${x.note}` : ''}`,
              icon: CalendarCheck,
              action: { kind: 'leave', step: { to: 'pick', dates: [x.date] } },
            }),
          ),
          ...monthChoices(month),
        ],
      };
    });
  };

  const startPlan = (month: string | null) => {
    if (month) return planMonth(month);
    plan.current = { stage: 'month' };
    botSays('plan');
  };

  const askDuration = (): Option[] => [
    { id: 'du-full', label: 'Full day', icon: CalendarCheck, action: { kind: 'leave', step: { to: 'duration', duration: 'full' } } },
    { id: 'du-half', label: 'Half day', icon: CalendarCheck, action: { kind: 'leave', step: { to: 'duration', duration: 'half' } } },
    { id: 'pl-custom', label: 'Change dates', icon: PencilLine, action: { kind: 'leave', step: { to: 'custom' } } },
    { id: 'pl-cancel', label: 'Cancel', icon: X, action: { kind: 'leave', step: { to: 'cancel' } } },
  ];

  /** Checks chosen dates (working day, not past, not already on leave), warns about clashes, then asks full or half day. */
  const chooseDates = (dates: ISODate[], fromRange: Set<ISODate> = new Set()) => {
    botSaysAsync(async () => {
      const issues: string[] = [];
      const valid: ISODate[] = [];
      for (const date of dates) {
        if (date < today) issues.push(`${dayLabel(date, today)} has already passed.`);
        else if (!workingDay(date)) {
          if (!fromRange.has(date)) {
            const holiday = findHoliday(myCalendar, date);
            issues.push(`${dayLabel(date, today)} is ${holiday ? `a holiday (${holiday.name})` : 'not a working day'}, so no leave is needed.`);
          }
        } else if (myLeaveDays.has(date)) issues.push(`You already have leave on ${dayLabel(date, today)}.`);
        else valid.push(date);
      }
      if (valid.length > MAX_LEAVE_DAYS) {
        issues.push(`I can send up to ${MAX_LEAVE_DAYS} days at a time, so I kept the first ${MAX_LEAVE_DAYS}.`);
        valid.splice(MAX_LEAVE_DAYS);
      }
      if (!valid.length) {
        plan.current = { stage: 'dates', month: plan.current.month ?? monthOf(today) };
        return {
          text: `${issues.join('\n')}\nNone of those dates can be requested. Type other dates, or pick from the options.`,
          options: monthChoices(plan.current.month!),
        };
      }

      const months = [...new Set(valid.map(monthOf))];
      const avs = await Promise.all(months.map(availability));
      const clashes = valid.flatMap((date) => {
        const people = whoIsOff(avs[months.indexOf(monthOf(date))], date);
        return people.length ? [`⚠️ ${describePeople(people)} ${people.length === 1 ? 'is' : 'are'} also off on ${dayLabel(date, today)}.`] : [];
      });

      plan.current = { stage: 'duration', month: plan.current.month ?? months[0], dates: valid };
      return {
        text: [
          ...issues,
          `You picked ${valid.map((d) => dayLabel(d, today)).join(', ')}.`,
          ...clashes,
          clashes.length ? 'You can still go ahead, or change your dates.' : '',
          valid.length > 1 ? 'Full day or half day for each of these?' : 'Full day or half day?',
        ]
          .filter(Boolean)
          .join('\n'),
        options: askDuration(),
      };
    });
  };

  const confirmText = (state: PlanState) =>
    [
      'Here is your leave request:',
      ...(state.dates ?? []).map((d) => `• ${dayLabel(d, today)}, ${durationLabel(state.duration ?? 'full').toLowerCase()}`),
      `Reason: ${state.reason}`,
      approver ? `It will go to ${approver} for approval. Send it?` : 'It will go for approval. Send it?',
    ].join('\n');

  const sendLeave = () => {
    const { dates = [], duration = 'full', reason = '' } = plan.current;
    resetPlan();
    botSaysAsync(async () => {
      const sent: ISODate[] = [];
      const failed: string[] = [];
      for (const date of dates) {
        try {
          await applyLeave({ date, duration, reason });
          sent.push(date);
        } catch (err) {
          failed.push(`❌ ${dayLabel(date, today)}: ${err instanceof Error ? err.message : 'could not be sent.'}`);
        }
      }
      const lines: string[] = [];
      if (sent.length)
        lines.push(
          `✅ Done! I sent ${sent.length === 1 ? 'your leave request' : `${sent.length} leave requests`}${approver ? ` to ${approver}` : ''} for approval:`,
          ...sent.map((d) => `• ${dayLabel(d, today)}, ${durationLabel(duration).toLowerCase()}`),
        );
      lines.push(...failed);
      if (sent.length) lines.push("You'll see the status on your Leave Requests page.");
      return {
        text: lines.join('\n'),
        options: [
          ...(role === 'associate' ? [{ id: 'lv-view', label: 'View my leave requests', icon: Plane, action: { kind: 'nav', to: '/associate/leave' } } satisfies Option] : []),
          { id: 'lv-more', label: 'Plan more leave', icon: CalendarSearch, action: { kind: 'node', node: 'plan' } },
          BACK,
        ],
      };
    });
  };

  /** Handles a tapped leave-planner option. */
  const leaveAction = (step: LeaveStep) => {
    switch (step.to) {
      case 'month':
        return planMonth(step.month);
      case 'pick':
        return chooseDates(step.dates);
      case 'custom': {
        const month = plan.current.month ?? monthOf(today);
        plan.current = { stage: 'dates', month };
        return later(() =>
          push(
            'bot',
            `Type the dates you'd like, for example "${dayLabel(`${month}-15`).split(' ').slice(1).join(' ')}", "15-17 ${monthLabel(month).split(' ')[0].slice(0, 3)}" or "5, 8 and 12".`,
            [{ id: 'pl-cancel', label: 'Cancel', icon: X, action: { kind: 'leave', step: { to: 'cancel' } } }],
          ),
        );
      }
      case 'duration':
        plan.current = { ...plan.current, stage: 'reason', duration: step.duration };
        return later(() =>
          push('bot', `${durationLabel(step.duration)}, got it. What's the reason? Pick one or type your own.`, [
            ...REASONS.map((r): Option => ({ id: `rs-${r}`, label: r, action: { kind: 'leave', step: { to: 'reason', reason: r } } })),
            { id: 'pl-cancel', label: 'Cancel', icon: X, action: { kind: 'leave', step: { to: 'cancel' } } },
          ]),
        );
      case 'reason':
        plan.current = { ...plan.current, stage: 'confirm', reason: step.reason };
        return later(() =>
          push('bot', confirmText(plan.current), [
            { id: 'pl-send', label: 'Send request', icon: SendHorizontal, action: { kind: 'leave', step: { to: 'send' } } },
            { id: 'pl-custom', label: 'Change dates', icon: PencilLine, action: { kind: 'leave', step: { to: 'custom' } } },
            { id: 'pl-cancel', label: 'Cancel', icon: X, action: { kind: 'leave', step: { to: 'cancel' } } },
          ]),
        );
      case 'send':
        return sendLeave();
      case 'cancel':
        resetPlan();
        return later(() => push('bot', 'No problem, nothing was sent. Anything else?', buildRef.current('menu').options));
    }
  };

  /** Typed text while the planner is waiting for an answer. Returns false when the text is not an answer. */
  const answerPlanner = (text: string): boolean => {
    const state = plan.current;
    const t = text.toLowerCase();
    switch (state.stage) {
      case 'month': {
        const month = parseMonth(text, today);
        if (month) planMonth(month);
        else later(() => push('bot', 'I didn\'t catch the month. Try "December" or "next month".', buildRef.current('plan').options));
        return true;
      }
      case 'dates': {
        const parsed = parseDates(text, state.month ?? monthOf(today), today);
        if (parsed.dates.length) {
          chooseDates(parsed.dates, parsed.fromRange);
          return true;
        }
        const month = parseMonth(text, today);
        if (month) {
          planMonth(month);
          return true;
        }
        later(() =>
          push('bot', 'I couldn\'t find any dates in that. Try something like "12 Dec", "15-17 Dec" or "5, 8 and 12".', monthChoices(state.month ?? monthOf(today))),
        );
        return true;
      }
      case 'duration':
        if (/\bhalf\b/.test(t)) leaveAction({ to: 'duration', duration: 'half' });
        else if (/\bfull\b|\bwhole\b/.test(t)) leaveAction({ to: 'duration', duration: 'full' });
        else later(() => push('bot', 'Full day or half day?', askDuration()));
        return true;
      case 'reason':
        if (text.length > 1000) later(() => push('bot', 'Please keep the reason under 1000 characters.'));
        else leaveAction({ to: 'reason', reason: text });
        return true;
      case 'confirm':
        if (/\b(yes|yep|yeah|send|ok|okay|sure|confirm|go ahead)\b/.test(t)) leaveAction({ to: 'send' });
        else if (/\b(no|nope|cancel|stop|don'?t)\b/.test(t)) leaveAction({ to: 'cancel' });
        else
          later(() =>
            push('bot', 'Shall I send it?', [
              { id: 'pl-send', label: 'Send request', icon: SendHorizontal, action: { kind: 'leave', step: { to: 'send' } } },
              { id: 'pl-cancel', label: 'Cancel', icon: X, action: { kind: 'leave', step: { to: 'cancel' } } },
            ]),
          );
        return true;
      default:
        return false;
    }
  };

  useEffect(() => () => timers.current.forEach((id) => window.clearTimeout(id)), []);

  // Pop up once, right after sign-in.
  useEffect(() => {
    if (takeSignInGreeting()) {
      setOpen(true);
      setFocus(true);
    }
  }, []);

  // The page behind the full-screen welcome does not scroll.
  useEffect(() => {
    if (!(open && focus)) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open, focus]);

  // The first time the panel opens, greet the user.
  useEffect(() => {
    if (open && messages.length === 0 && !typing) botSays('welcome');
  }, [open, messages.length, typing, botSays]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [messages, typing]);

  useEffect(() => {
    // Not on touch screens, where focusing the box would pop up the keyboard over the menu.
    if (open && window.matchMedia('(pointer: fine)').matches) input.current?.focus({ preventScroll: true });
  }, [open]);

  const close = () => {
    setOpen(false);
    setFocus(false);
    launcher.current?.focus();
  };

  const choose = (option: Option) => {
    if (typing) return;
    const { action } = option;
    if (action.kind === 'lms') {
      // Opened straight from the click, so the browser does not block the new tab.
      void lms.open(action.page).then((ok) => {
        push('bot', ok ? `Opened ${option.label === 'Go to My LMS' ? 'My LMS' : `"${option.label}"`} in a new tab. Anything else?` : "I couldn't open the LMS just now. Please try again in a moment.", buildRef.current('menu').options);
      });
      push('user', option.label);
      return;
    }
    push('user', option.label);
    if (action.kind === 'leave') {
      leaveAction(action.step);
      return;
    }
    resetPlan();
    if (action.kind === 'node') {
      if (action.node === 'plan') startPlan(null);
      else botSays(action.node);
      return;
    }
    later(() => {
      push('bot', `Taking you to ${option.label.replace(/^Go to /, '')}…`);
      navigate(action.to);
      // Step out of the way of the page, leaving the menu ready for next time.
      const id = window.setTimeout(() => {
        setOpen(false);
        setFocus(false);
        push('bot', 'Anything else I can help with?', buildRef.current('menu').options);
      }, 700);
      timers.current.push(id);
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || typing) return;
    setDraft('');
    push('user', text);
    if (/^(menu|main menu|cancel|stop|start over|exit|quit)$/i.test(text)) {
      const wasPlanning = plan.current.stage !== 'idle';
      resetPlan();
      if (wasPlanning) later(() => push('bot', 'Okay, I stopped planning that leave. Nothing was sent.', buildRef.current('menu').options));
      else botSays('menu');
      return;
    }
    if (answerPlanner(text)) return;
    const intent = intentFor(text);
    if (intent === 'plan') startPlan(parseMonth(text, todayISO()));
    else botSays(intent);
  };

  const restart = () => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
    epoch.current += 1;
    resetPlan();
    setTyping(false);
    setMessages([]);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close();
  };

  const lastBot = [...messages].reverse().find((m) => m.from === 'bot');

  const renderOptions = (m: Message) => {
    if (m !== lastBot || !m.options?.length || typing) return null;

    // Full-screen welcome: the main choices are large cards.
    if (focus && m.options.some((o) => o.hint)) {
      return (
        <div className={cn('mt-4 grid gap-3', m.options.length === 4 ? 'sm:grid-cols-2' : 'sm:grid-cols-3')}>
          {m.options.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => choose(o)}
              disabled={o.action.kind === 'lms' && lms.busy}
              className="group relative flex flex-col items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left shadow-card transition-all hover:-translate-y-0.5 hover:border-brand-500 hover:shadow-pop focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-100 disabled:opacity-60"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-brand-50 text-brand-600 transition-colors group-hover:bg-brand-600 group-hover:text-white">
                {o.icon && <o.icon className="h-5 w-5" />}
              </span>
              <span>
                <span className="block text-sm font-semibold text-slate-800">{o.label}</span>
                {o.hint && <span className="mt-0.5 block text-xs text-slate-500">{o.hint}</span>}
              </span>
              {o.count ? (
                <span className="absolute right-3 top-3 rounded-full bg-red-500 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-white">{o.count}</span>
              ) : null}
            </button>
          ))}
        </div>
      );
    }

    return (
      <div className="mt-2 flex flex-wrap gap-2">
        {m.options.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => choose(o)}
            disabled={o.action.kind === 'lms' && lms.busy}
            className={cn(
              'inline-flex max-w-full items-center gap-1.5 rounded-full border text-left font-medium transition-colors disabled:opacity-60',
              focus ? 'px-4 py-2 text-sm' : 'px-3 py-1.5 text-xs',
              o.id === 'back'
                ? 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100'
                : 'border-brand-200 bg-white text-brand-700 hover:border-brand-500 hover:bg-brand-50',
            )}
          >
            {o.icon && <o.icon className={cn('shrink-0', focus ? 'h-4 w-4' : 'h-3.5 w-3.5')} />}
            <span className="truncate">{o.label}</span>
            {o.count ? <span className="rounded-full bg-brand-600 px-1.5 text-[10px] font-semibold tabular-nums text-white">{o.count}</span> : null}
          </button>
        ))}
      </div>
    );
  };

  const panel = (
    <section
      role="dialog"
      aria-modal={focus || undefined}
      aria-label="TimeTrack assistant"
      onKeyDown={onKeyDown}
      onMouseDown={(e) => e.stopPropagation()}
      className={cn(
        'chat-pop flex flex-col overflow-hidden bg-white ring-1 ring-slate-200',
        focus
          ? 'h-full w-full sm:h-[min(680px,calc(100vh-4rem))] sm:w-[min(760px,calc(100vw-4rem))] sm:rounded-2xl sm:shadow-2xl'
          : 'fixed bottom-24 right-4 z-40 h-[min(560px,calc(100vh-8rem))] w-[380px] max-w-[calc(100vw-2rem)] rounded-2xl shadow-pop sm:right-6',
      )}
    >
      <header className="flex items-center gap-3 bg-sidebar px-4 py-3 text-white">
        <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-600">
          <Bot className="h-5 w-5" />
          <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-sidebar bg-emerald-400" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-sm font-semibold">TimeTrack Assistant</p>
          <p className="truncate text-[11px] text-sidebar-muted">Here to help you get around</p>
        </div>
        <button type="button" onClick={restart} className="rounded-md p-1.5 text-sidebar-muted hover:bg-sidebar-hover hover:text-white" aria-label="Start over" title="Start over">
          <RotateCcw className="h-4 w-4" />
        </button>
        {focus ? (
          <button type="button" onClick={close} className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-sidebar-muted hover:bg-sidebar-hover hover:text-white">
            Skip to dashboard <X className="h-4 w-4" />
          </button>
        ) : (
          <button type="button" onClick={close} className="rounded-md p-1.5 text-sidebar-muted hover:bg-sidebar-hover hover:text-white" aria-label="Minimise assistant" title="Minimise">
            <Minus className="h-4 w-4" />
          </button>
        )}
      </header>

      <div ref={scroller} role="log" aria-live="polite" className={cn('flex-1 overflow-y-auto bg-slate-50', focus ? 'space-y-4 px-5 py-6 sm:px-8' : 'space-y-3 px-4 py-4')}>
        {focus && (
          <div className="flex flex-col items-center pb-2 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-600 text-white shadow-pop">
              <Bot className="h-8 w-8" />
            </span>
            <h2 className="mt-4 text-xl font-semibold text-slate-900 sm:text-2xl">Welcome back, {firstName}</h2>
            <p className="mt-1 text-sm text-slate-500">Tell me where you&apos;d like to start, and I&apos;ll take you there.</p>
          </div>
        )}
        {messages.map((m) =>
          m.from === 'user' ? (
            <div key={m.id} className="flex justify-end">
              <p className={cn('toast-in max-w-[80%] rounded-2xl rounded-tr-sm bg-brand-600 text-white', focus ? 'px-4 py-2.5 text-[15px]' : 'px-3.5 py-2 text-sm')}>{m.text}</p>
            </div>
          ) : (
            <div key={m.id} className="toast-in flex gap-2">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-700">
                <Bot className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    'w-fit max-w-full whitespace-pre-line rounded-2xl rounded-tl-sm bg-white text-slate-700 ring-1 ring-slate-200',
                    focus ? 'px-4 py-3 text-[15px]' : 'px-3.5 py-2.5 text-sm',
                  )}
                >
                  {m.text}
                </p>
                {renderOptions(m)}
              </div>
            </div>
          ),
        )}
        {typing && (
          <div className="flex items-center gap-2" aria-label="Assistant is typing">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-700">
              <Bot className="h-4 w-4" />
            </span>
            <span className="flex gap-1 rounded-2xl rounded-tl-sm bg-white px-3.5 py-3 ring-1 ring-slate-200">
              {[0, 150, 300].map((delay) => (
                <span key={delay} className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" style={{ animationDelay: `${delay}ms` }} />
              ))}
            </span>
          </div>
        )}
      </div>

      <form onSubmit={submit} className={cn('flex items-center gap-2 border-t border-slate-200 bg-white', focus ? 'px-5 py-3 sm:px-8' : 'px-3 py-2.5')}>
        <input
          ref={input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder='Try "timesheet", "leave" or "courses"'
          maxLength={200}
          aria-label="Message the assistant"
          className="min-w-0 flex-1 rounded-full border border-slate-200 bg-slate-50 px-3.5 py-2 text-sm placeholder:text-slate-400 focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-100"
        />
        <button
          type="submit"
          disabled={!draft.trim() || typing}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white transition-colors hover:bg-brand-700 disabled:bg-slate-300"
          aria-label="Send"
        >
          <SendHorizontal className="h-4 w-4" />
        </button>
      </form>
    </section>
  );

  return (
    <>
      {open &&
        (focus ? (
          // Full-screen welcome: the page behind is dimmed and blurred; clicking outside the panel skips to it.
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-md sm:p-8" onMouseDown={close}>
            {panel}
          </div>
        ) : (
          panel
        ))}

      {!(open && focus) && (
        <button
          ref={launcher}
          type="button"
          onClick={() => (open ? close() : setOpen(true))}
          className="fixed bottom-5 right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-brand-600 text-white shadow-pop transition-transform hover:scale-105 hover:bg-brand-700 focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-200 sm:right-6"
          aria-label={open ? 'Close assistant' : 'Open assistant'}
          aria-expanded={open}
        >
          {open ? <X className="h-6 w-6" /> : <MessageCircle className="h-6 w-6" />}
          {!open && attentionCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white ring-2 ring-white">
              {attentionCount}
            </span>
          )}
        </button>
      )}
    </>
  );
}
