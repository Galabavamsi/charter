import { useState } from 'react';
import {
  createBrowserRouter,
  createMemoryRouter,
  type DataRouter,
  type RouteObject,
} from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { AccountProvider, ApiProvider } from './account';
import { apiFetch, type ApiClient } from './api';
import { AppFrame } from './AppFrame';
import { AuthProvider, createBrowserAuthClient, type AuthClient } from './auth';
import {
  RequireAccount,
  RequireAuth,
  RequirePlatformRole,
  RequireRecoveryOperate,
  RequireShopMembership,
} from './route-guards';
import { OrbPickerPage } from './OrbPicker';

function InitialRouteFallback() {
  return <p className="route-loading">Opening Charter…</p>;
}

export const appRoutes: RouteObject[] = [
  {
    Component: AppFrame,
    HydrateFallback: InitialRouteFallback,
    children: [
      {
        path: 'orb-picker',
        Component: OrbPickerPage,
      },
      {
        index: true,
        lazy: async () => ({ Component: (await import('./routes/public')).HomePage }),
      },
      {
        path: 'shops',
        lazy: async () => ({ Component: (await import('./routes/public')).ShopsPage }),
      },
      {
        path: 'shops/:slug',
        lazy: async () => ({ Component: (await import('./routes/public')).ShopPage }),
      },
      {
        path: 's/:slug',
        lazy: async () => ({
          Component: (await import('./routes/public')).CanonicalShopRedirect,
        }),
      },
      {
        path: 'auth/sign-in',
        lazy: async () => ({ Component: (await import('./routes/auth')).SignInPage }),
      },
      {
        path: 'auth/sign-up',
        lazy: async () => ({ Component: (await import('./routes/auth')).SignUpPage }),
      },
      {
        path: 'login/*',
        lazy: async () => ({
          Component: (await import('./routes/legacy')).LegacyLoginRedirect,
        }),
      },
      {
        path: 'app/*',
        lazy: async () => ({
          Component: (await import('./routes/legacy')).LegacyAppRedirect,
        }),
      },
      {
        Component: RequireAuth,
        children: [
          {
            path: 'chats',
            lazy: async () => ({ Component: (await import('./routes/buyer')).BuyerHomePage }),
          },
          {
            path: 'buyer/:slug',
            lazy: async () => ({ Component: (await import('./routes/buyer')).BuyerPage }),
          },
          {
            path: 'buyer/:slug/chat/:id',
            lazy: async () => ({ Component: (await import('./routes/buyer')).BuyerPage }),
          },
          {
            path: 'orders',
            lazy: async () => ({
              Component: (await import('./routes/account-pages')).OrdersPage,
            }),
          },
          {
            path: 'orders/:id',
            lazy: async () => ({
              Component: (await import('./routes/account-pages')).OrderPage,
            }),
          },
          {
            Component: RequireAccount,
            children: [
              {
                path: 'account',
                lazy: async () => ({
                  Component: (await import('./routes/account-pages')).AccountPage,
                }),
              },
              {
                path: 'merchant',
                lazy: async () => ({
                  Component: (await import('./routes/merchant')).MerchantIndexPage,
                }),
              },
              {
                Component: RequireShopMembership,
                children: [
                  {
                    path: 'merchant/shops/:shopId',
                    lazy: async () => ({
                      Component: (await import('./routes/merchant')).MerchantShell,
                    }),
                    children: [
                      {
                        index: true,
                        lazy: async () => ({
                          Component: (await import('./routes/merchant')).MerchantOverviewRedirect,
                        }),
                      },
                      {
                        path: 'overview',
                        lazy: async () => ({
                          Component: (await import('./routes/merchant-overview'))
                            .MerchantOverviewPage,
                        }),
                      },
                      {
                        path: 'catalog',
                        lazy: async () => ({
                          Component: (await import('./routes/merchant-catalog'))
                            .MerchantCatalogPage,
                        }),
                      },
                      {
                        path: 'orders',
                        lazy: async () => ({
                          Component: (await import('./routes/merchant-orders')).MerchantOrdersPage,
                        }),
                      },
                      {
                        Component: RequireRecoveryOperate,
                        children: [
                          {
                            path: 'recovery',
                            lazy: async () => ({
                              Component: (await import('./routes/merchant-recovery'))
                                .MerchantRecoveryPage,
                            }),
                          },
                        ],
                      },
                      {
                        path: 'rules',
                        lazy: async () => ({
                          Component: (await import('./routes/merchant-rules')).MerchantRulesPage,
                        }),
                      },
                      {
                        path: 'settings',
                        lazy: async () => ({
                          Component: (await import('./routes/merchant-settings'))
                            .MerchantSettingsPage,
                        }),
                      },
                    ],
                  },
                ],
              },
              {
                Component: RequirePlatformRole,
                children: [
                  {
                    path: 'control/*',
                    lazy: async () => ({
                      Component: (await import('./routes/control')).ControlPage,
                    }),
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        path: '*',
        lazy: async () => ({ Component: (await import('./routes/public')).NotFoundPage }),
      },
    ],
  },
];

export function createAppBrowserRouter(): DataRouter {
  return createBrowserRouter(appRoutes);
}

export function createAppMemoryRouter(initialEntries: string[]): DataRouter {
  return createMemoryRouter(appRoutes, { initialEntries });
}

export function App({
  router,
  authClient,
  apiClient = apiFetch,
}: {
  router: DataRouter;
  authClient?: AuthClient;
  apiClient?: ApiClient;
}) {
  const [client] = useState(() => authClient ?? createBrowserAuthClient());
  return (
    <AuthProvider client={client}>
      <ApiProvider client={apiClient}>
        <AccountProvider>
          <RouterProvider router={router} />
        </AccountProvider>
      </ApiProvider>
    </AuthProvider>
  );
}
