import { useManagedProjects } from '@/hooks/useLookups';
import { PageHeader } from '@/components/common/Misc';
import { ReportsView } from '@/components/reports/ReportsView';

export function ManagerReportsPage() {
  const projects = useManagedProjects();
  return (
    <div>
      <PageHeader title="Reports" description="Hours, allocation and approvals for the projects you manage." />
      <ReportsView projectIds={projects.map((p) => p.id)} />
    </div>
  );
}
