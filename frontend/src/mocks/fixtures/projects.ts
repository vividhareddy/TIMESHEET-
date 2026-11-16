/** DEVELOPMENT ONLY — fictitious sample projects and allocations for the mock API. */
import type { Allocation, Project } from '@/types';

export const seedProjects: Project[] = [
  {
    id: 'prj-kore',
    code: 'PRJ-KOR',
    name: 'Kore.ai',
    client: 'Kore.ai Inc.',
    description: 'Conversational AI platform — virtual assistant build-out, NLU training and integration services.',
    managerId: 'emp-02',
    startDate: '2025-04-01',
    endDate: '2027-03-31',
    status: 'active',
    billable: true,
    color: '#3b6db3',
  },
  {
    id: 'prj-zelis',
    code: 'PRJ-ZEL',
    name: 'Zelis',
    client: 'Zelis Healthcare',
    description: 'Healthcare payments modernisation — claims pricing APIs, provider payments portal and UAT support.',
    managerId: 'emp-03',
    startDate: '2025-01-15',
    endDate: '2026-12-31',
    status: 'active',
    billable: true,
    color: '#0f8a7a',
  },
  {
    id: 'prj-uber',
    code: 'PRJ-UBR',
    name: 'Uber',
    client: 'Uber Technologies',
    description: 'Driver operations analytics — onboarding dashboards, data pipelines and quality assurance.',
    managerId: 'emp-04',
    startDate: '2025-06-01',
    endDate: '2027-05-31',
    status: 'active',
    billable: true,
    color: '#7a5bb8',
  },
];


const a = (
  id: string,
  employeeId: string,
  projectId: string,
  weeklyHours: number,
  projectRole: string,
  startDate = '2025-07-01',
  endDate = '2026-12-31',
): Allocation => ({ id, employeeId, projectId, weeklyHours, projectRole, startDate, endDate });

export const seedAllocations: Allocation[] = [
  a('alc-01', 'emp-05', 'prj-kore', 20, 'Lead Developer'),
  a('alc-02', 'emp-05', 'prj-zelis', 12, 'Developer'),
  a('alc-03', 'emp-05', 'prj-uber', 8, 'Developer'),
  a('alc-04', 'emp-06', 'prj-kore', 24, 'QA Engineer'),
  a('alc-05', 'emp-06', 'prj-uber', 16, 'QA Engineer'),
  a('alc-06', 'emp-07', 'prj-zelis', 40, 'Business Analyst', '2025-03-01', '2026-12-31'),
  a('alc-07', 'emp-08', 'prj-uber', 24, 'Data Engineer'),
  a('alc-08', 'emp-08', 'prj-zelis', 16, 'Data Engineer'),
  a('alc-09', 'emp-09', 'prj-kore', 20, 'UI Developer'),
  a('alc-10', 'emp-09', 'prj-zelis', 20, 'UI Developer'),
  a('alc-11', 'emp-10', 'prj-kore', 16, 'DevOps Engineer'),
  a('alc-12', 'emp-10', 'prj-uber', 16, 'DevOps Engineer'),
  a('alc-13', 'emp-11', 'prj-uber', 32, 'Product Analyst'),
  a('alc-14', 'emp-11', 'prj-kore', 16, 'Product Analyst'),
  a('alc-15', 'emp-12', 'prj-zelis', 24, 'Software Engineer'),
  a('alc-16', 'emp-12', 'prj-kore', 16, 'Software Engineer'),
];
