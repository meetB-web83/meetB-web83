import { useParams, Link } from 'react-router-dom';
import { useResumeContext } from '../hooks/useResumeContext';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';

export function ResumeContextPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const { context, loading, error } = useResumeContext(taskId!);

  if (loading) return <Spinner />;
  if (error) return <div className="container"><p>Error: {error}</p></div>;

  return (
    <div className="page">
      <div className="container">
        <div className="page-header">
          <div className="page-header-text">
            <div className="page-kicker">
              <span className="code-tag">{"</resume>"}</span>
            </div>
            <h1 className="page-title">Resume Context</h1>
            <p className="page-description">Deterministic context for continuing this task in a new session.</p>
          </div>
          <div className="page-header-actions">
            <Button variant="primary" onClick={() => navigator.clipboard.writeText(context)}>
              Copy to Clipboard
            </Button>
            <Link to={`/tasks/${taskId}`}>
              <Button variant="secondary">Back to Task</Button>
            </Link>
          </div>
        </div>

        <Card variant="dark" className="resume-context-card">
          <pre className="resume-context-pre">{context}</pre>
        </Card>
      </div>
    </div>
  );
}
