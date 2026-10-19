import { Link } from 'react-router-dom';
import { PageHeader } from '../components/layout/PageHeader';
import { Button } from '../components/ui/Button';

interface Endpoint {
  method: string;
  path: string;
  description: string;
}

const groups: Array<{ tag: string; title: string; endpoints: Endpoint[] }> = [
  {
    tag: '</projects>',
    title: 'Projects',
    endpoints: [
      { method: 'POST', path: '/api/projects', description: 'Register a folder. Idempotent by root path; initializes <root>/.workjournal/.' },
      { method: 'GET', path: '/api/projects', description: 'List registered projects with folder availability.' },
      { method: 'GET', path: '/api/projects/browse?path=&search=', description: 'Browse folders with full paths for the folder picker. Empty path lists drives/roots.' },
      { method: 'GET', path: '/api/projects/:id', description: 'Fetch one project.' },
      { method: 'PATCH', path: '/api/projects/:id', description: 'Rename or re-describe a project.' },
    ],
  },
  {
    tag: '<task-lifecycle>',
    title: 'Tasks',
    endpoints: [
      { method: 'POST', path: '/api/tasks', description: 'Create a task. Requires agent_id and idempotency_key.' },
      { method: 'GET', path: '/api/tasks', description: 'List tasks. project_id optional — omitted means all projects, newest first. Filters: status, priority, limit, offset.' },
      { method: 'GET', path: '/api/tasks/:id', description: 'Fetch one task with status, owner and version.' },
      { method: 'PATCH', path: '/api/tasks/:id', description: 'Update title, objective, priority or acceptance criteria.' },
      { method: 'POST', path: '/api/tasks/:id/claim', description: 'Claim an open task, or recover an interrupted one.' },
      { method: 'POST', path: '/api/tasks/:id/release', description: 'Release a task you own back to open.' },
      { method: 'POST', path: '/api/tasks/:id/transition', description: 'Move status. target_status with reason / resolution_note where required.' },
    ],
  },
  {
    tag: '<checkpoint>',
    title: 'Checkpoints & decisions',
    endpoints: [
      { method: 'POST', path: '/api/checkpoints', description: 'Record progress against the version you last read.' },
      { method: 'GET', path: '/api/checkpoints?task_id=', description: 'List checkpoints, newest first.' },
      { method: 'POST', path: '/api/decisions', description: 'Record a decision with rationale and alternatives.' },
      { method: 'GET', path: '/api/decisions?task_id=&include_superseded=', description: 'List decisions; pass include_superseded=true for history.' },
      { method: 'POST', path: '/api/decisions/:id/supersede', description: 'Replace a decision; the old record is preserved.' },
    ],
  },
  {
    tag: '[resume]',
    title: 'Read-back & export',
    endpoints: [
      { method: 'GET', path: '/api/events?task_id=', description: 'Append-only event history, chronological.' },
      { method: 'GET', path: '/api/resume?task_id=', description: 'Deterministic resume context for the next session.' },
      { method: 'GET', path: '/api/export/json?task_id=', description: 'Machine-readable handoff (secrets filtered).' },
      { method: 'GET', path: '/api/export/markdown?task_id=', description: 'Human-readable handoff as Markdown.' },
    ],
  },
];

const errors = [
  { code: 'VALIDATION_ERROR · 400', meaning: 'Input failed Zod validation — the message names the field.' },
  { code: 'NOT_FOUND · 404', meaning: 'Unknown task, project, checkpoint or decision — or an unavailable project folder.' },
  { code: 'IDEMPOTENCY_KEY_CONFLICT · 409', meaning: 'Key reused with different input, operation or actor. Retry with the identical call or a fresh key.' },
  { code: 'STALE_VERSION · 409', meaning: 'expected_version is behind. Re-read the task and retry.' },
  { code: 'INVALID_TRANSITION · 422', meaning: 'The status move is not allowed from the current state.' },
];

export function ApiReferencePage() {
  return (
    <div className="page">
      <div className="container">
        <PageHeader
          title="API Reference"
          description="Every write needs an idempotency_key. Task writes also need agent_id (<agent-string>_<project-id>) and the expected_version you last read."
          kicker="</api>"
          actions={
            <Link to="/docs">
              <Button variant="secondary">Documentation</Button>
            </Link>
          }
        />

        {groups.map((g) => (
          <div key={g.title} className="mt-lg">
            <h2 className="section-subtitle">
              <span className="code-tag">{g.tag}</span> {g.title}
            </h2>
            <div className="doc-table-wrap">
              <table className="doc-table">
                <thead>
                  <tr>
                    <th>Method</th>
                    <th>Path</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {g.endpoints.map((e) => (
                    <tr key={`${e.method} ${e.path}`}>
                      <td>
                        <span className="code-tag code-tag-mint">{e.method}</span>
                      </td>
                      <td className="doc-path">{e.path}</td>
                      <td>{e.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}

        <div className="mt-xl">
          <h2 className="section-subtitle">Errors</h2>
          <div className="doc-table-wrap">
            <table className="doc-table">
              <tbody>
                {errors.map((e) => (
                  <tr key={e.code}>
                    <td>
                      <span className="code-tag code-tag-ghost">{e.code}</span>
                    </td>
                    <td>{e.meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
