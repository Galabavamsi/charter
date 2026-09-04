import { describe, expect, it, beforeEach } from 'vitest';
import { isTenantKilled, resetKillSwitches, setGlobalKill, setTenantKill } from './kill.js';

describe('kill switches', () => {
  beforeEach(() => {
    resetKillSwitches();
  });

  it('is off by default', () => {
    expect(isTenantKilled('northstar-demo-in')).toBe(false);
  });

  it('kills one tenant without killing another', () => {
    setTenantKill('northstar-demo-in', true);
    expect(isTenantKilled('northstar-demo-in')).toBe(true);
    expect(isTenantKilled('other-tenant')).toBe(false);
  });

  it('global kill stops every tenant', () => {
    setGlobalKill(true);
    expect(isTenantKilled('northstar-demo-in')).toBe(true);
    expect(isTenantKilled('other-tenant')).toBe(true);
  });
});
