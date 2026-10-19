import { Link } from 'react-router-dom';

export function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-grid">
          <div className="footer-col">
            <Link to="/" className="footer-brand" aria-label="WorkJournal home">
              <span className="brand-mark">W</span>
              <span className="brand-name brand-name-invert">WorkJournal</span>
            </Link>
            <p className="footer-text">Local-first task continuity for AI coding agents.</p>
          </div>
          <div className="footer-col">
            <h4 className="footer-heading">Product</h4>
            <a href="/projects" className="footer-link">Projects</a>
            <a href="/" className="footer-link">Dashboard</a>
          </div>
          <div className="footer-col">
            <h4 className="footer-heading">Resources</h4>
            <a href="/docs" className="footer-link">Documentation</a>
            <a href="/docs/api" className="footer-link">API Reference</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
