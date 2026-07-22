import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * ESLint 9 flat config.
 *
 * `npm run lint` had no configuration at all, so it only ever printed an error.
 * The point of having it beside `tsc --noEmit` is the part the compiler cannot
 * see: the rules of hooks. `tsc` already enforces types, unused locals and
 * unused parameters (see tsconfig), so those are switched off here rather than
 * reported twice with different wording.
 *
 * Type-aware linting is deliberately *not* enabled: it needs a full program per
 * run and would make the lint several times slower than the build, for rules
 * that mostly overlap with what `tsc` already rejects.
 */
export default tseslint.config(
  {
    // Build output, deps and the vendored library are not ours to lint.
    ignores: ["dist/**", "node_modules/**", "library/**", "library-archive/**", "site/**"],
  },

  // ── Application code ───────────────────────────────────────────────────────
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.es2021 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // The classic pair stays an error — `rules-of-hooks` catches real crashes
      // and `exhaustive-deps` real stale-closure bugs. Neither reports anything
      // today, so both act as a guard against new violations.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",

      // react-hooks v7 added compiler-derived rules that go well beyond that.
      // They flag 24 places in code written long before the linter existed
      // (OscilloscopePlot, WireTool, PlacementGhost), and several are deliberate:
      // a ref assigned during render to keep an export callback current, a
      // setState in an effect that re-anchors a cursor box. Turning them into
      // errors would make `npm run lint` red from its first run and useless as a
      // gate; as warnings the findings stay visible and can be worked off. Raise
      // them to "error" once the backlog is clear.
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/static-components": "warn",

      // Already reported by `tsc --noEmit` (noUnusedLocals / noUnusedParameters),
      // which is the check that actually gates the build.
      "@typescript-eslint/no-unused-vars": "off",

      // The `.asc`/`.asy` parsers and the store hand around shapes that are only
      // pinned down further downstream; `any` there is a deliberate seam, not an
      // oversight. Flagging every one would bury the findings that matter.
      "@typescript-eslint/no-explicit-any": "off",

      // `catch { /* visual-only */ }` is used on purpose where a failure must not
      // interrupt the user — the comment is the documentation.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },

  // ── Node-side scripts ──────────────────────────────────────────────────────
  {
    files: ["scripts/**/*.{js,mjs}", "server/**/*.mjs", "*.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
);
