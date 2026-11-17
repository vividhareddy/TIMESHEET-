/** DEVELOPMENT ONLY — fictitious sample employees for the mock API. */
import type { Employee } from '@/types';

const base = { weeklyCapacity: 40, status: 'active' as const, overtimeEligibility: 'inherit' as const };

export const seedEmployees: Employee[] = [
  { ...base, id: 'emp-01', employeeCode: 'EMP1001', name: 'Priya Sharma', email: 'priya.sharma@northwind-tech.com', phone: '+91 98450 11201', department: 'Operations', designation: 'Resource Management Lead', workLocation: 'Hyderabad', country: 'IN', calendarId: 'cal-in', managerId: null, systemRole: 'admin', joinDate: '2019-04-15' },
  { ...base, id: 'emp-02', employeeCode: 'EMP1002', name: 'Rahul Mehta', email: 'rahul.mehta@northwind-tech.com', phone: '+91 98480 22114', department: 'Delivery', designation: 'Project Manager', workLocation: 'Hyderabad', country: 'IN', calendarId: 'cal-in', managerId: 'emp-01', systemRole: 'manager', joinDate: '2018-07-02' },
  { ...base, id: 'emp-03', employeeCode: 'EMP1003', name: 'Sarah Johnson', email: 'sarah.johnson@northwind-tech.com', phone: '+1 214 555 0148', department: 'Delivery', designation: 'Senior Project Manager', workLocation: 'Dallas, TX', country: 'US', calendarId: 'cal-us', managerId: 'emp-01', systemRole: 'manager', joinDate: '2017-02-20' },
  { ...base, id: 'emp-04', employeeCode: 'EMP1004', name: 'Michael Chen', email: 'michael.chen@northwind-tech.com', phone: '+1 415 555 0192', department: 'Delivery', designation: 'Project Manager', workLocation: 'San Francisco, CA', country: 'US', calendarId: 'cal-us', managerId: 'emp-01', systemRole: 'manager', joinDate: '2020-09-14' },
  { ...base, id: 'emp-05', employeeCode: 'EMP1005', name: 'Ananya Reddy', email: 'ananya.reddy@northwind-tech.com', phone: '+91 99890 45012', department: 'Engineering', designation: 'Senior Software Engineer', workLocation: 'Hyderabad', country: 'IN', calendarId: 'cal-in', managerId: 'emp-02', systemRole: 'associate', joinDate: '2021-01-11' },
  { ...base, id: 'emp-06', employeeCode: 'EMP1006', name: 'Vikram Nair', email: 'vikram.nair@northwind-tech.com', phone: '+91 97400 33871', department: 'Quality Engineering', designation: 'QA Engineer', workLocation: 'Bengaluru', country: 'IN', calendarId: 'cal-in', managerId: 'emp-02', systemRole: 'associate', joinDate: '2022-06-06' },
  { ...base, id: 'emp-07', employeeCode: 'EMP1007', name: 'Emily Davis', email: 'emily.davis@northwind-tech.com', phone: '+1 469 555 0133', department: 'Business Analysis', designation: 'Business Analyst', workLocation: 'Dallas, TX', country: 'US', calendarId: 'cal-us', managerId: 'emp-03', systemRole: 'associate', joinDate: '2022-03-21' },
  { ...base, id: 'emp-08', employeeCode: 'EMP1008', name: 'James Wilson', email: 'james.wilson@northwind-tech.com', phone: '+1 512 555 0177', department: 'Data Engineering', designation: 'Data Engineer', workLocation: 'Austin, TX', country: 'US', calendarId: 'cal-us', managerId: 'emp-04', systemRole: 'associate', joinDate: '2021-10-04' },
  { ...base, id: 'emp-09', employeeCode: 'EMP1009', name: 'Kavya Iyer', email: 'kavya.iyer@northwind-tech.com', phone: '+91 90000 51234', department: 'Engineering', designation: 'UI Developer', workLocation: 'Hyderabad', country: 'IN', calendarId: 'cal-in', managerId: 'emp-02', systemRole: 'associate', joinDate: '2023-02-13' },
  { ...base, id: 'emp-10', employeeCode: 'EMP1010', name: 'Arjun Patel', email: 'arjun.patel@northwind-tech.com', phone: '+91 98220 61890', department: 'Cloud & DevOps', designation: 'DevOps Engineer', workLocation: 'Pune', country: 'IN', calendarId: 'cal-in', managerId: 'emp-02', systemRole: 'associate', joinDate: '2022-11-28' },
  { ...base, id: 'emp-11', employeeCode: 'EMP1011', name: 'Olivia Martinez', email: 'olivia.martinez@northwind-tech.com', phone: '+1 646 555 0110', department: 'Product', designation: 'Product Analyst', workLocation: 'New York, NY', country: 'US', calendarId: 'cal-us', managerId: 'emp-04', systemRole: 'associate', joinDate: '2023-05-08' },
  { ...base, id: 'emp-12', employeeCode: 'EMP1012', name: 'Sneha Kulkarni', email: 'sneha.kulkarni@northwind-tech.com', phone: '+91 97010 72245', department: 'Engineering', designation: 'Software Engineer', workLocation: 'Hyderabad', country: 'IN', calendarId: 'cal-in', managerId: 'emp-03', systemRole: 'associate', joinDate: '2024-01-15' },
  { ...base, id: 'emp-13', employeeCode: 'EMP1013', name: 'David Brown', email: 'david.brown@northwind-tech.com', phone: '+1 312 555 0164', department: 'Engineering', designation: 'Software Engineer', workLocation: 'Chicago, IL', country: 'US', calendarId: 'cal-us', managerId: 'emp-03', systemRole: 'associate', joinDate: '2020-08-17', status: 'inactive' },
];

export const SAMPLE_DEPARTMENTS = [
  'Engineering',
  'Quality Engineering',
  'Data Engineering',
  'Cloud & DevOps',
  'Business Analysis',
  'Product',
  'Delivery',
  'Operations',
];

export const SAMPLE_WORK_LOCATIONS: Array<{ label: string; country: 'US' | 'IN' }> = [
  { label: 'Hyderabad', country: 'IN' },
  { label: 'Bengaluru', country: 'IN' },
  { label: 'Pune', country: 'IN' },
  { label: 'Chennai', country: 'IN' },
  { label: 'Dallas, TX', country: 'US' },
  { label: 'Austin, TX', country: 'US' },
  { label: 'San Francisco, CA', country: 'US' },
  { label: 'New York, NY', country: 'US' },
  { label: 'Chicago, IL', country: 'US' },
];
