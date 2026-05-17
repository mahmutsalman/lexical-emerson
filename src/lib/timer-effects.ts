// Subtle bell tone via WebAudio (no asset file). Two sine partials with a
// short attack and ~1.6s exponential release — sits in the background
// without being startling. The AudioContext is created lazily and closed
// after the sound finishes so we don't leak audio nodes.
export function playFinishBell(): void {
  let ctx: AudioContext;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;
    ctx = new Ctor();
  } catch {
    return;
  }
  const now = ctx.currentTime;
  const tone = (freq: number, startOffset: number, peakGain: number) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const t0 = now + startOffset;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peakGain, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.6);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 1.7);
  };
  tone(880, 0, 0.18);
  tone(1320, 0.06, 0.10);
  tone(660, 0.55, 0.12);
  window.setTimeout(() => {
    void ctx.close().catch(() => {});
  }, 2400);
}

// Toggle a CSS class on the target element and remove it once the
// keyframe animation finishes — driven by the longest animation duration
// on the element. Caller can re-trigger by removing and re-adding the
// class on a future call.
export function flashElement(el: HTMLElement, className: string, holdMs = 1500): void {
  el.classList.remove(className);
  // Force a reflow so the browser sees the class removal as a state
  // transition; without this, re-adding immediately after removing
  // doesn't restart the animation.
  void el.offsetWidth;
  el.classList.add(className);
  window.setTimeout(() => el.classList.remove(className), holdMs);
}
