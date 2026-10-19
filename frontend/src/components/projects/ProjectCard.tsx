import { Link } from 'react-router-dom';
import { Project } from '../../hooks/useProjects';
import { formatDate } from '../../lib/format';

interface ProjectCardProps {
  project: Project;
}

export function ProjectCard({ project }: ProjectCardProps) {
  return (
    <Link to={`/projects/${project.id}`} className="project-card">
      <div className="project-card-icon">
        <span>{project.name.charAt(0).toUpperCase()}</span>
      </div>
      <div className="project-card-content">
        <h3 className="project-card-title">{project.name}</h3>
        {project.description && <p className="project-card-desc">{project.description}</p>}
        <span className="project-card-date">Created {formatDate(project.created_at)}</span>
      </div>
    </Link>
  );
}
