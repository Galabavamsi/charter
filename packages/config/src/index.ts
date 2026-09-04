import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

function findEnvFile(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

const razorpayMode = z.enum(['test', 'live']);
const optionalUrl = z.union([z.literal(''), z.string().url()]);

function isBrowserSafeSupabaseKey(key: string): boolean {
  if (key === '') {
    return true;
  }
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) {
    return true;
  }

  const segments = key.split('.');
  if (
    segments.length !== 3 ||
    segments.some((segment) => segment.length === 0 || !/^[A-Za-z0-9_-]+$/.test(segment))
  ) {
    return false;
  }
  try {
    const payload: unknown = JSON.parse(Buffer.from(segments[1]!, 'base64url').toString('utf8'));
    return (
      typeof payload === 'object' &&
      payload !== null &&
      'role' in payload &&
      payload.role === 'anon'
    );
  } catch {
    return false;
  }
}

export const envSchema = z
  .object({
    CHARTER_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().positive().default(3000),
    WEBHOOK_PORT: z.coerce.number().int().positive().default(3001),
    MCP_PORT: z.coerce.number().int().positive().default(3002),
    RENDER: z.literal('true').optional(),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(3).optional(),
    DATABASE_URL: z.string().min(1).default('postgres://charter:charter@127.0.0.1:5432/charter'),
    REDIS_URL: z.string().min(1).optional(),
    RAZORPAY_MODE: razorpayMode.default('test'),
    RAZORPAY_KEY_ID: z.string().optional().default(''),
    RAZORPAY_KEY_SECRET: z.string().optional().default(''),
    RAZORPAY_WEBHOOK_SECRET: z.string().optional().default(''),
    FIREWORKS_API_KEY: z.string().optional().default(''),
    FIREWORKS_MODEL: z.string().optional().default(''),
    LANGFUSE_HOST: z.string().optional().default('https://jp.cloud.langfuse.com'),
    LANGFUSE_PUBLIC_KEY: z.string().optional().default(''),
    LANGFUSE_SECRET_KEY: z.string().optional().default(''),
    VAPI_API_KEY: z.string().optional().default(''),
    VAPI_PUBLIC_KEY: z.string().optional().default(''),
    CHARTER_PUBLIC_URL: z.string().optional().default(''),
    CHARTER_CURSOR_SECRET: z.string().optional().default(''),
    AGENTMAIL_API_KEY: z.string().optional().default(''),
    AGENTMAIL_INBOX: z.string().optional().default(''),
    SUPABASE_URL: optionalUrl.optional().default(''),
    SUPABASE_PUBLISHABLE_KEY: z.string().optional().default(''),
    SUPABASE_JWT_ISSUER: optionalUrl.optional().default(''),
    SUPABASE_JWT_AUDIENCE: z.string().min(1).optional().default('authenticated'),
    SUPABASE_JWT_JWKS_URL: optionalUrl.optional().default(''),
  })
  .superRefine((value, ctx) => {
    const keys = [value.RAZORPAY_KEY_ID, value.RAZORPAY_KEY_SECRET].filter(Boolean);
    const testPrefix = value.RAZORPAY_KEY_ID.startsWith('rzp_test_');
    const livePrefix = value.RAZORPAY_KEY_ID.startsWith('rzp_live_');

    if (testPrefix && livePrefix) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'RAZORPAY_MIXED_MODE',
        path: ['RAZORPAY_KEY_ID'],
      });
    }

    if (value.RAZORPAY_MODE === 'test' && value.RAZORPAY_KEY_ID && !testPrefix) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'RAZORPAY_MODE_KEY_MISMATCH',
        path: ['RAZORPAY_KEY_ID'],
      });
    }

    if (value.RAZORPAY_MODE === 'live' && value.RAZORPAY_KEY_ID && !livePrefix) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'RAZORPAY_MODE_KEY_MISMATCH',
        path: ['RAZORPAY_KEY_ID'],
      });
    }

    if (value.RAZORPAY_MODE === 'live' && value.CHARTER_ENV === 'development') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'LIVE_RAZORPAY_FORBIDDEN_IN_DEVELOPMENT',
        path: ['RAZORPAY_MODE'],
      });
    }

    if (keys.length === 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'RAZORPAY_INCOMPLETE_KEYS',
        path: ['RAZORPAY_KEY_SECRET'],
      });
    }

    if (
      (value.CHARTER_ENV === 'staging' || value.CHARTER_ENV === 'production') &&
      value.CHARTER_CURSOR_SECRET.length < 32
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CHARTER_CURSOR_SECRET_REQUIRED',
        path: ['CHARTER_CURSOR_SECRET'],
      });
    }

    if (
      value.SUPABASE_PUBLISHABLE_KEY.startsWith('sb_secret_') ||
      value.SUPABASE_PUBLISHABLE_KEY.includes('service_role')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'SUPABASE_SECRET_KEY_FORBIDDEN',
        path: ['SUPABASE_PUBLISHABLE_KEY'],
      });
    } else if (!isBrowserSafeSupabaseKey(value.SUPABASE_PUBLISHABLE_KEY)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'SUPABASE_PUBLISHABLE_KEY_INVALID',
        path: ['SUPABASE_PUBLISHABLE_KEY'],
      });
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  if (source === process.env) {
    const envPath = findEnvFile(process.cwd());
    if (envPath) {
      loadDotenv({ path: envPath, override: false });
    }
  }
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join('; ');
    throw new Error(`CONFIG_INVALID: ${message}`);
  }
  if (
    (parsed.data.CHARTER_ENV === 'development' || parsed.data.CHARTER_ENV === 'test') &&
    !parsed.data.CHARTER_CURSOR_SECRET
  ) {
    return {
      ...parsed.data,
      CHARTER_CURSOR_SECRET:
        parsed.data.CHARTER_ENV === 'test'
          ? 'charter-test-cursor-secret-not-for-deployment'
          : 'charter-development-cursor-secret-not-for-deployment',
    };
  }
  return parsed.data;
}

export function assertPaymentsReady(config: AppConfig): void {
  if (!config.RAZORPAY_KEY_ID || !config.RAZORPAY_KEY_SECRET) {
    throw new Error('CONFIG_PAYMENTS_NOT_READY');
  }
}
