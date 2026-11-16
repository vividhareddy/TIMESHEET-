import { PageHeader } from '@/components/common/Misc';
import { AllocationBoard } from '@/components/allocation/AllocationBoard';

export function AllocationsPage() {
  return (
    <div>
      <PageHeader title="Resource Allocation" description="Allocate employees across projects and monitor allocation against weekly capacity." />
      <AllocationBoard />
    </div>
  );
}
