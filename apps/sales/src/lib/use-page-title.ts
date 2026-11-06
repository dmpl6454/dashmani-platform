import { useEffect } from "react";

const SUFFIX = "Digital Sukoon Sales";

/** Sets the browser tab to "<page> · Digital Sukoon Sales" (the static export has one <title> for every page). */
export function usePageTitle(title: string | null | undefined) {
  useEffect(() => {
    if (typeof document === "undefined") return;
    const t = (title ?? "").trim();
    document.title = t ? `${t} · ${SUFFIX}` : SUFFIX;
    return () => {
      document.title = SUFFIX;
    };
  }, [title]);
}

/** A plain-text title from what PageHead was given (a string, or a fragment whose text we can read). */
export function titleText(node: unknown): string | null {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) {
    const parts = node.map(titleText).filter(Boolean);
    return parts.length ? parts.join("") : null;
  }
  if (node && typeof node === "object" && "props" in node) {
    const children = (node as { props?: { children?: unknown } }).props?.children;
    return titleText(children);
  }
  return null;
}
