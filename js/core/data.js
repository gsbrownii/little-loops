// Content loading. All content (levels, art parts, stories...) is JSON under /data,
// fetched relative to index.html so the app works from any GitHub Pages sub-path.
const cache = new Map();

/** Absolute URL for a path relative to the app root (index.html). */
export function assetURL(path) {
  return new URL(path, document.baseURI).href;
}

/** Fetch + parse a JSON file once; later calls share the same promise. */
export function loadJSON(path) {
  const url = assetURL(path);
  if (!cache.has(url)) {
    const p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status} loading ${path}`);
        return r.json();
      })
      .catch((err) => {
        cache.delete(url); // allow a retry later
        throw err;
      });
    cache.set(url, p);
  }
  return cache.get(url);
}
