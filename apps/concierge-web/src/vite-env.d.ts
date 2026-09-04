/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  /** Optional public origin for auth email redirects when `window` is unavailable. */
  readonly VITE_PUBLIC_URL?: string;
}
