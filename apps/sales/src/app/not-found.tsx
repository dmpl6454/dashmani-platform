import Link from "next/link";

export default function NotFound() {
  return (
    <main className="min-h-screen grid place-items-center px-4">
      <div className="text-center">
        <p className="text-[11px] uppercase tracking-[0.12em] text-ink-3 mb-2">404</p>
        <h1 className="text-2xl font-extrabold mb-4">There is nothing at this address.</h1>
        <Link href="/dashboard" className="btn">Go to the dashboard</Link>
      </div>
    </main>
  );
}
