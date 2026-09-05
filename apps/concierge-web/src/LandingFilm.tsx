export function LandingFilm() {
  return (
    <div className="home-hero-media" aria-hidden="true">
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
    </div>
  );
}
