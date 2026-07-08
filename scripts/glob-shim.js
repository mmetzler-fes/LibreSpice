// Node stand-in for Vite's `import.meta.glob`. The editor tests don't rely on
// any bundled `.asy` symbol (they use fallback-pin components), so an empty
// module map is sufficient.
export const globShim = () => ({});
