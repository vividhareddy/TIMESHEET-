import type { Employee, OvertimeEligibilityStatus, OvertimePolicy } from '@/types';

/** Same rule as backend/src/lib/overtimeEligibility.ts (the server's answer is authoritative). */
export function overtimeEligibility(employee: Pick<Employee, 'department' | 'overtimeEligibility'>, policy: OvertimePolicy): OvertimeEligibilityStatus {
  if (!policy.enabled) return { eligible: false, reason: 'Overtime is not enabled in your organisation’s overtime policy.' };
  if (employee.overtimeEligibility === 'eligible') return { eligible: true, reason: 'An administrator has made you individually eligible for overtime.' };
  if (employee.overtimeEligibility === 'not_eligible') return { eligible: false, reason: 'An administrator has marked you as not eligible for overtime.' };
  if ((policy.eligibilityScope ?? 'all') === 'all') return { eligible: true, reason: 'All departments are eligible for overtime.' };
  const department = employee.department || 'your department';
  return (policy.eligibleDepartments ?? []).includes(employee.department)
    ? { eligible: true, reason: `${department} is an overtime-eligible department.` }
    : { eligible: false, reason: `${department} is not one of the overtime-eligible departments.` };
}
