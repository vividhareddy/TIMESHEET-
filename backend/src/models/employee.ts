export type Role = 'admin' | 'manager' | 'associate';
export const ROLES: readonly Role[] = ['admin', 'manager', 'associate'];

/** The Employee shape the frontend expects (src/types/index.ts). Never includes the password hash. */
export interface Employee {
  id: string;
  employeeCode: string;
  name: string;
  email: string;
  phone: string;
  department: string;
  designation: string;
  workLocation: string;
  country: string;
  calendarId: string;
  managerId: string | null;
  systemRole: Role;
  status: 'active' | 'inactive';
  weeklyCapacity: number;
  joinDate: string;
}

export interface EmployeeRow {
  id: string;
  employee_code: string;
  name: string;
  email: string;
  phone: string;
  department: string;
  designation: string;
  work_location: string;
  country: string;
  calendar_id: string | null;
  manager_id: string | null;
  system_role: Role;
  status: 'active' | 'inactive';
  weekly_capacity: string;
  join_date: string;
}

/** Column list for SELECT / RETURNING that matches EmployeeRow. */
export const EMPLOYEE_COLUMNS = `id, employee_code, name, email, phone, department, designation, work_location, country,
  calendar_id, manager_id, system_role, status, weekly_capacity, to_char(join_date, 'YYYY-MM-DD') AS join_date`;

export function toEmployee(r: EmployeeRow): Employee {
  return {
    id: r.id,
    employeeCode: r.employee_code,
    name: r.name,
    email: r.email,
    phone: r.phone,
    department: r.department,
    designation: r.designation,
    workLocation: r.work_location,
    country: r.country,
    calendarId: r.calendar_id ?? '',
    managerId: r.manager_id,
    systemRole: r.system_role,
    status: r.status,
    weeklyCapacity: Number(r.weekly_capacity),
    joinDate: r.join_date,
  };
}
