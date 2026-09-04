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
import { ApiError, apiFetch, type ApiClient } from './api';
import { useAuth } from './auth';

export type ShopRole = 'owner' | 'admin' | 'catalog' | 'support' | 'finance' | 'viewer';
export type PlatformRole = 'admin' | 'operator' | 'auditor';

export type AccountShop = {
  tenantId: string;
  slug: string;
  name: string;
  label: string;
  blurb: string;
  currency: 'INR';
  status: 'draft' | 'published' | 'suspended' | 'archived';
  synthetic: boolean;
  role: ShopRole;
};

export type AccountProfile = {
  profile: {
    userId: string;
    email?: string;
  };
  shops: AccountShop[];
  platformRoles: PlatformRole[];
};

type AccountStatus = 'idle' | 'loading' | 'ready' | 'unauthorized' | 'forbidden' | 'error';

type AccountContextValue = {
  status: AccountStatus;
  account: AccountProfile | null;
  error: ApiError | Error | null;
  refresh(): Promise<void>;
};

const ApiContext = createContext<ApiClient>(apiFetch);
const AccountContext = createContext<AccountContextValue | null>(null);

export function ApiProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiClient {
  return useContext(ApiContext);
}

export function AccountProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const { session, loading: authLoading } = useAuth();
  const [status, setStatus] = useState<AccountStatus>('idle');
  const [account, setAccount] = useState<AccountProfile | null>(null);
  const [accountUserId, setAccountUserId] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const generation = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const sessionUserId = session?.user.id ?? null;
  const sessionAccessToken = session?.accessToken ?? null;

  const load = useCallback(async () => {
    const requestGeneration = ++generation.current;
    activeRequest.current?.abort();
    activeRequest.current = null;

    if (!sessionUserId) {
      setAccount(null);
      setAccountUserId(null);
      setError(null);
      setStatus(authLoading ? 'loading' : 'idle');
      return;
    }

    const controller = new AbortController();
    activeRequest.current = controller;
    setAccount(null);
    setAccountUserId(sessionUserId);
    setStatus('loading');
    setError(null);
    try {
      const next = await api<AccountProfile>('/v1/me', { signal: controller.signal });
      if (requestGeneration !== generation.current || controller.signal.aborted) {
        return;
      }
      if (next.profile.userId !== sessionUserId) {
        throw new Error('ACCOUNT_IDENTITY_MISMATCH');
      }
      setAccount(next);
      setStatus('ready');
    } catch (cause) {
      if (requestGeneration !== generation.current || controller.signal.aborted) {
        return;
      }
      const normalized = cause instanceof Error ? cause : new Error('ACCOUNT_LOAD_FAILED');
      setAccount(null);
      setError(normalized);
      setStatus(
        cause instanceof ApiError && cause.status === 401
          ? 'unauthorized'
          : cause instanceof ApiError && cause.status === 403
            ? 'forbidden'
            : 'error',
      );
    }
  }, [api, authLoading, sessionAccessToken, sessionUserId]);

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, [load]);

  const accountMatchesSession = accountUserId === sessionUserId;
  const visibleAccount = accountMatchesSession ? account : null;
  const visibleStatus: AccountStatus = sessionUserId
    ? accountMatchesSession
      ? status
      : 'loading'
    : authLoading
      ? 'loading'
      : 'idle';
  const value = useMemo(
    () => ({
      status: visibleStatus,
      account: visibleAccount,
      error: accountMatchesSession ? error : null,
      refresh: load,
    }),
    [accountMatchesSession, error, load, visibleAccount, visibleStatus],
  );
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountContextValue {
  const context = useContext(AccountContext);
  if (!context) {
    throw new Error('ACCOUNT_PROVIDER_REQUIRED');
  }
  return context;
}
