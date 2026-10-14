import type { AppConfig } from '@charter/config';

export const DAILY_LIMIT_REACHED = 'DAILY_LIMIT_REACHED';
export const VOICE_DAILY_LIMIT_REPLY =
  "You have reached today's demo limit. Please come back tomorrow.";

export type TurnQuota = {
  /** Counts one turn; false (and nothing counted) once the buyer or the deployment is out for today. */
  take(userId: string, now?: Date): boolean;
};

/**
 * Demo spending cap: model and voice turns per buyer and across the deployment,
 * reset at UTC midnight. In memory on purpose: one small instance, and a
 * restart only ever gives visitors more turns, never fewer.
 */
export function createTurnQuota(limits: { perUser: number; global: number }): TurnQuota {
  let day = '';
  let total = 0;
  const perUser = new Map<string, number>();
  return {
    take(userId, now = new Date()) {
      const today = now.toISOString().slice(0, 10);
      if (today !== day) {
        day = today;
        total = 0;
        perUser.clear();
      }
      const key = userId.toLowerCase();
      const used = perUser.get(key) ?? 0;
      if (used >= limits.perUser || total >= limits.global) {
        return false;
      }
      perUser.set(key, used + 1);
      total += 1;
      return true;
    },
  };
}

const quotas = new WeakMap<AppConfig, TurnQuota>();

/** The text and voice routes of one app share a single quota. */
export function turnQuotaFor(config: AppConfig): TurnQuota {
  let quota = quotas.get(config);
  if (!quota) {
    quota = createTurnQuota({
      perUser: config.CHARTER_DAILY_TURNS_PER_USER,
      global: config.CHARTER_DAILY_TURNS_GLOBAL,
    });
    quotas.set(config, quota);
  }
  return quota;
}
