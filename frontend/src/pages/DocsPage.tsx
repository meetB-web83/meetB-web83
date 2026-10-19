import { Link } from 'react-router-dom';
import { PageHeader } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';

const concepts = [
  {
    tag: '</project>',
    title: 'Projects',
    body: 'A project is a folder on your machine. Each project owns its own SQLite database at <root>/.workjournal/workjournal.db — tasks, events, checkpoints and decisions never leave that folder.',
  },
  {
    tag: '<task-lifecycle>',
    title: 'Tasks',
    body: 'Tasks move open → in_progress → completed, with blocked, interrupted and cancelled on the side. One transition function owns every status change; every change is validated, version-checked and recorded as an event.',
  },
  {
    tag: '<checkpoint>',
    title: 'Checkpoints',
    body: 'A checkpoint freezes working memory: what is done, current findings, unresolved issues and next steps. The next session resumes from the latest checkpoint instead of re-deriving everything.',
  },
  {
    tag: '<decision>',
    title: 'Decisions',
    body: 'Decisions outlive the conversation that made them. Each records the statement, the rationale and the rejected alternatives. Superseding keeps the old record and links the replacement.',
  },
  {
    tag: '<event>',
    title: 'Events',
    body: 'Every state change appends a monotonic, append-only event. History is never rewritten — the event log is the audit trail of the task.',
  },
  {
    tag: '[resume]',
    title: 'Resume context',
    body: 'A deterministic brief for the next agent: identity, latest checkpoint, active decisions, progress, unresolved issues and recent events. Same records, same brief, every time.',
  },
];

export function DocsPage() {
  return (
    <div className="page">
      <div className="container">
        <PageHeader
          title="Documentation"
          description="How WorkJournal keeps task progress alive across AI coding-agent sessions."
          kicker="</docs>"
          actions={
            <Link to="/docs/api">
              <Button variant="primary">API Reference</Button>
            </Link>
          }
        />

        <div className="task-grid">
          {concepts.map((c) => (
            <div key={c.title} className="task-card">
              <div className="task-card-header">
                <span className="code-tag">{c.tag}</span>
              </div>
              <div className="task-card-body">
                <h3 className="task-card-title">{c.title}</h3>
                <p className="task-card-objective">{c.body}</p>
              </div>
            </div>
          ))}
        </div>

        <Card variant="light" className="mt-xl">
          <h3 className="card-title">Agent workflow</h3>
          <ul className="criteria-list">
            <li>Propose your agent string, then claim a task (open → in_progress, or recover an interrupted one).</li>
            <li>Record checkpoints as you work; log decisions with rationale and alternatives.</li>
            <li>Complete, block, interrupt or release with a fresh idempotency key on every write.</li>
            <li>Read the resume context before assuming you remember the work.</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
