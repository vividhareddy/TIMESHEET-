import { useState } from 'react';
import { CheckCircle2, Hourglass, Timer } from 'lucide-react';
import { useAppData } from '@/context/AppDataContext';
import { useManagedProjects, useReferenceData } from '@/hooks/useLookups';
import { formatHours, sum } from '@/utils/format';
import { PageHeader, Segmented } from '@/components/common/Misc';
import { Card } from '@/components/common/Card';
import { StatCard } from '@/components/common/StatCard';
import { OvertimeTable } from '@/components/tables/OvertimeTable';

export function OvertimeApprovalsPage() {
  const projects = useManagedProjects();
  const ref = useReferenceData();
  const { overtime, policy } = useAppData();
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending');
  const ids = new Set(projects.map((p) => p.id));
  const mine = overtime.filter((o) => ids.has(o.projectId));
  const shown = mine.filter((o) => status === 'all' || o.status === status);
  const hrs = (s: string) => sum(mine.filter((o) => o.status === s).map((o) => o.hours));

  return (
    <div>
      <PageHeader title="Overtime Approvals" description={`Additional hours on your projects. Weekday overtime is paid at ${policy.weekdayMultiplier}×, weekend/holiday at ${policy.weekendMultiplier}×.`} />
      <div className="mb-5 grid grid-cols-2 gap-4 xl:grid-cols-3">
        <StatCard label="Pending" value={formatHours(hrs('pending'))} icon={Hourglass} tone="amber" hint={`${mine.filter((o) => o.status === 'pending').length} requests`} />
        <StatCard label="Approved" value={formatHours(hrs('approved'))} icon={CheckCircle2} tone="green" />
        <StatCard label="Total records" value={mine.length} icon={Timer} tone="slate" />
      </div>
      <Segmented
        className="mb-4"
        value={status}
        onChange={setStatus}
        options={[...ref.requestStatuses.map((o) => ({ value: o.value, label: o.label, count: o.value === 'pending' ? mine.filter((x) => x.status === 'pending').length : undefined })), { value: 'all' as const, label: 'All' }]}
      />
      <Card>
        <OvertimeTable records={shown} reviewable emptyTitle={status === 'pending' ? 'No overtime awaiting approval' : 'No records'} />
      </Card>
    </div>
  );
}
