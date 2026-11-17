/**
 * Who may earn overtime. The organisation policy names the eligible departments (or all of them),
 * and an administrator can override that for an individual employee.
 */
export type OvertimeEligibility = 'inherit' | 'eligible' | 'not_eligible';
export const OVERTIME_ELIGIBILITY: readonly OvertimeEligibility[] = ['inherit', 'eligible', 'not_eligible'];

export interface EligibilityPolicy {
  enabled: boolean;
  eligibilityScope: 'all' | 'departments';
  eligibleDepartments: string[];
}

export interface EligibilityResult {
  eligible: boolean;
  /** Plain-language explanation shown to the employee (and given to the OT assistant). */
  reason: string;
}

export function overtimeEligibility(
  employee: { department: string; overtimeEligibility: OvertimeEligibility },
  policy: EligibilityPolicy,
): EligibilityResult {
  if (!policy.enabled) return { eligible: false, reason: 'Overtime is not enabled in your organisation’s overtime policy.' };
  if (employee.overtimeEligibility === 'eligible') return { eligible: true, reason: 'An administrator has made you individually eligible for overtime.' };
  if (employee.overtimeEligibility === 'not_eligible') return { eligible: false, reason: 'An administrator has marked you as not eligible for overtime.' };
  if (policy.eligibilityScope === 'all') return { eligible: true, reason: 'All departments are eligible for overtime.' };
  const department = employee.department || 'your department';
  return policy.eligibleDepartments.includes(employee.department)
    ? { eligible: true, reason: `${department} is an overtime-eligible department.` }
    : { eligible: false, reason: `${department} is not one of the overtime-eligible departments.` };
}
