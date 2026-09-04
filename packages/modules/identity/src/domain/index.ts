export type Tenant = {
  id: string;
  label: string;
  synthetic: boolean;
};

export {
  isTenantKilled,
  resetKillSwitches,
  setGlobalKill,
  setTenantKill,
  snapshotKillSwitches,
} from './kill.js';
export type { KillSnapshot } from './kill.js';
