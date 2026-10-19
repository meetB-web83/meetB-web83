import { useSearchParams } from 'react-router-dom';
import { useProjects } from '../../hooks/useProjects';
import { ProjectSelect, ScopeProject } from './ProjectSelect';

/**
 * Dashboard scope picker bound to the `?scope=` URL param (shareable, bookmarkable).
 * Null/absent scope means all projects. Rendered in the top nav on the home route.
 * Accepts an optional `projects` list (e.g. from `useDashboard`) to avoid a
 * duplicate fetch; falls back to `useProjects()` when used standalone in the nav.
 */
export function ScopeSelect({ projects: projectsProp }: { projects?: ScopeProject[] }) {
  const { projects: fetched } = useProjects();
  const projects = projectsProp ?? fetched;
  const [params, setParams] = useSearchParams();
  const scope = params.get('scope');

  const handleChange = (projectId: string | null) => {
    if (projectId) setParams({ scope: projectId });
    else setParams({});
  };

  return (
    <ProjectSelect
      projects={projects.map((p) => ({ id: p.id, name: p.name, available: p.available }))}
      value={scope}
      onChange={handleChange}
    />
  );
}
