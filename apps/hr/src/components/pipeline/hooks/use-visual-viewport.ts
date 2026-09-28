"use client";
/**
 * The visualViewport contract (spec §9.2): keeps `--pl-vh` (visible height) and
 * `--pl-vvtop` (offsetTop) on <html> in step with the visual viewport, so the page,
 * every fixed sheet and the mention popover stay above the iOS keyboard.
 */
import { useEffect } from "react";

export function useVisualViewport() {
  useEffect(() => {
    const root = document.documentElement;
    const vv = window.visualViewport;
    let raf = 0;
    const apply = () => {
      raf = 0;
      const h = vv ? vv.height : window.innerHeight;
      const top = vv ? vv.offsetTop : 0;
      root.style.setProperty("--pl-vh", `${Math.round(h)}px`);
      root.style.setProperty("--pl-vvtop", `${Math.round(top)}px`);
    };
    const onChange = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };
    apply();
    vv?.addEventListener("resize", onChange);
    vv?.addEventListener("scroll", onChange);
    window.addEventListener("resize", onChange);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      vv?.removeEventListener("resize", onChange);
      vv?.removeEventListener("scroll", onChange);
      window.removeEventListener("resize", onChange);
      root.style.removeProperty("--pl-vh");
      root.style.removeProperty("--pl-vvtop");
    };
  }, []);
}
