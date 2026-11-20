import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  Briefcase,
  CalendarDays,
  ClipboardCheck,
  LayoutDashboard,
  LayoutGrid,
  Settings,
  Users,
  Video,
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
  Sparkles,
  Timer,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { LeaveDuration, Role, TimesheetStatus } from '@/types';
import type { CatalogCourse, TeamAvailability } from '@/types/api';
import { IS_MOCK_MODE, leaveService, lmsService } from '@/services';
import { useAppData } from '@/context/AppDataContext';
import { useCurrentUser, useLookups } from '@/hooks/useLookups';
import { useNotifications } from '@/hooks/useNotifications';
import { useLmsLauncher, type LmsPage } from '@/hooks/useLmsLauncher';
import { currentWeekStart, formatDate, formatWeekRange, todayISO } from '@/utils/date';
import { deriveTimesheetStatus, entryTotal, findHoliday, isWorkingDay, timesheetTotal } from '@/utils/timesheet';
import { cn } from '@/utils/format';
import { PROJECT_COLOR_PALETTE } from '@/constants/ui';
import { takeSignInGreeting } from './greeting';
import { homePath } from '@/routes/navigation';
import { ConfettiRain, DrawnCheck, PartyBurst, Sparkles as SparkleBursts, type SparkleBurst } from './celebrations';
import {
  asksForCategories,
  asksForCount,
  asksWhatICanDo,
  featuresFor,
  isCourseQuestion,
  matchCategories,
  pickRandom,
  searchCourses,
  searchFeatures,
  type Feature,
} from './knowledge';
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

type Action =
  | { kind: 'node'; node: NodeId }
  | { kind: 'nav'; to: string }
  | { kind: 'lms'; page?: LmsPage }
  | { kind: 'leave'; step: LeaveStep }
  /** Course answers: the overview, or one category's courses. */
  | { kind: 'courses'; category?: string };

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
  /** Colour of the icon tile on the large welcome cards. */
  accent?: Accent;
  /** A suggested leave day: shown as a small calendar tile instead of a button pill. */
  date?: ISODate;
  /** An LMS course: shown as a course card. */
  course?: CatalogCourse;
  /** Short note on a calendar tile, e.g. "Long weekend". */
  tag?: string;
  action: Action;
}

type Accent = 'brand' | 'violet' | 'teal' | 'amber';
const ACCENTS: Record<Accent, string> = {
  brand: 'bg-brand-50 text-brand-600 group-hover:bg-brand-600 group-hover:text-white',
  violet: 'bg-violet-50 text-violet-600 group-hover:bg-violet-600 group-hover:text-white',
  teal: 'bg-teal-50 text-teal-600 group-hover:bg-teal-600 group-hover:text-white',
  amber: 'bg-amber-50 text-amber-600 group-hover:bg-amber-500 group-hover:text-white',
};

/** Rich content shown inside a bot message. */
type Card =
  | { kind: 'week'; title: string; hours: number; target: number; status: string; projects: { name: string; color: string; hours: number }[] }
  | { kind: 'summary'; title: string; rows: { label: string; value: string }[]; footer?: string }
  | { kind: 'list'; title: string; rows: ListRow[] };

type Tone = 'green' | 'amber' | 'red' | 'blue' | 'slate';
interface ListRow {
  primary: string;
  secondary?: string;
  badge?: string;
  tone?: Tone;
  color?: string;
}

interface Message {
  id: number;
  from: 'bot' | 'user';
  text: string;
  options?: Option[];
  card?: Card;
  /** 'success' tints the bubble green and plays a small celebration. */
  tone?: 'success';
  at: number;
}

interface Reply {
  text: string;
  options: Option[];
  card?: Card;
  tone?: 'success';
}

type Extra = Pick<Message, 'card' | 'tone'>;

const TYPING_MS = 450;

const STATUS_SHORT: Record<TimesheetStatus, string> = {
  not_started: 'Not started',
  draft: 'Draft',
  submitted: 'Submitted',
  partially_approved: 'Partly approved',
  approved: 'Approved',
  returned: 'Returned',
  rejected: 'Rejected',
};

const timeLabel = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

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
    /\b(leaves?|vacation|time ?off|days? off|break)\b/.test(t) &&
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

/** Messages the embedded assistant sends to the page that frames it (the LMS). */
export const EMBED_CLOSE_MESSAGE = 'timetrack-assistant:close';

/** The LMS page this assistant is framed in, if it is (same origin, under /lms). */
function framingLms(): Window | null {
  try {
    if (window.top && window.top !== window && window.top.location.pathname.startsWith('/lms')) return window.top;
  } catch {
    // A page on another origin frames us: treat it as not the LMS.
  }
  return null;
}

/**
 * `embedded`: the assistant runs inside the LMS (in a frame, see components/assistant/EmbeddedAssistant.tsx). It is
 * always open, has no launcher or full-screen welcome, sends timesheet links to the whole window, and switches LMS
 * pages in place instead of opening a new tab.
 */
export function AssistantWidget({ role, embedded = false }: { role: Role; embedded?: boolean }) {
  const navigate = useNavigate();
  const user = useCurrentUser();
  const { timesheets, leaves, calendars, applyLeave, allocations, projects } = useAppData();
  const { employeeName, project } = useLookups();
  const { counts, items } = useNotifications();
  const lms = useLmsLauncher();

  const [open, setOpen] = useState(embedded);
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
  const panelRef = useRef<HTMLElement>(null);
  /** The current one-off celebration (party poppers on welcome, confetti rain on success). */
  const [celebration, setCelebration] = useState<{ id: number; kind: 'welcome' | 'success' } | null>(null);
  const [sparkles, setSparkles] = useState<SparkleBurst[]>([]);
  /** "I'm right here" bubble next to the chat button, shown briefly after the welcome is closed. */
  const [peek, setPeek] = useState(false);
  const plan = useRef<PlanState>({ stage: 'idle' });
  const availabilityCache = useRef(new Map<string, TeamAvailability>());
  /** Bumped by "start over", so a reply still loading from the server is dropped. */
  const epoch = useRef(0);

  const firstName = user.name.split(' ')[0] || user.name;
  const attentionCount = items.length;

  /** Builds a step of the conversation from the latest data. */
  const build = (node: NodeId): Reply => {
    const mainOptions: Option[] = [
      { id: 'go-ts', label: 'Timesheet', icon: Clock, accent: 'brand', hint: role === 'associate' ? 'Log hours, leave and overtime' : 'Approvals, allocations and reports', action: { kind: 'node', node: 'timesheet' } },
      ...(IS_MOCK_MODE && !(embedded && framingLms()) ? [] : [{ id: 'go-lms', label: 'LMS', icon: GraduationCap, accent: 'violet', hint: 'Courses, training and certificates', action: { kind: 'node', node: 'lms' } } satisfies Option]),
      { id: 'go-plan', label: 'Plan a leave', icon: CalendarSearch, accent: 'teal', hint: 'Clash-free dates, sent for you', action: { kind: 'node', node: 'plan' } },
      { id: 'go-att', label: 'What needs my attention?', icon: Bell, accent: 'amber', hint: attentionCount ? 'Pending items and reminders' : "You're all caught up", count: attentionCount || undefined, action: { kind: 'node', node: 'attention' } },
      ...(embedded ? [{ id: 'go-home', label: 'Back to my timesheet', icon: ArrowLeft, accent: 'brand', hint: 'Leave the LMS for your workspace', action: { kind: 'nav', to: homePath(role) } } satisfies Option] : []),
    ];

    switch (node) {
      case 'welcome':
        if (embedded)
          return {
            text: `${greetingForHour(new Date().getHours())}, ${firstName}! You're in the LMS. I can find courses, plan your leave or take you back to your timesheet.`,
            options: mainOptions,
          };
        return {
          text: `${greetingForHour(new Date().getHours())}, ${firstName}! Where do you want to go today?`,
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
      const card: Card = {
        kind: 'week',
        title: `Week of ${formatWeekRange(week)}`,
        hours,
        target: user.weeklyCapacity || 40,
        status: STATUS_SHORT[status],
        projects: (current?.entries ?? []).map((e) => ({ name: project(e.projectId)?.name ?? 'Project', color: project(e.projectId)?.color ?? '#94a3b8', hours: entryTotal(e) })),
      };
      return {
        card,
        text: `${status === 'not_started' ? summary : "Here's your week so far."}\nWhat would you like to do?`,
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
    const explore: Option = { id: 'lms-explore', label: 'Explore courses', icon: LayoutGrid, action: { kind: 'courses' } };
    if (IS_MOCK_MODE && !(embedded && framingLms())) return { text: "The LMS itself isn't available in mock mode, but you can explore the sample course catalogue.", options: [explore, BACK] };
    return {
      text: embedded ? 'Where would you like to go in the LMS?' : "The LMS opens in a new tab and you're signed in automatically. Where would you like to start?",
      options: [
        explore,
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

  const push = useCallback((from: Message['from'], text: string, options?: Option[], extra?: Extra) => {
    setMessages((list) => [...list, { id: nextId.current++, from, text, options, at: Date.now(), ...extra }]);
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
        push('bot', reply.text, reply.options, { card: reply.card, tone: reply.tone });
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
            push('bot', reply.text, reply.options, { card: reply.card, tone: reply.tone });
            if (reply.tone === 'success') setCelebration({ id: Date.now(), kind: 'success' });
          }, Math.max(0, TYPING_MS - (Date.now() - started)));
          timers.current.push(id);
        });
    },
    [push],
  );


  // ------------------------------------------------------------------ lookups: courses, holidays, leave, projects, features

  const catalog = useRef<Promise<CatalogCourse[]> | null>(null);
  const loadCatalog = () => {
    if (!catalog.current) {
      catalog.current = lmsService.courses().then((r) => r.courses);
      catalog.current.catch(() => {
        catalog.current = null;
      });
    }
    return catalog.current;
  };

  // Inside an LMS page the LMS is always there, even when the timesheet runs on the development mock API.
  const lmsAvailable = !IS_MOCK_MODE || (embedded && framingLms() !== null);
  const lmsAction = (page: LmsPage): Action => (lmsAvailable ? { kind: 'lms', page } : { kind: 'node', node: 'lms' });
  const courseOption = (c: CatalogCourse): Option => ({ id: `course-${c.id}`, label: c.title, course: c, action: lmsAction('catalog') });
  const seeAllCourses = (total: number): Option => ({ id: 'see-all-courses', label: `See all ${total} courses`, icon: LibraryBig, action: lmsAction('catalog') });

  /** Answers course questions: an overview with four random courses, one or more categories, or a keyword search. */
  const courseReply = async (ask: { text?: string; category?: string }): Promise<Reply> => {
    const courses = await loadCatalog();
    if (!courses.length) return { text: "I couldn't find any courses in the LMS yet.", options: [BACK] };
    const perCategory = new Map<string, number>();
    for (const c of courses) perCategory.set(c.category, (perCategory.get(c.category) ?? 0) + 1);
    const categoryOptions = (skip: string[] = [], max = 6): Option[] =>
      [...perCategory.entries()]
        .filter(([c]) => !skip.includes(c))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, max)
        .map(([c, n]) => ({ id: `cat-${c}`, label: `${c} (${n})`, icon: LayoutGrid, action: { kind: 'courses', category: c } }));
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    const showList = (intro: string, list: CatalogCourse[], skip: string[]): Reply => {
      const shown = list.slice(0, 6);
      return {
        text: list.length > shown.length ? `${intro}\n(Showing ${shown.length} of ${list.length}.)` : intro,
        options: [...shown.map(courseOption), ...categoryOptions(skip, 4), seeAllCourses(courses.length), BACK],
      };
    };

    const wanted = ask.category ? [ask.category] : ask.text ? matchCategories(ask.text, [...perCategory.keys()]) : [];
    if (wanted.length) {
      const list = courses.filter((c) => wanted.includes(c.category));
      return showList(`Here ${list.length === 1 ? 'is the 1 course' : `are the ${list.length} courses`} in ${wanted.join(' and ')}:`, list, wanted);
    }
    const text = ask.text ?? '';
    if (asksForCategories(text) && !asksForCount(text)) {
      return {
        text: `The LMS has ${plural(courses.length, 'course', 'courses')} in ${plural(perCategory.size, 'category', 'categories')}. Pick one to see its courses:`,
        card: {
          kind: 'list',
          title: 'Course categories',
          rows: [...perCategory.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([c, n]) => ({ primary: c, badge: plural(n, 'course', 'courses'), tone: 'blue', color: categoryColor(c) })),
        },
        options: [...categoryOptions([], 12), seeAllCourses(courses.length), BACK],
      };
    }
    const hits = asksForCount(text) ? [] : searchCourses(text, courses);
    if (hits.length) return showList(`I found ${plural(hits.length, 'course', 'courses')} matching your search:`, hits, []);
    return {
      text: `There ${courses.length === 1 ? 'is' : 'are'} ${plural(courses.length, 'course', 'courses')} in the LMS across ${plural(perCategory.size, 'category', 'categories')}. Here are ${Math.min(4, courses.length)} picked at random — tap a category to narrow it down:`,
      options: [...pickRandom(courses, 4).map(courseOption), ...categoryOptions(), seeAllCourses(courses.length), BACK],
    };
  };

  const calendarNav: Option =
    role === 'associate'
      ? { id: 'nav-cal', label: 'My calendar', icon: CalendarDays, action: { kind: 'nav', to: '/associate/calendar' } }
      : role === 'manager'
        ? { id: 'nav-cal', label: 'Team calendar', icon: CalendarRange, action: { kind: 'nav', to: '/manager/calendar' } }
        : { id: 'nav-cal', label: 'Calendars', icon: CalendarDays, action: { kind: 'nav', to: '/admin/calendars' } };
  const planOption: Option = { id: 'go-plan-2', label: 'Plan a leave', icon: CalendarSearch, action: { kind: 'node', node: 'plan' } };
  const longDate = (d: ISODate) => formatDate(d, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  const holidaysReply = (): Reply => {
    const cal = calendars.find((c) => c.id === user.calendarId);
    const next = (cal?.holidays ?? []).filter((h) => h.date >= todayISO()).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);
    if (!cal) return { text: "You don't have a holiday calendar assigned yet. Ask your administrator to set one.", options: [BACK] };
    if (!next.length) return { text: `No more holidays are scheduled on your ${cal.name}.`, options: [calendarNav, planOption, BACK] };
    return {
      text: `Here ${next.length === 1 ? 'is the next holiday' : `are the next ${next.length} holidays`} on your ${cal.name}:`,
      card: {
        kind: 'list',
        title: 'Upcoming holidays',
        rows: next.map((h) => ({ primary: h.name, secondary: longDate(h.date), badge: h.type === 'public' ? 'Public' : 'Company', tone: h.type === 'public' ? 'blue' : 'slate' })),
      },
      options: [planOption, calendarNav, BACK],
    };
  };

  const LEAVE_TONE: Record<string, Tone> = { approved: 'green', pending: 'amber', rejected: 'red' };
  const leaveStatusReply = (): Reply => {
    const mine = leaves.filter((l) => l.employeeId === user.id).sort((a, b) => b.date.localeCompare(a.date));
    const pending = mine.filter((l) => l.status === 'pending').length;
    const upcoming = mine.filter((l) => l.date >= todayISO() && l.status !== 'rejected').length;
    const options: Option[] = [planOption, ...(role === 'associate' ? [{ id: 'lv-page', label: 'Leave Requests page', icon: Plane, action: { kind: 'nav', to: '/associate/leave' } } satisfies Option] : []), BACK];
    if (!mine.length) return { text: "You haven't requested any leave yet. Want me to find clash-free dates?", options };
    return {
      text: `You have ${upcoming} upcoming leave day${upcoming === 1 ? '' : 's'}${pending ? `, ${pending} still waiting for approval` : ''}. Your latest requests:`,
      card: {
        kind: 'list',
        title: 'My leave requests',
        rows: mine.slice(0, 6).map((l) => ({
          primary: longDate(l.date),
          secondary: `${l.duration === 'half' ? 'Half day' : 'Full day'} · ${l.reason}`,
          badge: l.status[0]!.toUpperCase() + l.status.slice(1),
          tone: LEAVE_TONE[l.status] ?? 'slate',
        })),
      },
      options,
    };
  };

  const projectsReply = (): Reply => {
    const today = todayISO();
    if (role === 'associate') {
      const mine = allocations.filter((a) => a.employeeId === user.id && a.endDate >= today).sort((a, b) => b.weeklyHours - a.weeklyHours);
      const nav: Option = { id: 'nav-proj', label: 'My Projects page', icon: Briefcase, action: { kind: 'nav', to: '/associate/projects' } };
      if (!mine.length) return { text: "You aren't allocated to any projects right now.", options: [nav, BACK] };
      const total = mine.reduce((sum, a) => sum + a.weeklyHours, 0);
      return {
        text: `You're on ${mine.length} project${mine.length === 1 ? '' : 's'}, ${formatHoursShort(total)} a week in total:`,
        card: {
          kind: 'list',
          title: 'My projects',
          rows: mine.map((a) => ({
            primary: project(a.projectId)?.name ?? 'Project',
            secondary: `${a.projectRole} · until ${formatDate(a.endDate, { day: 'numeric', month: 'short', year: 'numeric' })}`,
            badge: `${a.weeklyHours} h/wk`,
            tone: 'blue',
            color: project(a.projectId)?.color,
          })),
        },
        options: [nav, BACK],
      };
    }
    const list = projects.filter((p) => role === 'admin' || p.managerId === user.id);
    const nav: Option = role === 'admin'
      ? { id: 'nav-proj', label: 'Projects page', icon: Briefcase, action: { kind: 'nav', to: '/admin/projects' } }
      : { id: 'nav-proj', label: 'Project Allocation', icon: Network, action: { kind: 'nav', to: '/manager/allocation' } };
    if (!list.length) return { text: role === 'admin' ? 'There are no projects yet.' : "You don't manage any projects yet.", options: [nav, BACK] };
    return {
      text: `${role === 'admin' ? 'There are' : 'You manage'} ${list.length} project${list.length === 1 ? '' : 's'}${list.length > 6 ? ' — here are the first 6' : ''}:`,
      card: {
        kind: 'list',
        title: role === 'admin' ? 'Projects' : 'My projects',
        rows: list.slice(0, 6).map((p) => ({
          primary: p.name,
          secondary: p.client,
          badge: allocations.filter((a) => a.projectId === p.id && a.endDate >= today).length + ' people',
          tone: 'slate',
          color: p.color,
        })),
      },
      options: [nav, BACK],
    };
  };

  const FEATURE_ICONS: Record<string, LucideIcon> = {
    dash: LayoutDashboard, ts: Clock, subs: FileClock, proj: Briefcase, cal: CalendarDays, leave: Plane, ot: Timer, team: Users,
    alloc: Network, appr: CheckSquare, rep: BarChart3, emp: Users, set: Settings, my: BookOpen, cat: LibraryBig, cert: Award,
    live: Video, assess: ClipboardCheck, plan: CalendarSearch, att: Bell,
  };
  const featureOption = (f: Feature): Option => ({
    id: `f-${f.id}`,
    label: f.title,
    hint: `${f.area === 'Timesheet' ? '' : `${f.area} · `}${f.description}`,
    icon: FEATURE_ICONS[f.id.split('-')[1] ?? ''] ?? LayoutGrid,
    accent: f.area === 'LMS' ? 'violet' : f.area === 'Assistant' ? 'teal' : 'brand',
    action: f.to ? { kind: 'nav', to: f.to } : f.lms ? lmsAction(f.lms) : { kind: 'node', node: f.node ?? 'menu' },
  });

  const directoryReply = (): Reply => {
    const all = featuresFor(role, true);
    const count = (area: Feature['area']) => all.filter((f) => f.area === area).length;
    return {
      text: `Here's everything I can take you to: ${count('Timesheet')} timesheet pages, ${count('LMS') ? `${count('LMS')} LMS pages, ` : ''}and ${count('Assistant')} things I do myself. You can also ask me about courses, holidays, your leave or your projects.`,
      options: [...all.map(featureOption), BACK],
    };
  };

  /** Typed questions answered from data (courses, holidays, leave, projects, the feature list), or null. */
  const lookup = (text: string): (() => Promise<Reply>) | null => {
    const t = text.toLowerCase();
    if (asksWhatICanDo(t)) return async () => directoryReply();
    if (isCourseQuestion(t)) return () => courseReply({ text });
    if (/\bholidays?\b/.test(t)) return async () => holidaysReply();
    if ((/\bleaves?\b/.test(t) && /\b(status|requests?|history|applied|pending|approved|rejected|taken|upcoming|booked)\b/.test(t)) || /\bmy leaves?\b/.test(t))
      return async () => leaveStatusReply();
    if (/\b(projects?|allocations?|allocated)\b/.test(t) && !/\b(timesheet|hours|log)\b/.test(t)) return async () => projectsReply();
    return null;
  };

  /** Anything else: look it up in the feature directory. */
  const featureSearchReply = (text: string): Reply | null => {
    const found = searchFeatures(text, role, true);
    if (!found.length) return null;
    return { text: found.length === 1 ? 'I think this is what you are looking for:' : "Here's what I found:", options: [...found.map(featureOption), BACK] };
  };

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
      lines.push(`\nThese days are free for the whole team. Tap one to request it, or pick your own:`);
      return {
        text: lines.join('\n'),
        options: [
          ...suggestions.map(
            (x): Option => ({
              id: `sg-${x.date}`,
              label: `${dayLabel(x.date, today)}${x.longWeekend ? ' 🌴' : ''}${x.note && x.note !== 'long weekend' ? ` · ${x.note}` : ''}`,
              date: x.date,
              tag: x.note ? (x.note === 'long weekend' ? '🌴 Long weekend' : `🌴 ${x.note[0]!.toUpperCase()}${x.note.slice(1)}`) : undefined,
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

  const summaryCard = (state: PlanState): Card => ({
    kind: 'summary',
    title: 'Leave request',
    rows: [
      { label: (state.dates?.length ?? 0) > 1 ? 'Dates' : 'Date', value: (state.dates ?? []).map((d) => dayLabel(d, today)).join(', ') },
      { label: 'Duration', value: `${durationLabel(state.duration ?? 'full')}${(state.dates?.length ?? 0) > 1 ? ' each' : ''}` },
      { label: 'Reason', value: state.reason ?? '' },
      ...(approver ? [{ label: 'Approver', value: approver }] : []),
    ],
  });

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
        tone: sent.length && !failed.length ? 'success' : undefined,
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
          push('bot', approver ? `Here's your request. It goes to ${approver} for approval. Shall I send it?` : "Here's your request. Shall I send it?", [
            { id: 'pl-send', label: 'Send request', icon: SendHorizontal, action: { kind: 'leave', step: { to: 'send' } } },
            { id: 'pl-custom', label: 'Change dates', icon: PencilLine, action: { kind: 'leave', step: { to: 'custom' } } },
            { id: 'pl-cancel', label: 'Cancel', icon: X, action: { kind: 'leave', step: { to: 'cancel' } } },
          ], { card: summaryCard(plan.current) }),
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
    if (!embedded && takeSignInGreeting()) {
      setOpen(true);
      setFocus(true);
      setCelebration({ id: Date.now(), kind: 'welcome' });
    }
  }, []);

  // Celebrations play once, then their elements are removed.
  useEffect(() => {
    if (!celebration) return;
    const id = window.setTimeout(() => setCelebration(null), celebration.kind === 'welcome' ? 3000 : 3600);
    return () => window.clearTimeout(id);
  }, [celebration]);

  useEffect(() => {
    if (!peek) return;
    const id = window.setTimeout(() => setPeek(false), 4700);
    return () => window.clearTimeout(id);
  }, [peek]);

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
    if (embedded) {
      // The LMS page hides the frame.
      window.parent.postMessage({ type: EMBED_CLOSE_MESSAGE }, window.location.origin);
      return;
    }
    if (focus) setPeek(true);
    setOpen(false);
    setFocus(false);
    setCelebration(null);
    launcher.current?.focus();
  };

  /** Little stars burst from where an option was clicked (not for keyboard presses). */
  const sparkle = (event: MouseEvent<HTMLElement>) => {
    const box = panelRef.current?.getBoundingClientRect();
    if (!box || event.detail === 0) return;
    const burst = { id: Date.now() + Math.random(), x: event.clientX - box.left, y: event.clientY - box.top };
    setSparkles((list) => [...list, burst]);
    const id = window.setTimeout(() => setSparkles((list) => list.filter((b) => b !== burst)), 700);
    timers.current.push(id);
  };

  const choose = (option: Option) => {
    if (typing) return;
    const { action } = option;
    const lmsWindow = embedded ? framingLms() : null;
    if (action.kind === 'lms' && lmsWindow) {
      // Already in the LMS: switch its page in place.
      push('user', option.label);
      lmsWindow.location.hash = action.page ?? 'dashboard';
      later(() => push('bot', `Done, the LMS is showing ${option.label === 'Go to My LMS' ? 'your home page' : `"${option.label}"`}. Anything else?`, buildRef.current('menu').options));
      return;
    }
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
    if (action.kind === 'courses') {
      botSaysAsync(() => courseReply({ category: action.category }));
      return;
    }
    if (action.kind === 'node') {
      if (action.node === 'plan') startPlan(null);
      else botSays(action.node);
      return;
    }
    later(() => {
      push('bot', `Taking you to ${option.label.replace(/^Go to /, '')}…`);
      if (embedded) {
        // Timesheet pages open in the whole window, leaving the LMS.
        try {
          (window.top ?? window).location.assign(action.to);
        } catch {
          window.open(action.to, '_blank', 'noopener');
        }
        return;
      }
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
    if (intent === 'plan') return startPlan(parseMonth(text, todayISO()));
    const answer = intent === 'thanks' || intent === 'menu' ? null : lookup(text);
    if (answer) return botSaysAsync(answer);
    // Feature search answers anything not otherwise understood, and LMS pages (live training, exams, certificates)
    // win over a loose keyword match such as "week" sending "live sessions this week" to the timesheet.
    const lmsHit = searchFeatures(text, role, true)[0]?.area === 'LMS';
    if (intent === 'fallback' || (lmsHit && intent !== 'leave' && intent !== 'overtime')) {
      const found = featureSearchReply(text);
      if (found) return later(() => push('bot', found.text, found.options));
    }
    botSays(intent);
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

  // Rotating examples in the message box, so people discover what they can type.
  const [hintIndex, setHintIndex] = useState(0);
  useEffect(() => {
    if (!open || draft) return;
    const id = window.setInterval(() => setHintIndex((i) => (i + 1) % TYPING_HINTS.length), 3500);
    return () => window.clearInterval(id);
  }, [open, draft]);

  const weekHours =
    role === 'associate' ? timesheetTotal(timesheets.find((t) => t.employeeId === user.id && t.weekStart === currentWeekStart())) : null;

  const renderOptions = (m: Message) => {
    if (m !== lastBot || !m.options?.length || typing) return null;

    // Full-screen welcome: the main choices are large cards.
    if (focus && m.options.some((o) => o.hint)) {
      return (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {m.options.map((o, i) => (
            <button
              key={o.id}
              type="button"
              onClick={(e) => {
                sparkle(e);
                choose(o);
              }}
              disabled={o.action.kind === 'lms' && lms.busy}
              style={{ animationDelay: `${i * 60}ms` }}
              className="chip-in group relative flex items-center gap-3.5 overflow-hidden rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-pop focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-100 disabled:opacity-60"
            >
              <span className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl" aria-hidden>
                <span className="card-shine absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/80 to-transparent" style={{ ['--delay' as string]: `${400 + i * 120}ms` }} />
              </span>
              <span className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-colors', ACCENTS[o.accent ?? 'brand'])}>
                {o.icon && <o.icon className="icon-wiggle h-5 w-5" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  {o.label}
                  {o.count ? <span className="rounded-full bg-red-500 px-1.5 py-px text-[10px] font-semibold tabular-nums text-white">{o.count}</span> : null}
                </span>
                {o.hint && <span className="mt-0.5 block text-xs text-slate-500">{o.hint}</span>}
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 -translate-x-1 text-slate-300 opacity-0 transition-all group-hover:translate-x-0 group-hover:text-brand-600 group-hover:opacity-100" />
            </button>
          ))}
        </div>
      );
    }

    const courseOpts = m.options.filter((o) => o.course);
    const dates = m.options.filter((o) => o.date);
    const rest = m.options.filter((o) => !o.date && !o.course);
    return (
      <>
        {courseOpts.length > 0 && (
          <div className={cn('mt-2.5 grid gap-2.5', focus ? 'sm:grid-cols-2' : 'grid-cols-1')}>
            {courseOpts.map((o, i) => (
              <CourseTile
                key={o.id}
                option={o}
                delay={i * 70}
                onPick={(e) => {
                  sparkle(e);
                  choose(o);
                }}
              />
            ))}
          </div>
        )}
        {dates.length > 0 && (
          <div className={cn('mt-2.5 grid gap-2', focus ? 'grid-cols-3 sm:grid-cols-6' : 'grid-cols-3')}>
            {dates.map((o, i) => (
              <DateTile
                key={o.id}
                option={o}
                delay={i * 70}
                onPick={(e) => {
                  sparkle(e);
                  choose(o);
                }}
              />
            ))}
          </div>
        )}
        <div className="mt-2.5 flex flex-wrap gap-2">
          {rest.map((o, i) => (
            <button
              key={o.id}
              type="button"
              onClick={(e) => {
                sparkle(e);
                choose(o);
              }}
              disabled={o.action.kind === 'lms' && lms.busy}
              style={{ animationDelay: `${(dates.length + i) * 45}ms` }}
              className={cn(
                'chip-in inline-flex max-w-full items-center gap-1.5 rounded-full border text-left font-medium shadow-sm transition-all hover:-translate-y-px disabled:opacity-60',
                focus ? 'px-4 py-2 text-sm' : 'px-3 py-1.5 text-xs',
                o.id === 'back'
                  ? 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-700'
                  : o.id === 'pl-send'
                    ? 'border-transparent bg-gradient-to-r from-brand-500 to-brand-700 text-white hover:shadow-pop'
                    : 'border-brand-200 bg-white text-brand-700 hover:border-brand-400 hover:bg-brand-50',
              )}
            >
              {o.icon && <o.icon className={cn('shrink-0', focus ? 'h-4 w-4' : 'h-3.5 w-3.5')} />}
              <span className="truncate">{o.label}</span>
              {o.count ? <span className="rounded-full bg-brand-600 px-1.5 text-[10px] font-semibold tabular-nums text-white">{o.count}</span> : null}
            </button>
          ))}
        </div>
      </>
    );
  };

  const botAvatar = (
    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-sm ring-2 ring-white">
      <Bot className="h-4 w-4" />
    </span>
  );

  const panel = (
    <section
      ref={panelRef}
      role="dialog"
      aria-modal={focus || undefined}
      aria-label="TimeTrack assistant"
      onKeyDown={onKeyDown}
      onMouseDown={(e) => e.stopPropagation()}
      className={cn(
        'chat-pop flex flex-col overflow-hidden bg-white ring-1 ring-slate-200',
        focus
          ? 'relative h-full w-full sm:h-[min(700px,calc(100vh-4rem))] sm:w-[min(800px,calc(100vw-4rem))] sm:rounded-2xl sm:shadow-2xl'
          : embedded
            ? 'h-full w-full'
            : 'fixed bottom-24 right-4 z-40 h-[min(580px,calc(100vh-8rem))] w-[390px] max-w-[calc(100vw-2rem)] rounded-2xl shadow-2xl sm:right-6',
      )}
    >
      {celebration?.kind === 'welcome' && (
        <>
          <PartyBurst seed={celebration.id} />
        </>
      )}
      {celebration?.kind === 'success' && <ConfettiRain seed={celebration.id} />}
      <SparkleBursts bursts={sparkles} />
      <header className="palette-light relative flex items-center gap-3 overflow-hidden bg-gradient-to-r from-sidebar via-sidebar to-brand-700 px-4 py-3 text-white">
        <span className="pointer-events-none absolute -right-10 -top-16 h-40 w-40 rounded-full bg-brand-500/20 blur-2xl" aria-hidden />
        <span className="avatar-bob relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/20">
          <Bot className="h-5 w-5" />
          <span className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3">
            <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 motion-safe:animate-ping" />
            <span className="relative inline-flex h-3 w-3 rounded-full border-2 border-sidebar bg-emerald-400" />
          </span>
        </span>
        <div className="relative min-w-0 flex-1 leading-tight">
          <p className="truncate text-sm font-semibold">TimeTrack Assistant</p>
          <p className="truncate text-[11px] text-slate-300">Online · replies instantly</p>
        </div>
        <button type="button" onClick={restart} className="relative rounded-lg p-1.5 text-slate-300 hover:bg-white/10 hover:text-white" aria-label="Start over" title="Start over">
          <RotateCcw className="h-4 w-4" />
        </button>
        {focus ? (
          <button type="button" onClick={close} className="relative inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:bg-white/10 hover:text-white">
            Skip to dashboard <X className="h-4 w-4" />
          </button>
        ) : (
          <button type="button" onClick={close} className="relative rounded-lg p-1.5 text-slate-300 hover:bg-white/10 hover:text-white" aria-label="Minimise assistant" title="Minimise">
            <Minus className="h-4 w-4" />
          </button>
        )}
      </header>

      <div ref={scroller} role="log" aria-live="polite" className={cn('chat-dots flex-1 overflow-y-auto bg-slate-50', focus ? 'space-y-4 px-5 py-5 sm:px-8' : 'space-y-3.5 px-4 py-4')}>
        {focus && (
          <div className="msg-in-left relative overflow-hidden rounded-2xl bg-gradient-to-br from-brand-600 via-brand-700 to-sidebar px-5 py-5 text-white shadow-pop sm:px-6">
            <span className="pointer-events-none absolute -right-12 -top-12 h-44 w-44 rounded-full bg-white/10" aria-hidden />
            <span className="pointer-events-none absolute -bottom-16 right-24 h-32 w-32 rounded-full bg-brand-400/20" aria-hidden />
            <div className="relative flex items-center gap-4">
              <span className="hidden h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-white/15 ring-1 ring-white/25 sm:flex">
                <Bot className="h-7 w-7" />
              </span>
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-brand-100">
                  {formatDate(todayISO(), { weekday: 'long', day: 'numeric', month: 'long' })}
                </p>
                <h2 className="mt-1 text-xl font-semibold sm:text-2xl">
                  Welcome back, {firstName} <span className="wave-hand" aria-hidden>👋</span>
                </h2>
                <p className="mt-1 text-sm text-brand-100">Tell me where you&apos;d like to start, and I&apos;ll take you there.</p>
              </div>
            </div>
            <div className="relative mt-4 flex flex-wrap gap-2 text-xs">
              {weekHours !== null && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 ring-1 ring-white/20">
                  <Clock className="h-3.5 w-3.5" /> {formatHoursShort(weekHours)} logged this week
                </span>
              )}
              {role !== 'associate' && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 ring-1 ring-white/20">
                  <CheckSquare className="h-3.5 w-3.5" /> {counts.approvals} timesheet {counts.approvals === 1 ? 'entry' : 'entries'} to review
                </span>
              )}
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 ring-1 ring-white/20">
                <Bell className="h-3.5 w-3.5" /> {attentionCount ? `${attentionCount} thing${attentionCount === 1 ? ' needs' : 's need'} attention` : 'All caught up'}
              </span>
            </div>
          </div>
        )}
        {messages.map((m) =>
          m.from === 'user' ? (
            <div key={m.id} className="msg-in-right flex flex-col items-end">
              <p
                className={cn(
                  'max-w-[80%] rounded-2xl rounded-tr-md bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-sm',
                  focus ? 'px-4 py-2.5 text-[15px]' : 'px-3.5 py-2 text-sm',
                )}
              >
                {m.text}
              </p>
              <span className="mt-1 text-[10px] text-slate-400">{timeLabel(m.at)}</span>
            </div>
          ) : (
            <div key={m.id} className="msg-in-left flex gap-2.5">
              {botAvatar}
              <div className="min-w-0 flex-1">
                <div className={cn('relative w-fit max-w-full', m.tone === 'success' && 'pop-bounce')}>
                  <p
                    className={cn(
                      'whitespace-pre-line rounded-2xl rounded-tl-md shadow-sm ring-1',
                      m.tone === 'success' ? 'bg-emerald-50 text-emerald-900 ring-emerald-200' : 'bg-white text-slate-700 ring-slate-200/80',
                      focus ? 'px-4 py-3 text-[15px]' : 'px-3.5 py-2.5 text-sm',
                    )}
                  >
                    {m.tone === 'success' && <DrawnCheck />}
                    {m.tone === 'success' ? m.text.replace(/^✅\s*/, '') : m.text}
                  </p>
                  {m.tone === 'success' && <Celebration />}
                </div>
                {m.card?.kind === 'week' && <WeekCard card={m.card} />}
                {m.card?.kind === 'summary' && <SummaryCard card={m.card} />}
                {m.card?.kind === 'list' && <ListCard card={m.card} />}
                {renderOptions(m)}
                <span className="mt-1 block text-[10px] text-slate-400">{timeLabel(m.at)}</span>
              </div>
            </div>
          ),
        )}
        {typing && (
          <div className="msg-in-left flex items-center gap-2.5" aria-label="Assistant is typing">
            {botAvatar}
            <span className="flex items-center gap-1 rounded-2xl rounded-tl-md bg-white px-4 py-3.5 shadow-sm ring-1 ring-slate-200/80">
              {[0, 160, 320].map((delay) => (
                <span key={delay} className="typing-dot h-2 w-2 rounded-full bg-brand-400" style={{ animationDelay: `${delay}ms` }} />
              ))}
            </span>
          </div>
        )}
      </div>

      <form onSubmit={submit} className={cn('border-t border-slate-200 bg-white', focus ? 'px-5 py-3 sm:px-8' : 'px-3 py-2.5')}>
        <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 py-1 pl-3.5 pr-1 transition-shadow focus-within:border-brand-400 focus-within:bg-white focus-within:ring-4 focus-within:ring-brand-100">
          <Sparkles className="h-4 w-4 shrink-0 text-brand-400" aria-hidden />
          <input
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={TYPING_HINTS[hintIndex]}
            maxLength={200}
            aria-label="Message the assistant"
            className="min-w-0 flex-1 border-0 bg-transparent py-1.5 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-0"
          />
          <button
            type="submit"
            disabled={!draft.trim() || typing}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-sm transition-all hover:scale-105 disabled:scale-100 disabled:from-slate-300 disabled:to-slate-300 disabled:shadow-none"
            aria-label="Send"
          >
            <SendHorizontal className="h-4 w-4" />
          </button>
        </div>
      </form>
    </section>
  );

  if (embedded) return panel;

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

      {peek && !open && (
        <div className="peek-bubble pointer-events-none fixed bottom-[5.75rem] right-4 z-40 max-w-[220px] rounded-2xl rounded-br-md bg-white px-4 py-2.5 text-sm text-slate-700 shadow-pop ring-1 ring-slate-200 sm:right-6" role="status">
          <span className="font-semibold text-slate-900">I&apos;m right here</span> <span aria-hidden>✨</span>
          <br />
          <span className="text-xs text-slate-500">Tap me whenever you need a hand.</span>
        </div>
      )}

      {!(open && focus) && (
        <button
          ref={launcher}
          type="button"
          onClick={() => (open ? close() : setOpen(true))}
          className="group fixed bottom-5 right-4 z-40 flex h-14 min-w-14 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 px-4 text-white shadow-pop transition-all hover:shadow-2xl focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-200 sm:right-6"
          aria-label={open ? 'Close assistant' : 'Open assistant'}
          aria-expanded={open}
        >
          {!open && attentionCount > 0 && <span className="pointer-events-none absolute inset-0 rounded-full bg-brand-500 opacity-30 motion-safe:animate-ping" aria-hidden />}
          <span className="relative">{open ? <X className="h-6 w-6" /> : <MessageCircle className="h-6 w-6" />}</span>
          {!open && (
            <span className="relative max-w-0 overflow-hidden whitespace-nowrap text-sm font-semibold transition-all duration-300 group-hover:ml-2 group-hover:max-w-[120px] group-focus-visible:ml-2 group-focus-visible:max-w-[120px]">
              Need a hand?
            </span>
          )}
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

const TYPING_HINTS = [
  'Try "how many courses are in the LMS?"',
  'Try "show me the technical courses"',
  'Try "upcoming holidays"',
  'Try "what can you do?"',
  'Try "plan leave in December"',
  'Try "what needs my attention?"',
  'Try "my timesheet"',
  'Try "open my courses"',
  'Try "request overtime"',
];

const categoryColor = (category: string) =>
  PROJECT_COLOR_PALETTE[[...category].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % PROJECT_COLOR_PALETTE.length]!;

const courseLength = (minutes: number) => (!minutes ? null : minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`);

/** An LMS course as a small card; tapping it opens the LMS catalogue. */
function CourseTile({ option, delay, onPick }: { option: Option; delay: number; onPick: (event: MouseEvent<HTMLButtonElement>) => void }) {
  const c = option.course!;
  const color = categoryColor(c.category);
  const meta = [c.difficulty && c.difficulty[0]!.toUpperCase() + c.difficulty.slice(1), c.lessonCount ? `${c.lessonCount} lesson${c.lessonCount === 1 ? '' : 's'}` : null, courseLength(c.durationMinutes)].filter(Boolean);
  return (
    <button
      type="button"
      onClick={onPick}
      title={`${c.title} — open in the LMS`}
      style={{ animationDelay: `${delay}ms` }}
      className="chip-in group relative flex overflow-hidden rounded-xl border border-slate-200 bg-white text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-pop focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-100"
    >
      <span className="w-1.5 shrink-0" style={{ background: color }} aria-hidden />
      <span className="min-w-0 flex-1 px-3.5 py-3">
        <span className="block truncate text-[10px] font-semibold uppercase tracking-wider" style={{ color }}>
          {c.category}
        </span>
        <span className="mt-0.5 line-clamp-2 block text-sm font-semibold leading-snug text-slate-900 group-hover:text-brand-700">{c.title}</span>
        {c.description && <span className="mt-1 line-clamp-1 block text-xs text-slate-500">{c.description}</span>}
        {meta.length > 0 && <span className="mt-1.5 block text-[11px] font-medium text-slate-400">{meta.join(' · ')}</span>}
      </span>
      <ArrowRight className="mr-3 h-4 w-4 shrink-0 self-center text-slate-300 transition-all group-hover:translate-x-0.5 group-hover:text-brand-600" />
    </button>
  );
}

const TONES: Record<Tone, string> = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-700 ring-amber-200',
  red: 'bg-rose-50 text-rose-700 ring-rose-200',
  blue: 'bg-brand-50 text-brand-700 ring-brand-100',
  slate: 'bg-slate-100 text-slate-600 ring-slate-200',
};

function ListCard({ card }: { card: Extract<Card, { kind: 'list' }> }) {
  return (
    <div className="msg-in-left mt-2 w-full max-w-[420px] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <p className="border-b border-slate-100 bg-slate-50 px-3.5 py-2 text-xs font-semibold text-slate-700">{card.title}</p>
      <ul className="divide-y divide-slate-100">
        {card.rows.map((r, i) => (
          <li key={i} className="chip-in flex items-center gap-2.5 px-3.5 py-2.5" style={{ animationDelay: `${i * 50}ms` }}>
            {r.color && <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: r.color }} />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-slate-800">{r.primary}</span>
              {r.secondary && <span className="block truncate text-xs text-slate-500">{r.secondary}</span>}
            </span>
            {r.badge && <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1', TONES[r.tone ?? 'slate'])}>{r.badge}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A suggested leave day as a small calendar page. */
function DateTile({ option, delay, onPick }: { option: Option; delay: number; onPick: (event: MouseEvent<HTMLButtonElement>) => void }) {
  const d = new Date(`${option.date}T00:00:00Z`);
  const part = (opts: Intl.DateTimeFormatOptions) => d.toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });
  return (
    <button
      type="button"
      onClick={onPick}
      aria-label={option.label}
      title={option.label}
      style={{ animationDelay: `${delay}ms` }}
      className="flip-in group flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white text-center shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand-400 hover:shadow-pop focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-100"
    >
      <span className="bg-gradient-to-r from-brand-500 to-brand-700 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white">{part({ month: 'short' })}</span>
      <span className="pt-1.5 text-xl font-bold leading-none text-slate-900 group-hover:text-brand-700">{part({ day: 'numeric' })}</span>
      <span className="pb-1 text-[11px] text-slate-500">{part({ weekday: 'short' })}</span>
      {option.tag && <span className="mx-1 mb-1.5 truncate rounded-md bg-teal-50 px-1 py-px text-[9px] font-medium text-teal-700">{option.tag}</span>}
    </button>
  );
}

function WeekCard({ card }: { card: Extract<Card, { kind: 'week' }> }) {
  const pct = (h: number) => `${Math.min(100, (h / Math.max(card.target, card.hours, 1)) * 100)}%`;
  return (
    <div className="msg-in-left mt-2 w-full max-w-[360px] rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-slate-900">{card.title}</p>
        <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-semibold text-brand-700 ring-1 ring-brand-100">{card.status}</span>
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="text-2xl font-bold tabular-nums text-slate-900">{formatHoursShort(card.hours)}</span>
        <span className="text-xs text-slate-500">of {card.target} h target</span>
      </div>
      <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-slate-100" aria-hidden>
        {card.projects.map((p) => (
          <span key={p.name} className="h-full transition-all" style={{ width: pct(p.hours), background: p.color }} />
        ))}
      </div>
      {card.projects.length > 0 && (
        <ul className="mt-2.5 space-y-1 text-xs">
          {card.projects.map((p) => (
            <li key={p.name} className="flex items-center gap-2 text-slate-600">
              <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: p.color }} />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <span className="font-semibold tabular-nums text-slate-800">{formatHoursShort(p.hours)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SummaryCard({ card }: { card: Extract<Card, { kind: 'summary' }> }) {
  return (
    <div className="msg-in-left mt-2 w-full max-w-[360px] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center gap-2 bg-gradient-to-r from-brand-600 to-brand-700 px-3.5 py-2 text-xs font-semibold text-white">
        <CalendarCheck className="h-4 w-4" /> {card.title}
      </div>
      <dl className="divide-y divide-dashed divide-slate-200 px-3.5">
        {card.rows.map((r) => (
          <div key={r.label} className="flex justify-between gap-4 py-2 text-xs">
            <dt className="text-slate-500">{r.label}</dt>
            <dd className="text-right font-medium text-slate-800">{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** A short burst of coloured confetti around a success message (plays once; hidden for reduced motion). */
function Celebration() {
  const bits = [
    { dx: '-46px', dy: '-30px', c: 'bg-brand-500' },
    { dx: '-20px', dy: '-44px', c: 'bg-teal-400' },
    { dx: '12px', dy: '-48px', c: 'bg-amber-400' },
    { dx: '40px', dy: '-34px', c: 'bg-violet-400' },
    { dx: '56px', dy: '-6px', c: 'bg-brand-300' },
    { dx: '-58px', dy: '-4px', c: 'bg-amber-300' },
    { dx: '30px', dy: '-56px', c: 'bg-emerald-400' },
    { dx: '-34px', dy: '-54px', c: 'bg-rose-300' },
  ];
  return (
    <span className="pointer-events-none absolute left-8 top-3" aria-hidden>
      {bits.map((b, i) => (
        <span
          key={i}
          className={cn('confetti-bit absolute h-1.5 w-1.5 rounded-sm', b.c)}
          style={{ ['--dx' as string]: b.dx, ['--dy' as string]: b.dy, animationDelay: `${i * 25}ms` }}
        />
      ))}
    </span>
  );
}
