import { createSignal } from "solid-js";

// Tracks which bar the user last armed (header tab strip or footer bucket bar).
// Read by TerminalPane's right-Shift-tap detector to know where to return focus.
// Default is "footer" — a cold tap with no prior arming always lands on the
// bottom strip.
const [lastArmedBar, setLastArmedBar] = createSignal<"footer" | "header">(
  "footer",
);

export { lastArmedBar, setLastArmedBar };
