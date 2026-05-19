import { useCallback, useState } from 'react';

const STORAGE_KEY = 'tracebench.sessionsCollapsed';

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function useSessionsPaneCollapsed() {
  const [collapsed, setCollapsed] = useState(readStored);

  const toggle = useCallback(() => {
    setCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      } catch {
        // ignore quota / private mode
      }
      return next;
    });
  }, []);

  return { collapsed, toggle, setCollapsed };
}
