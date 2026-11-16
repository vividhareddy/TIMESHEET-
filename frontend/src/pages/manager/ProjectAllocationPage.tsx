import { PageHeader, EmptyState } from '@/components/common/Misc';
import { Card } from '@/components/common/Card';
import { AllocationBoard } from '@/components/allocation/AllocationBoard';
import { useManagedProjects } from '@/hooks/useLookups';

export function ProjectAllocationPage() {
  const projects = useManagedProjects();
  return (
    <div>
      <PageHeader title="Project Allocation" description="Allocate team members to your projects. Capacity includes their allocations on other projects." />
      {projects.length ? (
        <AllocationBoard projectIds={projects.map((p) => p.id)} />
      ) : (
        <Card><EmptyState title="No projects assigned" description="You are not the project manager of any project." /></Card>
      )}
    </div>
  );
}
