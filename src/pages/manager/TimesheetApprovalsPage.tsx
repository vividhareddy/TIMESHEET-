import { useManagedProjects } from '@/hooks/useLookups';
import { PageHeader } from '@/components/common/Misc';
import { ApprovalBoard } from '@/components/timesheet/ApprovalBoard';

export function TimesheetApprovalsPage() {
  const projects = useManagedProjects();
  return (
    <div>
      <PageHeader
        title="Timesheet Approvals"
        description={`Entries for the projects you manage: ${projects.map((p) => p.name).join(', ') || 'none'}. Other project hours on the same timesheet are approved by their own PM.`}
      />
      <ApprovalBoard projectIds={projects.map((p) => p.id)} />
    </div>
  );
}
