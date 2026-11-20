/**
 * What the assistant can look up: LMS course questions ("how many courses", "technical courses", "python course")
 * and a searchable directory of every timesheet and LMS feature. Pure functions with no app imports, so this file
 * can be tested on its own.
 */

export type Role = 'admin' | 'manager' | 'associate';
export type LmsPageName = 'courses' | 'catalog' | 'certificates' | 'calendar' | 'assessments';

export interface CourseLike {
  id: string;
  title: string;
  category: string;
  description: string;
}

const STOP = new Set(
  'a an and are as at be can course courses do does for from get give have how i in is it list lms me my of on or please portal show tell that the there these this to training trainings us want what which with you your all any available about some'.split(
    ' ',
  ),
);

/** Lower-case words of a text, with "&" and punctuation removed. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean);
}

const significant = (text: string) => words(text).filter((w) => !STOP.has(w) && w.length > 1);

/** Extra words people use for LMS categories. */
const SYNONYMS: Record<string, string[]> = {
  tech: ['technical'],
  technical: ['technical'],
  ai: ['artificial', 'intelligence', 'generative', 'ai'],
  genai: ['generative', 'ai', 'artificial', 'intelligence'],
  llm: ['generative', 'ai', 'artificial', 'intelligence'],
  ml: ['artificial', 'intelligence'],
  security: ['cybersecurity'],
  cyber: ['cybersecurity'],
  phishing: ['cybersecurity'],
  privacy: ['protection'],
  compliance: ['compliance', 'policies'],
  policy: ['policies'],
  coding: ['development', 'technical'],
  programming: ['development', 'technical'],
  soft: ['professional', 'communication'],
  management: ['management', 'leadership'],
  analytics: ['analytics'],
};

/** Is this a question about LMS courses (rather than "open my courses", which opens the LMS)? */
export function isCourseQuestion(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b(my|continue|resume|enrolled|progress|certificates?)\b/.test(t) && !/\bhow many\b/.test(t)) return false;
  return /\b(courses?|trainings?|catalog(ue)?|categor(y|ies)|lms)\b/.test(t) && !/\b(leave|overtime|timesheet)\b/.test(t);
}

export const asksForCount = (text: string) => /\b(how many|count|number of|total)\b/i.test(text);
export const asksForCategories = (text: string) => /\b(categor(y|ies)|types? of|kinds? of|topics?)\b/i.test(text);

/**
 * Categories the text refers to, best matches first. A category scores the share of its own words that the text
 * mentions (after synonyms); categories within 60% of the best score are returned.
 */
export function matchCategories(text: string, categories: string[]): string[] {
  const asked = new Set(significant(text).flatMap((w) => [w, ...(SYNONYMS[w] ?? [])]));
  if (!asked.size) return [];
  const scored = categories
    .map((c) => {
      const own = significant(c);
      const hits = own.filter((w) => asked.has(w) || [...asked].some((a) => a.length >= 5 && (w.startsWith(a) || a.startsWith(w)))).length;
      return { c, score: own.length ? hits / own.length : 0 };
    })
    .filter((x) => x.score > 0);
  const best = Math.max(0, ...scored.map((x) => x.score));
  return scored.filter((x) => x.score >= best * 0.6).sort((a, b) => b.score - a.score).map((x) => x.c);
}

/** Courses whose title or description mention the text's words (e.g. "python course"). */
export function searchCourses<C extends CourseLike>(text: string, courses: C[]): C[] {
  const asked = significant(text).filter((w) => w.length >= 3 && !/^(how|many|courses?|show|available|portal|lms)$/.test(w));
  if (!asked.length) return [];
  return courses
    .map((c) => {
      const title = c.title.toLowerCase();
      const body = `${c.description} ${c.category}`.toLowerCase();
      const score = asked.reduce((s, w) => s + (title.includes(w) ? 3 : body.includes(w) ? 1 : 0), 0);
      return { c, score };
    })
    .filter((x) => x.score >= 3)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c);
}

/** A random selection (different on each ask), keeping the original order. */
export function pickRandom<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  const chosen = new Set<number>();
  while (chosen.size < count) chosen.add(Math.floor(Math.random() * items.length));
  return items.filter((_, i) => chosen.has(i));
}

// ------------------------------------------------------------------------------------------- feature directory

export interface Feature {
  id: string;
  title: string;
  description: string;
  keywords: string;
  area: 'Timesheet' | 'LMS' | 'Assistant';
  roles?: Role[];
  to?: string;
  lms?: LmsPageName;
  node?: 'plan' | 'attention';
}

export const FEATURES: Feature[] = [
  // Associate
  { id: 'a-dash', area: 'Timesheet', roles: ['associate'], to: '/associate/dashboard', title: 'Dashboard', description: 'Your week at a glance: hours, target and notifications', keywords: 'home overview summary week target' },
  { id: 'a-ts', area: 'Timesheet', roles: ['associate'], to: '/associate/timesheet', title: 'My Timesheet', description: 'Log project hours and submit your week', keywords: 'timesheet log hours enter time fill submit week weekly' },
  { id: 'a-subs', area: 'Timesheet', roles: ['associate'], to: '/associate/submissions', title: 'My Submissions', description: 'Submitted weeks and their approval status', keywords: 'submissions submitted history approval status returned rejected approved' },
  { id: 'a-proj', area: 'Timesheet', roles: ['associate'], to: '/associate/projects', title: 'My Projects', description: 'Projects you are allocated to and your weekly hours on each', keywords: 'projects allocation allocated assigned client manager' },
  { id: 'a-cal', area: 'Timesheet', roles: ['associate'], to: '/associate/calendar', title: 'My Calendar', description: 'Your working days and holidays', keywords: 'calendar holidays holiday working days public' },
  { id: 'a-leave', area: 'Timesheet', roles: ['associate'], to: '/associate/leave', title: 'Leave Requests', description: 'Apply for leave and track its status', keywords: 'leave leaves vacation apply time off sick absence request' },
  { id: 'a-ot', area: 'Timesheet', roles: ['associate'], to: '/associate/overtime', title: 'Overtime', description: 'Request overtime for extra hours', keywords: 'overtime ot extra hours additional' },
  // Manager
  { id: 'm-dash', area: 'Timesheet', roles: ['manager'], to: '/manager/dashboard', title: 'Dashboard', description: "Your team's hours and pending work", keywords: 'home overview summary' },
  { id: 'm-team', area: 'Timesheet', roles: ['manager'], to: '/manager/team', title: 'My Team', description: 'Your team members and their allocations', keywords: 'team members people reports employees staff' },
  { id: 'm-alloc', area: 'Timesheet', roles: ['manager'], to: '/manager/allocation', title: 'Project Allocation', description: 'Allocate people to your projects', keywords: 'allocation allocate assign capacity resources projects' },
  { id: 'm-appr', area: 'Timesheet', roles: ['manager'], to: '/manager/approvals', title: 'Timesheet Approvals', description: 'Review and approve submitted hours', keywords: 'approvals approve review timesheets submitted hours pending' },
  { id: 'm-ot', area: 'Timesheet', roles: ['manager'], to: '/manager/overtime', title: 'Overtime Approvals', description: 'Decide on overtime requests', keywords: 'overtime ot approve extra hours' },
  { id: 'm-rep', area: 'Timesheet', roles: ['manager'], to: '/manager/reports', title: 'Reports', description: 'Hours and allocation reports for your projects', keywords: 'reports report analytics hours export utilisation utilization' },
  { id: 'm-cal', area: 'Timesheet', roles: ['manager'], to: '/manager/calendar', title: 'Team Calendar', description: "Your team's leave and holidays", keywords: 'calendar team leave holidays absence' },
  // Admin
  { id: 'ad-dash', area: 'Timesheet', roles: ['admin'], to: '/admin/dashboard', title: 'Dashboard', description: 'Organisation overview', keywords: 'home overview summary organisation organization' },
  { id: 'ad-emp', area: 'Timesheet', roles: ['admin'], to: '/admin/employees', title: 'Employees', description: 'Add and manage employee accounts', keywords: 'employees employee users people staff add account password' },
  { id: 'ad-proj', area: 'Timesheet', roles: ['admin'], to: '/admin/projects', title: 'Projects', description: 'Create and manage client projects', keywords: 'projects project clients create' },
  { id: 'ad-alloc', area: 'Timesheet', roles: ['admin'], to: '/admin/allocations', title: 'Resource Allocation', description: 'Allocate people to projects', keywords: 'allocation allocate resources assign capacity' },
  { id: 'ad-ts', area: 'Timesheet', roles: ['admin'], to: '/admin/timesheets', title: 'Timesheets', description: 'Every submitted timesheet', keywords: 'timesheets timesheet hours all' },
  { id: 'ad-appr', area: 'Timesheet', roles: ['admin'], to: '/admin/approvals', title: 'Approvals', description: 'Timesheet, overtime and leave approvals', keywords: 'approvals approve review pending leave overtime' },
  { id: 'ad-cal', area: 'Timesheet', roles: ['admin'], to: '/admin/calendars', title: 'Calendars', description: 'Holiday calendars and working days', keywords: 'calendars calendar holidays holiday working days' },
  { id: 'ad-ot', area: 'Timesheet', roles: ['admin'], to: '/admin/overtime-policies', title: 'Overtime & Policies', description: 'Overtime rules, eligibility and policy documents', keywords: 'overtime policies policy rules eligibility ot' },
  { id: 'ad-rep', area: 'Timesheet', roles: ['admin'], to: '/admin/reports', title: 'Reports & Analytics', description: 'Hours, allocation and overtime reports', keywords: 'reports report analytics export utilisation utilization' },
  { id: 'ad-set', area: 'Timesheet', roles: ['admin'], to: '/admin/settings', title: 'Settings', description: 'Organisation settings', keywords: 'settings configuration organisation organization setup' },
  // LMS (everyone)
  { id: 'l-my', area: 'LMS', lms: 'courses', title: 'My Learning', description: "Courses you're taking and your progress", keywords: 'my learning courses enrolled progress continue resume' },
  { id: 'l-cat', area: 'LMS', lms: 'catalog', title: 'Course Catalog', description: 'Browse every available course', keywords: 'catalog catalogue browse courses all' },
  { id: 'l-cert', area: 'LMS', lms: 'certificates', title: 'Certificates', description: 'Certificates you have earned', keywords: 'certificates certificate earned completion' },
  { id: 'l-live', area: 'LMS', lms: 'calendar', title: 'Live Training', description: 'Upcoming live sessions and workshops', keywords: 'live training sessions session workshop webinar schedule class' },
  { id: 'l-assess', area: 'LMS', lms: 'assessments', title: 'Assessments', description: 'Quizzes and exams to take', keywords: 'assessments assessment exam exams quiz test tests' },
  // Assistant
  { id: 'b-plan', area: 'Assistant', node: 'plan', title: 'Plan a leave', description: 'Clash-free dates with your team, sent for you', keywords: 'plan leave suggest dates clash team' },
  { id: 'b-att', area: 'Assistant', node: 'attention', title: 'What needs my attention?', description: 'Pending items and reminders', keywords: 'attention pending notifications alerts reminders todo' },
];

export function featuresFor(role: Role, withLms: boolean): Feature[] {
  return FEATURES.filter((f) => (!f.roles || f.roles.includes(role)) && (withLms || f.area !== 'LMS'));
}

/** Best-matching features for the text: title words count most, then keywords, then the description. */
export function searchFeatures(text: string, role: Role, withLms: boolean, max = 4): Feature[] {
  const asked = significant(text).filter((w) => w.length >= 2 && !/^(where|find|open|go|see|page|take|need|help)$/.test(w));
  if (!asked.length) return [];
  const has = (hay: string, w: string) => words(hay).some((h) => h === w || (w.length >= 4 && (h.startsWith(w) || w.startsWith(h)) && h.length >= 4));
  return featuresFor(role, withLms)
    .map((f) => ({ f, score: asked.reduce((s, w) => s + (has(f.title, w) ? 3 : has(f.keywords, w) ? 2 : has(f.description, w) ? 1 : 0), 0) }))
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score)
    .filter((x, _i, all) => x.score >= all[0]!.score * 0.7)
    .slice(0, max)
    .map((x) => x.f);
}

export const asksWhatICanDo = (text: string) =>
  /\b(what can you do|what do you do|features?|everything|capabilit\w*|what can i (do|find|see)|show me around|all options)\b/i.test(text);
