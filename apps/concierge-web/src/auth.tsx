import { createClient, type Session } from '@supabase/supabase-js';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { setAccessTokenProvider } from './api';

export type AuthUser = {
  id: string;
  email: string | null;
  name: string | null;
};

export type AuthSession = {
  accessToken: string;
  user: AuthUser;
};

export type PasswordCredentials = {
  email: string;
  password: string;
};

export type SignUpCredentials = PasswordCredentials & {
  options?: {
    data?: Record<string, unknown>;
    emailRedirectTo?: string;
  };
};

export interface AuthClient {
  readonly configured: boolean;
  getSession(): Promise<AuthSession | null>;
  signUp(credentials: SignUpCredentials): Promise<AuthSession | null>;
  signInWithPassword(credentials: PasswordCredentials): Promise<AuthSession>;
  signOut(): Promise<void>;
  onAuthStateChange(listener: (session: AuthSession | null) => void): () => void;
}

type AuthContextValue = {
  configured: boolean;
  loading: boolean;
  session: AuthSession | null;
  error: string | null;
  signUp(credentials: SignUpCredentials): Promise<AuthSession | null>;
  signInWithPassword(credentials: PasswordCredentials): Promise<AuthSession>;
  signOut(): Promise<void>;
  getAccessToken(): Promise<string | null>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function mapSession(session: Session | null): AuthSession | null {
  if (!session) {
    return null;
  }
  const rawName = session.user.user_metadata.name ?? session.user.user_metadata.full_name;
  return {
    accessToken: session.access_token,
    user: {
      id: session.user.id,
      email: session.user.email ?? null,
      name: typeof rawName === 'string' && rawName.trim() ? rawName.trim() : null,
    },
  };
}

type BrowserAuthEnv = Partial<
  Pick<ImportMetaEnv, 'VITE_SUPABASE_URL' | 'VITE_SUPABASE_PUBLISHABLE_KEY' | 'VITE_PUBLIC_URL'>
>;

export function publicAppOrigin(env: BrowserAuthEnv = import.meta.env): string {
  if (typeof window !== 'undefined') {
    const origin = window.location?.origin;
    if (origin && origin !== 'null') {
      return origin;
    }
  }
  const configured = env.VITE_PUBLIC_URL?.trim();
  return configured ? configured.replace(/\/$/, '') : '';
}

export function emailRedirectTo(origin = publicAppOrigin()): string | undefined {
  return origin ? `${origin}/` : undefined;
}

declare global {
  interface Window {
    __CHARTER_PLAYWRIGHT_SESSION__?: AuthSession;
  }
}

function unconfiguredClient(): AuthClient {
  return {
    configured: false,
    async getSession() {
      return null;
    },
    async signUp() {
      throw new Error('AUTH_NOT_CONFIGURED');
    },
    async signInWithPassword() {
      throw new Error('AUTH_NOT_CONFIGURED');
    },
    async signOut() {},
    onAuthStateChange() {
      return () => undefined;
    },
  };
}

function playwrightHarnessSession(): AuthSession | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const session = window.__CHARTER_PLAYWRIGHT_SESSION__;
  if (
    !session ||
    typeof session.accessToken !== 'string' ||
    session.accessToken.length === 0 ||
    !session.user ||
    typeof session.user.id !== 'string' ||
    session.user.id.length === 0
  ) {
    return null;
  }
  return {
    accessToken: session.accessToken,
    user: {
      id: session.user.id,
      email: session.user.email ?? null,
      name: session.user.name ?? null,
    },
  };
}

function playwrightHarnessClient(session: AuthSession): AuthClient {
  return {
    configured: true,
    async getSession() {
      return session;
    },
    async signUp() {
      return session;
    },
    async signInWithPassword() {
      return session;
    },
    async signOut() {},
    onAuthStateChange() {
      return () => undefined;
    },
  };
}

export function createBrowserAuthClient(env: BrowserAuthEnv = import.meta.env): AuthClient {
  const harness = playwrightHarnessSession();
  if (harness) {
    return playwrightHarnessClient(harness);
  }
  const url = env.VITE_SUPABASE_URL?.trim();
  const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !publishableKey) {
    return unconfiguredClient();
  }

  const supabase = createClient(url, publishableKey, {
    auth: {
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true,
    },
  });
  return {
    configured: true,
    async getSession() {
      const { data, error } = await supabase.auth.getSession();
      if (error) {
        throw error;
      }
      return mapSession(data.session);
    },
    async signUp(credentials) {
      const redirectTo =
        credentials.options?.emailRedirectTo?.trim() || emailRedirectTo(publicAppOrigin(env));
      const { data, error } = await supabase.auth.signUp({
        email: credentials.email,
        password: credentials.password,
        options: {
          ...credentials.options,
          ...(redirectTo ? { emailRedirectTo: redirectTo } : {}),
        },
      });
      if (error) {
        throw error;
      }
      return mapSession(data.session);
    },
    async signInWithPassword(credentials) {
      const { data, error } = await supabase.auth.signInWithPassword(credentials);
      if (error) {
        throw error;
      }
      const session = mapSession(data.session);
      if (!session) {
        throw new Error('AUTH_SESSION_MISSING');
      }
      return session;
    },
    async signOut() {
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) {
        throw error;
      }
    },
    onAuthStateChange(listener) {
      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        listener(mapSession(session));
      });
      return () => data.subscription.unsubscribe();
    },
  };
}

export function authErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'AUTH_ERROR';
}

export function AuthProvider({ client, children }: { client: AuthClient; children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(client.configured);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<AuthSession | null>(null);
  sessionRef.current = session;

  useEffect(() => {
    let active = true;
    const unsubscribe = client.onAuthStateChange((next) => {
      if (active) {
        setSession(next);
        setError(null);
        setLoading(false);
      }
    });
    void client
      .getSession()
      .then((next) => {
        if (active) {
          setSession(next);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(authErrorMessage(cause));
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [client]);

  const getAccessToken = useCallback(async () => sessionRef.current?.accessToken ?? null, []);
  useEffect(() => {
    setAccessTokenProvider(getAccessToken);
    return () => setAccessTokenProvider(async () => null);
  }, [getAccessToken]);

  const value = useMemo<AuthContextValue>(
    () => ({
      configured: client.configured,
      loading,
      session,
      error,
      async signUp(credentials) {
        try {
          const next = await client.signUp(credentials);
          setSession(next);
          setError(null);
          return next;
        } catch (cause) {
          setError(authErrorMessage(cause));
          throw cause;
        }
      },
      async signInWithPassword(credentials) {
        try {
          const next = await client.signInWithPassword(credentials);
          setSession(next);
          setError(null);
          return next;
        } catch (cause) {
          setError(authErrorMessage(cause));
          throw cause;
        }
      },
      async signOut() {
        try {
          await client.signOut();
          setSession(null);
          setError(null);
        } catch (cause) {
          setError(authErrorMessage(cause));
          throw cause;
        }
      },
      getAccessToken,
    }),
    [client, error, getAccessToken, loading, session],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('AUTH_PROVIDER_REQUIRED');
  }
  return context;
}
