// Smooth, fixed-duration scroll to an element by id.
//
// Why not just CSS `scroll-behavior: smooth` on an anchor? The native anchor jump
// captures ONE fixed pixel target at click time and animates toward it. On mobile the
// URL bar hides as the page scrolls (viewport height changes), and late-mounting
// widgets (the hero calendar, SWR revalidation) shift layout mid-flight — so the
// captured target no longer matches the element and the scroll undershoots, parking
// partway (users saw it stop at the calendar instead of the roles list).
//
// This re-reads the element's position every animation frame, so the final frame
// lands EXACTLY on the element no matter what moved above it. Duration is fixed
// (~500ms) so it feels fast, not proportional-to-distance sluggish.
export function smoothScrollToId(id: string, offset = 24, duration = 500) {
  if (typeof window === "undefined") return;

  const dest = () => {
    const el = document.getElementById(id);
    if (!el) return window.scrollY;
    return Math.max(0, window.scrollY + el.getBoundingClientRect().top - offset);
  };

  // Respect the OS "reduce motion" setting — jump straight there.
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    window.scrollTo({ top: dest(), behavior: "auto" });
    return;
  }

  const startY = window.scrollY;
  const start = performance.now();
  const ease = (t: number) => 1 - Math.pow(1 - t, 3); // easeOutCubic

  function frame(now: number) {
    const p = Math.min(1, (now - start) / duration);
    // Recompute the target each frame; interpolate from the start position so p=1
    // always resolves to the current target exactly — immune to layout shifts.
    const y = startY + (dest() - startY) * ease(p);
    // Explicit `behavior: "auto"` overrides any CSS `scroll-behavior: smooth`, so our
    // per-frame steps stay instant and don't fight a second (native) animation.
    window.scrollTo({ top: y, behavior: "auto" });
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
