import { useState } from 'react';

// Reduced-motion and Save-Data visitors get the CSS poster only, without the 6 MB loop.
function prefersStillFilm(): boolean {
  try {
    const reducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } })
      .connection;
    return reducedMotion || connection?.saveData === true;
  } catch {
    return false;
  }
}

export function LandingFilm() {
  const [still] = useState(prefersStillFilm);
  return (
    <div className="home-hero-media" aria-hidden="true">
      {still ? null : (
        <video
          autoPlay
          muted
          loop
          playsInline
          poster="/media/landing-poster.jpg"
          disablePictureInPicture
        >
          <source src="/media/landing-loop.mp4" type="video/mp4" />
        </video>
      )}
    </div>
  );
}
