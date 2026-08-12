// The Digital Sukoon mark — the same two glass shapes the preloader animates
// (HeroLoader.tsx), but rendered STATIC and fully filled: no liquid-fill animation, no
// glass/haze overlay, no split. Used in the nav beside the "DIGITAL SUKOON" wordmark.
//
// Plain (non-client) component — pure markup, no hooks — so it renders on the server
// inside layout.tsx's nav and appears in the crawler HTML.

// Gradient id is namespaced away from the loader's (`ds-loader-liquid`) so both can be
// on the page at once without one overriding the other.
const GRADIENT_ID = "ds-brand-liquid";

const PATH_A =
  "M 187.1,0.6 C 149.4,3.3 95.9,20.5 65.5,39.7 C -40.4,106.9 -12.5,231.7 137,359 C 186.9,401.5 228.6,428.6 327.7,482.7 C 418.2,532.1 464.6,560.7 504.9,592 C 592.6,660 638.7,738 643.8,827 C 645.5,858.5 640.7,885.4 624.3,934 C 617,955.6 615,964 615.6,970 C 618.8,1005.6 694.5,968.2 760,898.7 C 853.2,799.7 903,659.5 897.6,510.9 C 894.3,415.4 860.6,324.6 798.7,243.8 C 775.2,213.1 734.6,171.5 702.8,145.4 C 624.3,81.1 519.4,33.5 418,16.1 C 408.7,14.4 395.8,11.9 389.3,10.5 C 358.3,3.3 348.6,1.7 330.8,0.6 C 318.6,-0.2 197.9,-0.2 187.1,0.6 Z";

const PATH_B =
  "M 19.4,361.7 C 8.1,365.8 2.6,379.7 0.8,408.1 C -0.8,433.6 0.3,867.4 1.9,876.7 C 7.8,909 22.7,928.6 58.7,951.1 C 102.1,978.3 149.4,996.6 224.4,1015.1 C 255.9,1022.9 278.7,1024.6 344.7,1023.8 C 393.8,1023.3 407.1,1021.7 432.3,1013.5 C 482.9,997 517.1,970 541.1,927.6 C 600.7,822.5 561.7,721.8 422.4,620.4 C 381.9,591 338.5,564.3 240.8,509 C 159,462.6 126.5,439.8 73.6,391.2 C 43.8,363.9 31.6,357.2 19.4,361.7 Z";

export default function BrandMark() {
  return (
    // viewBox padded a few units past the 898.03 × 1024 artwork box so the outer curves
    // aren't shaved off at the edges.
    <svg className="ds-brand-mark" viewBox="-8 -8 914 1040" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={GRADIENT_ID} gradientUnits="userSpaceOnUse" x1="90" y1="0" x2="470" y2="1024">
          <stop offset="0" stopColor="#3B77E8" />
          <stop offset="1" stopColor="#0B45BB" />
        </linearGradient>
      </defs>
      <path d={PATH_A} fill={`url(#${GRADIENT_ID})`} />
      <path d={PATH_B} fill={`url(#${GRADIENT_ID})`} />
    </svg>
  );
}
