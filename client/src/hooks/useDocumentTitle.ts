import { useEffect } from "react";

const SITE_NAME = "CineTickets";

/** Sets (and restores) the document title per page. */
export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = `${title} · ${SITE_NAME}`;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
