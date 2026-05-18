// Tiny disclosure hook for collapsible UI bits (tool call bodies, details
// panels, etc.). Used by every tool renderer — keeps the open/setOpen
// boilerplate in one place.

import { useCallback, useState } from 'react';

export interface Disclosure {
  open: boolean;
  toggle: () => void;
  setOpen: (v: boolean) => void;
}

export function useDisclosure(defaultOpen = false): Disclosure {
  const [open, setOpen] = useState(!!defaultOpen);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  return { open, toggle, setOpen };
}
