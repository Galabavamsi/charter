import { useState } from 'react';
import { catalogThumbSrc, visualHue, visualKind } from './catalog-visuals';

function glyph(kind: string, ink: string) {
  if (kind === 'tee') {
    return <path fill={ink} d="M18 24h14l6 10h4l6-10h14v8l-8 4v24H26V36l-8-4z" />;
  }
  if (kind === 'scarf') {
    return (
      <path
        fill={ink}
        d="M28 16c10 0 18 8 18 18v30c0 6-8 6-8 0V36c0-6-4-10-10-10s-10 4-10 10v28c0 6-8 6-8 0V34c0-10 8-18 18-18z"
      />
    );
  }
  if (kind === 'tote') {
    return <path fill={ink} d="M26 28h28l4 36H22zm8 0c0-6 3-10 6-10s6 4 6 10" fillOpacity="0.95" />;
  }
  if (kind === 'coffee') {
    return (
      <>
        <path fill={ink} d="M24 30h28v22a10 10 0 0 1-10 10H34a10 10 0 0 1-10-10z" />
        <path fill={ink} d="M52 34h6a8 8 0 0 1 0 16h-6" />
      </>
    );
  }
  if (kind === 'gift') {
    return <path fill={ink} d="M18 34h44v28H18zm8-10h28v10H26z" />;
  }
  if (kind === 'home') {
    return <path fill={ink} d="M16 38 40 16l24 22v26H16z" />;
  }
  if (kind === 'spice') {
    return <circle cx="40" cy="40" r="18" fill={ink} />;
  }
  if (kind === 'desk') {
    return <path fill={ink} d="M18 48h44v6H18zm6-20h32v20H24z" />;
  }
  return <circle cx="40" cy="40" r="16" fill={ink} />;
}

function GlyphFallback({ label, seed }: { label: string; seed: string }) {
  const hue = visualHue(seed || label);
  const kind = visualKind(label, seed);
  const paper = `hsl(${hue} 48% 84%)`;
  const ink = `hsl(${hue} 42% 28%)`;
  return (
    <svg viewBox="0 0 80 80" width="80" height="80">
      <rect width="80" height="80" rx="16" fill={paper} />
      {glyph(kind, ink)}
    </svg>
  );
}

export function CatalogThumb({
  label,
  seed,
  className,
}: {
  label: string;
  seed: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const src = catalogThumbSrc(label, seed);
  return (
    <span className={className ? `catalog-thumb ${className}` : 'catalog-thumb'} aria-hidden="true">
      {failed ? (
        <GlyphFallback label={label} seed={seed} />
      ) : (
        <img
          className="catalog-thumb-photo"
          src={src}
          alt=""
          width={80}
          height={80}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}
