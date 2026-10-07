/**
 * 3D "boxes" loader (Uiverse.io by Nawsome). Styles live in app/globals.css
 * under the `bx-` prefix. Use for full-screen / page-level loading states;
 * keep Loader2 for spinners inside buttons.
 */
export function BoxesLoader({ size = 32, label = "Loading" }: { size?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} className="flex items-center justify-center" style={{ paddingTop: size * 1.5 }}>
      <div className="bx-boxes" style={{ ["--size" as string]: `${size}px` }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="bx-box">
            <div />
            <div />
            <div />
            <div />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Centred page-level loading block (replaces the old h-64 spinner). */
export function PageLoader({ className = "h-64" }: { className?: string }) {
  return (
    <div className={`flex items-center justify-center ${className}`}>
      <BoxesLoader />
    </div>
  );
}
