import { useLayoutEffect, useRef } from "react";

// One ticket per dialog opening, including reopening the same object. Closing,
// changing user or unmounting invalidates every callback from the old opening.
export function useKnowledgeRequestSession(userId: string, reset: () => void) {
  const current = useRef<symbol | null>(null);
  useLayoutEffect(() => {
    reset();
    return () => { current.current = null; };
  }, [userId]);

  return {
    begin() { return current.current = Symbol("knowledge-dialog"); },
    capture() { return current.current; },
    isCurrent(ticket: symbol | null) { return ticket !== null && current.current === ticket; },
    invalidate() { current.current = null; }
  };
}
