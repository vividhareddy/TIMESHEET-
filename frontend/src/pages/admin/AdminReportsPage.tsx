import { PageHeader } from '@/components/common/Misc';
import { ReportsView } from '@/components/reports/ReportsView';

export function AdminReportsPage() {
  return (
    <div>
      <PageHeader title="Reports & Analytics" description="Hours, allocation utilisation, approvals and overtime across the organisation." />
      <ReportsView />
    </div>
  );
}
