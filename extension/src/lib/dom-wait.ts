/**
 * Resolves as soon as `selector` matches inside `root` — either immediately, or after a MutationObserver
 * sees one appear. Always settles: `timeoutMs` (default 10s) and an optional abort both resolve with an
 * empty array, so callers can never leave an observer attached forever.
 */
export function waitForSelector(
  selector: string,
  { timeoutMs = 10_000, root = document.body }: { timeoutMs?: number; root?: Element } = {},
): Promise<Element[]> {
  return new Promise((resolve) => {
    const existing = root.querySelectorAll(selector);
    if (existing.length > 0) {
      resolve(Array.from(existing));
      return;
    }

    let settled = false;
    const finish = (elements: Element[]) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(elements);
    };
    const observer = new MutationObserver(() => {
      const found = root.querySelectorAll(selector);
      if (found.length > 0) finish(Array.from(found));
    });
    const timer = setTimeout(() => finish([]), timeoutMs);
    observer.observe(root, { childList: true, subtree: true });
  });
}
