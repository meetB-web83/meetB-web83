import { useSearchParams, Link } from 'react-router-dom';
import { useDashboard } from '../hooks/useDashboard';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { TaskList } from '../components/tasks/TaskList';
import { ScopeSelect } from '../components/projects/ScopeSelect';
import { Spinner } from '../components/ui/Spinner';

export function HomePage() {
  const [params] = useSearchParams();
  const scope = params.get('scope');
  const { stats, recentTasks, projects, loading, error } = useDashboard(scope);

  return (
    <div className="home-page">
      {/* Hero */}
      <section className="hero">
        <div className="container hero-grid">
          <div className="hero-copy">
            <div className="hero-meta">
              <span className="code-tag">&lt;workjournal&gt;</span>
              <span className="code-tag code-tag-mint">[local-first]</span>
              <span className="code-tag code-tag-ghost">[no-cloud]</span>
            </div>
            <h1 className="hero-title">Task Continuity for AI Agents</h1>
            <p className="hero-subtitle">
              WorkJournal preserves task progress across AI coding-agent sessions.
              One agent can stop, another can resume — without losing context.
            </p>
            <div className="hero-actions">
              <Link to="/projects">
                <Button variant="primary" size="lg">View Projects</Button>
              </Link>
            </div>
          </div>
          <img
            className="hero-visual"
            src="/final_hero_right_non_bg.png"
            alt="Isometric continuity drive passing task state from Agent A to Agent B with zero token drift"
            loading="eager"
          />
        </div>
      </section>

      {/* Scope filter: hidden on desktop (lives in the top nav), inline here on mobile */}
      <div className="container">
        <div className="home-scope mb-md">
          <span className="code-tag">&lt;scope&gt;</span>
          <ScopeSelect projects={projects} />
        </div>
      </div>

      {/* Stats Band */}
      <section className="band-soft">
        <div className="container">
          {loading || !stats ? (
            <Spinner />
          ) : error ? (
            <p className="text-body">Error loading stats: {error}</p>
          ) : (
            <div className="stats-grid">
              <Card variant="light" className="stat-card">
                <div className="stat-value">{stats.projects}</div>
                <div className="stat-label">Projects</div>
              </Card>
              <Card variant="light" className="stat-card">
                <div className="stat-value">{stats.active_tasks}</div>
                <div className="stat-label">Active Tasks</div>
              </Card>
              <Card variant="light" className="stat-card">
                <div className="stat-value">{stats.completed}</div>
                <div className="stat-label">Completed</div>
              </Card>
              <Card variant="light" className="stat-card">
                <div className="stat-value">{stats.blocked}</div>
                <div className="stat-label">Blocked</div>
              </Card>
            </div>
          )}
        </div>
      </section>

      {/* Recent Tasks */}
      <section className="section">
        <div className="container">
          <div className="section-header">
            <h2 className="section-title">Recent Tasks</h2>
            <Link to="/projects" className="section-link">View all</Link>
          </div>
          <TaskList tasks={recentTasks} loading={loading} error={error} />
        </div>
      </section>
    </div>
  );
}
