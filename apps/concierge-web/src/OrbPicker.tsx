import { ThinkingOrb, type OrbState } from 'thinking-orbs';

const STATES: Array<{ state: OrbState; blurb: string }> = [
  { state: 'working', blurb: 'Particles on tilted orbits — Razorpay Checkout opening' },
  { state: 'searching', blurb: 'A scan meridian sweeps a dotted globe — Concierge working' },
  { state: 'solving', blurb: 'Bands scramble, then click back solved' },
  { state: 'listening', blurb: 'A waveform rolls through the rings' },
  { state: 'connecting', blurb: 'A constellation wires itself' },
  { state: 'weaving', blurb: 'Three strands plait around the sphere' },
  { state: 'composing', blurb: 'An undulating multi-band sash' },
  { state: 'breathing', blurb: 'A ring slowly morphing' },
  { state: 'shaping', blurb: 'Dotted outline: circle → triangle → square' },
];

export function OrbPickerPage() {
  return (
    <main className="orb-picker">
      <header className="orb-picker-head">
        <p className="orb-picker-kicker">Temp picker</p>
        <h1>thinking-orbs — nine states</h1>
        <p>
          Chat uses the light orb while Concierge works and while Pay opens. Talk uses the dark orb
          while connecting, listening, and speaking. Concierge is <code>searching</code> light 64.
          Razorpay Checkout is <code>working</code> light 64.
        </p>
      </header>
      <section className="orb-picker-grid">
        {STATES.map((row) => (
          <article key={row.state} className="orb-picker-card">
            <div className="orb-picker-stage" data-theme="light">
              <ThinkingOrb state={row.state} size={64} theme="light" />
              <span>light · 64</span>
            </div>
            <div className="orb-picker-stage" data-theme="dark">
              <ThinkingOrb state={row.state} size={64} theme="dark" />
              <span>dark · 64</span>
            </div>
            <h2>{row.state}</h2>
            <p>{row.blurb}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
