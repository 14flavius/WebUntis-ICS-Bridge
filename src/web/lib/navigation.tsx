import { useEffect, useState, type MouseEvent } from 'react';

export const pagePaths = {
  dashboard: '/',
  feeds: '/feeds',
  settings: '/settings',
  admin: '/admin',
} as const;
export type Page = keyof typeof pagePaths;

function currentPage(): Page | null {
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  for (const page of Object.keys(pagePaths) as Page[]) {
    if (pagePaths[page] === path) return page;
  }
  return null;
}

export function useNavigation() {
  const [page, setPage] = useState(currentPage);
  useEffect(() => {
    const onPopState = () => setPage(currentPage());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  const navigate = (target: Page) => {
    if (window.location.pathname === pagePaths[target]) return;
    window.history.pushState(null, '', pagePaths[target]);
    setPage(target);
    window.scrollTo(0, 0);
  };
  const follow = (event: MouseEvent<HTMLAnchorElement>, target: Page) => {
    // Keep native new-tab, modified-click and copy-link behavior.
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    navigate(target);
  };
  return { page, navigate, follow };
}
