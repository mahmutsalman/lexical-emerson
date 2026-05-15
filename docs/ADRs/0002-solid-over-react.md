# ADR-0002 — Solid.js over React

**Status:** Accepted — 2026-05-15

## Context

The frontend is mostly: a file tree (lazy), a terminal pane (xterm.js wrapper), a sidebar list (recent projects), a modal (Cmd+P switcher), a footer chip (bucket bar). No 100+ component hierarchies, no Redux, no Next.js, no server components.

React's VDOM reconciliation cost and its `useEffect`/`useState` ergonomics make it the wrong tool when the goal is *minimum* runtime overhead. Mahmut's prior Tauri app used React (OBS Shortcut Controller), so familiarity is the only force pushing us toward React.

## Options considered

| Option | Runtime cost | Bundle size | Familiarity to Mahmut |
|---|---|---|---|
| **Solid.js** | Lowest (no VDOM, fine-grained signals) | ~7 KB gzipped | Low — new but JSX-like |
| React | Higher (VDOM diff) | ~45 KB | High |
| Vanilla TS + DOM | Lowest | 0 KB | Moderate |
| Svelte | Low (compile-time) | ~10 KB | None |

## Decision

**Solid.js.** Reasoning:
1. JSX-like syntax — Mahmut's React muscle memory mostly transfers (signals replace `useState`, no `useEffect`-style deps array, no rerender semantics to think about).
2. Bundle size 6× smaller than React.
3. No VDOM — terminal pane re-renders happen in fine-grained reactive scope, not whole-component-tree diffs.
4. Tauri's official starter templates include `solid-ts`, so it's a first-class community choice.

Vanilla TS would be marginally lighter but the file tree's recursive lazy rendering really benefits from a reactive framework. Svelte is a fine alternative but is a complete reset from JSX.

## Consequences

- **No React libraries.** No `react-hotkeys`, no `react-arborist` for the tree. Either roll our own or find Solid-native equivalents.
- Mahmut takes a small learning curve on signals (`createSignal`, `createMemo`, `createResource`). One project's worth, then it's natural.
- xterm.js works fine — it's framework-agnostic, manipulates a `<div>` directly.
- If Solid ever proves limiting (which is unlikely at this app's complexity), the per-component rewrite to vanilla TS is small.

## Revisit when

- A core dependency requires React and there's no equivalent.
- The reactive scope semantics cause a debuggability problem that can't be fixed cleanly.
