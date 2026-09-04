// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountProvider, ApiProvider, useAccount, type AccountProfile } from './account';
import type { ApiClient } from './api';
import { AuthProvider, type AuthClient, type AuthSession } from './auth';

const userA: AuthSession = {
  accessToken: 'token-a',
  user: { id: 'user-a', email: 'a@example.com', name: 'User A' },
};
const userB: AuthSession = {
  accessToken: 'token-b',
  user: { id: 'user-b', email: 'b@example.com', name: 'User B' },
};

function profile(session: AuthSession): AccountProfile {
  return {
    profile: { userId: session.user.id, email: session.user.email ?? undefined },
    shops: [],
    platformRoles: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function switchableClient(initial: AuthSession) {
  let session: AuthSession | null = initial;
  const listeners = new Set<(next: AuthSession | null) => void>();
  const client: AuthClient & { switchTo(next: AuthSession | null): void } = {
    configured: true,
    getSession: vi.fn(async () => session),
    signUp: vi.fn(async () => session),
    signInWithPassword: vi.fn(async () => {
      if (!session) {
        throw new Error('AUTH_SESSION_MISSING');
      }
      return session;
    }),
    signOut: vi.fn(async () => {
      session = null;
      listeners.forEach((listener) => listener(session));
    }),
    onAuthStateChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    switchTo(next) {
      session = next;
      listeners.forEach((listener) => listener(session));
    },
  };
  return client;
}

function AccountProbe() {
  const { account, status } = useAccount();
  return (
    <div>
      <span>status:{status}</span>
      <span>account:{account?.profile.userId ?? 'none'}</span>
    </div>
  );
}

function renderAccount(client: AuthClient, api: ApiClient) {
  return render(
    <AuthProvider client={client}>
      <ApiProvider client={api}>
        <AccountProvider>
          <AccountProbe />
        </AccountProvider>
      </ApiProvider>
    </AuthProvider>,
  );
}

afterEach(cleanup);

describe('AccountProvider session isolation', () => {
  it('aborts and ignores a stale account response after switching users', async () => {
    const staleA = deferred<AccountProfile>();
    const firstSignals: AbortSignal[] = [];
    const api = vi.fn(async (_path: string, init?: RequestInit) => {
      if (firstSignals.length === 0) {
        if (init?.signal) {
          firstSignals.push(init.signal);
        }
        return staleA.promise;
      }
      return profile(userB);
    }) as ApiClient;
    const client = switchableClient(userA);

    renderAccount(client, api);
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));

    act(() => client.switchTo(userB));

    expect(await screen.findByText('account:user-b')).toBeVisible();
    expect(firstSignals[0]?.aborted).toBe(true);

    await act(async () => staleA.resolve(profile(userA)));

    expect(screen.getByText('account:user-b')).toBeVisible();
    expect(screen.queryByText('account:user-a')).not.toBeInTheDocument();
  });

  it('clears the previous profile while the next user account is loading', async () => {
    const delayedB = deferred<AccountProfile>();
    let calls = 0;
    const api = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return profile(userA);
      }
      return delayedB.promise;
    }) as ApiClient;
    const client = switchableClient(userA);

    renderAccount(client, api);
    expect(await screen.findByText('account:user-a')).toBeVisible();

    act(() => client.switchTo(userB));

    await waitFor(() => expect(screen.getByText('status:loading')).toBeVisible());
    expect(screen.getByText('account:none')).toBeVisible();
    expect(screen.queryByText('account:user-a')).not.toBeInTheDocument();

    await act(async () => delayedB.resolve(profile(userB)));
    expect(await screen.findByText('account:user-b')).toBeVisible();
  });
});
