/**
 * Resolves as soon as `document.querySelectorAll(selector)` returns at least
 * one match — either immediately, or after a MutationObserver sees one appear.
 */
export function waitForSelector(selector: string, root: Element = document.body): Promise<Element[]> {
  return new Promise((resolve) => {
    const existing = document.querySelectorAll(selector);
    if (existing.length > 0) {
      resolve(Array.from(existing));
      return;
    }
    const observer = new MutationObserver(() => {
      const found = document.querySelectorAll(selector);
      if (found.length > 0) {
        observer.disconnect();
        resolve(Array.from(found));
      }
    });
    observer.observe(root, { childList: true, subtree: true });
  });
}
