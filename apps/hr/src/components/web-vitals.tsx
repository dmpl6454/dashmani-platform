"use client";
import { useEffect } from "react";
import { useReportWebVitals } from "next/web-vitals";

/**
 * Real-user speed: sends this browser's Core Web Vitals (LCP, INP, CLS, FCP, TTFB) for each
 * page to the API, which keeps the 75th percentile per page (Admin → API Costs → Page speed).
 * Batched and sent when the tab is hidden or closed, at most once per batch; only while signed
 * in, so nothing is sent from the sign-in page. Failures are ignored: this never affects the page.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";
const APP = "hr";
const TOKEN_KEY = "hrAccessToken";
const queue: Array<{ route: string; name: string; value: number }> = [];

function flush() {
  if (!queue.length) return;
  let token: string | null = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch { /* storage blocked */ }
  const samples = queue.splice(0, 20);
  if (!token) return;
  try {
    void fetch(`${API_URL}/web-vitals`, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ app: APP, samples }),
    }).catch(() => {});
  } catch { /* ignore */ }
}

export function WebVitalsReporter() {
  useReportWebVitals((metric) => {
    if (!["LCP", "INP", "CLS", "FCP", "TTFB"].includes(metric.name)) return;
    queue.push({ route: window.location.pathname, name: metric.name, value: metric.value });
    if (queue.length >= 20) flush();
  });
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === "hidden") flush(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
    };
  }, []);
  return null;
}
