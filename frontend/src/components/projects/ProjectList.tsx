import { Project } from '../../hooks/useProjects';
import { ProjectCard } from './ProjectCard';
import { Spinner } from '../ui/Spinner';
import { EmptyState } from '../ui/EmptyState';

interface ProjectListProps {
  projects: Project[];
  loading: boolean;
  error: string | null;
}

export function ProjectList({ projects, loading, error }: ProjectListProps) {
  if (loading) return <Spinner />;
  if (error) return <EmptyState title="Error loading projects" description={error} />;
  if (projects.length === 0) return <EmptyState title="No projects found" description="Projects will appear here when created." />;

  return (
    <div className="project-grid">
      {projects.map((project) => (
        <ProjectCard key={project.id} project={project} />
      ))}
    </div>
  );
}
