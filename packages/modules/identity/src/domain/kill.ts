export type KillSnapshot = {
  global: boolean;
  tenants: Record<string, boolean>;
};

const state: { global: boolean; tenants: Map<string, boolean> } = {
  global: false,
  tenants: new Map(),
};

export function resetKillSwitches(): void {
  state.global = false;
  state.tenants.clear();
}

export function isTenantKilled(tenantId: string): boolean {
  return state.global || state.tenants.get(tenantId) === true;
}

export function setGlobalKill(on: boolean): KillSnapshot {
  state.global = on;
  return snapshotKillSwitches();
}

export function setTenantKill(tenantId: string, on: boolean): KillSnapshot {
  if (!tenantId.trim()) {
    throw new Error('TENANT_ID_REQUIRED');
  }
  if (on) {
    state.tenants.set(tenantId, true);
  } else {
    state.tenants.delete(tenantId);
  }
  return snapshotKillSwitches();
}

export function snapshotKillSwitches(): KillSnapshot {
  return {
    global: state.global,
    tenants: Object.fromEntries(state.tenants.entries()),
  };
}
