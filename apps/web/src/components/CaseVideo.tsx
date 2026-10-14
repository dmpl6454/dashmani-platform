"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A case study's campaign video, playing inside its Work card.
 *
 * It plays muted and looped only while the card is on screen (so seven cards never decode
 * at once) and stays paused for visitors who ask for reduced motion. Tapping the picture
 * plays/pauses; the speaker button turns sound on. A landscape clip sits on a blurred,
 * enlarged copy of its own poster so it fills the tall card without cropping the action.
 */
export default function CaseVideo({
  src,
  poster,
  title,
  tag,
  landscape = false,
}: {
  src: string;
  poster: string;
  title: string;
  tag: string;
  landscape?: boolean;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const bar = useRef<HTMLSpanElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const userPaused = useRef(false);

  // Play while visible; pause when scrolled away or the channel changes.
  useEffect(() => {
    const v = video.current;
    const el = box.current;
    if (!v || !el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !userPaused.current) v.play().catch(() => {});
        else v.pause();
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Progress bar, written straight to the element so playback never re-renders React.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    let raf = 0;
    const tick = () => {
      if (bar.current && v.duration) bar.current.style.transform = `scaleX(${v.currentTime / v.duration})`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      userPaused.current = false;
      v.play().catch(() => {});
    } else {
      userPaused.current = true;
      v.pause();
    }
  };

  const toggleSound = () => {
    const v = video.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
    if (!v.muted && v.paused) v.play().catch(() => {});
  };

  return (
    <div ref={box} className={`case-video${landscape ? " landscape" : ""}${playing ? " playing" : ""}`}>
      {landscape && <div className="case-video-bg" style={{ backgroundImage: `url(${poster})` }} aria-hidden="true" />}
      <video
        ref={video}
        src={src}
        poster={poster}
        muted
        loop
        playsInline
        preload="metadata"
        aria-label={`${title} campaign video`}
        onClick={toggle}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      <div className="case-video-top" aria-hidden="true">
        <span className="rec">● {playing ? "On air" : "Paused"}</span>
        <span>{tag}</span>
      </div>
      <button type="button" className="case-video-play" onClick={toggle} aria-label={playing ? "Pause video" : "Play video"}>
        <span aria-hidden="true">{playing ? "❚❚" : "►"}</span>
      </button>
      <button
        type="button"
        className="case-video-sound"
        onClick={toggleSound}
        aria-pressed={!muted}
        aria-label={muted ? "Turn sound on" : "Turn sound off"}
      >
        {muted ? "Sound off" : "Sound on"}
      </button>
      <span className="case-video-progress" aria-hidden="true">
        <span ref={bar} />
      </span>
    </div>
  );
}
