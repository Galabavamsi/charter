import { ThinkingOrb, type OrbState } from 'thinking-orbs';

export type ProcessState = OrbState;

type ProcessOrbProps = {
  state: ProcessState;
  label: string;
  size?: 20 | 64;
  theme?: 'light' | 'dark';
  className?: string;
};

export function ProcessOrb({
  state,
  label,
  size = 20,
  theme = 'light',
  className,
}: ProcessOrbProps) {
  return (
    <div className={className ? `process-orb ${className}` : 'process-orb'}>
      <ThinkingOrb state={state} size={size} theme={theme} aria-label={label} />
      <span>{label}</span>
    </div>
  );
}
