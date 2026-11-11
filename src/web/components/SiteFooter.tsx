import { APP_VERSION } from '../../shared/version';

const REPOSITORY = 'https://github.com/14flavius/webuntis-ics-bridge';
const AUTHOR_URL = 'https://flavius-hager.de';

/** Project information shown below every page, signed in or not. The footer
 * stays English in both interface languages. */
export function SiteFooter() {
  return (
    <footer className="site-footer" lang="en" aria-label="Project information">
      <div className="site-footer-project">
        <a href={REPOSITORY} target="_blank" rel="noopener noreferrer">
          <strong>Self-hosted WebUntis ICS Bridge</strong>
        </a>
        <span className="site-footer-version">v{APP_VERSION}</span>
      </div>
      <div className="site-footer-links">
        <span>
          by{' '}
          <a href={AUTHOR_URL} target="_blank" rel="noopener noreferrer">
            Flavius Hager
          </a>
        </span>
        <a href={REPOSITORY} target="_blank" rel="noopener noreferrer">
          GitHub
        </a>
      </div>
    </footer>
  );
}
