import { useEffect } from 'react';

// Sets the tab title for a route and restores the default when the route unmounts.
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title;
    return () => {
      document.title = 'Charter';
    };
  }, [title]);
}
