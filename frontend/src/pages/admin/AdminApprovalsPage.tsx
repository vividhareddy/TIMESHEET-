import { useSearchParams } from 'react-router-dom';
import { useAppData } from '@/context/AppDataContext';
import { PageHeader, Tabs, Alert } from '@/components/common/Misc';
import { Card } from '@/components/common/Card';
import { ApprovalBoard } from '@/components/timesheet/ApprovalBoard';
import { LeaveRequestTable } from '@/components/tables/LeaveRequestTable';
import { OvertimeTable } from '@/components/tables/OvertimeTable';
import { Info } from 'lucide-react';

type Tab = 'timesheets' | 'leave' | 'overtime';

export function AdminApprovalsPage() {
  const { timesheets, leaves, overtime } = useAppData();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'timesheets';

  const pendingEntries = timesheets.flatMap((t) => t.entries).filter((e) => e.status === 'pending').length;

  return (
    <div>
      <PageHeader title="Approvals" description="Organisation-wide view of timesheet, leave and overtime approvals." />
      <Tabs
        value={tab}
        onChange={(t) => setParams(t === 'timesheets' ? {} : { tab: t })}
        options={[
          { value: 'timesheets', label: 'Timesheet entries', count: pendingEntries },
          { value: 'leave', label: 'Leave requests', count: leaves.filter((l) => l.status === 'pending').length },
          { value: 'overtime', label: 'Overtime', count: overtime.filter((o) => o.status === 'pending').length },
        ]}
      />
      {tab === 'timesheets' && (
        <>
          <Alert tone="info" icon={Info} className="mb-4">
            Project managers approve entries for their own projects. As an administrator you can act on any entry as an authorised override — actions are recorded in the history under your name.
          </Alert>
          <ApprovalBoard />
        </>
      )}
      {tab === 'leave' && (
        <Card>
          <LeaveRequestTable leaves={leaves} />
        </Card>
      )}
      {tab === 'overtime' && (
        <Card>
          <OvertimeTable records={overtime} reviewable />
        </Card>
      )}
    </div>
  );
}
