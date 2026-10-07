import Link from "next/link";

export default function NotFound() {
  return (
    <main style={{ height: "100dvh", display: "grid", placeItems: "center", padding: 24, textAlign: "center" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 20, alignItems: "center" }}>
        <p className="kicker">No signal</p>
        <h1 className="h2">This channel is off air.</h1>
        <Link href="/" className="btn btn-primary">
          Back to CH 01 <span aria-hidden="true">→</span>
        </Link>
      </div>
    </main>
  );
}
