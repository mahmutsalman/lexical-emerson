const TAP_WINDOW_MS = 300;

// Install a single window-level ShiftRight-tap detector. No focus gate — fires
// regardless of document.activeElement so the user can arm the footer from any
// state (fresh window, auto-resumed terminal, CodeMirror, sidebar, etc.).
// Returns a teardown function that removes the listeners.
export function setupGlobalShiftArm(): () => void {
  let shiftDownAt = 0;
  let shiftTainted = false;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code === "ShiftRight") {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) {
        shiftDownAt = 0;
        shiftTainted = true;
        return;
      }
      shiftDownAt = performance.now();
      shiftTainted = false;
      return;
    }
    if (shiftDownAt !== 0) shiftTainted = true;
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code !== "ShiftRight") return;
    const downAt = shiftDownAt;
    const tainted = shiftTainted;
    shiftDownAt = 0;
    shiftTainted = false;
    if (downAt === 0 || tainted) return;
    if (performance.now() - downAt > TAP_WINDOW_MS) return;
    e.preventDefault();
    window.dispatchEvent(
      new CustomEvent("lexical:arm-switch-vertical", {
        detail: { target: "footer" },
      }),
    );
  };

  // Taint on mousedown during the hold so Shift+Click doesn't arm.
  const onMouseDown = () => {
    if (shiftDownAt !== 0) shiftTainted = true;
  };

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("mousedown", onMouseDown, true);

  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("mousedown", onMouseDown, true);
  };
}
