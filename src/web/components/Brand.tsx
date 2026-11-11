export function Brand() {
  return (
    <a className="brand" href="/" aria-label="WebUntis ICS Bridge">
      <span className="brand-icon" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="4" y="5" width="16" height="16" rx="3" />
          <path d="M8 3v4M16 3v4M4 10h16M8 14h3M8 17h6" />
        </svg>
      </span>
      <span>
        WebUntis <span className="brand-name-ending">ICS Bridge</span>
      </span>
    </a>
  );
}
