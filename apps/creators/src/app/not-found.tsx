import Link from "next/link";

export default function NotFound() {
  return (
    <main className="min-h-screen grid place-items-center px-4">
      <div className="max-w-md text-center">
        <p className="kicker">404</p>
        <h1 className="mt-3 text-4xl font-extrabold tracking-[-0.04em]">This page doesn&apos;t exist.</h1>
        <p className="mt-3 text-ink-3">The link may be old or mistyped.</p>
        <div className="mt-6 flex flex-wrap gap-3 justify-center">
          <Link href="/" className="btn btn-sm">Home</Link>
          <Link href="/dashboard" className="btn btn-ghost btn-sm">Your account</Link>
        </div>
      </div>
    </main>
  );
}
