import { Navigate, useLocation } from 'react-router';

export function LegacyLoginRedirect() {
  const { pathname } = useLocation();
  const next = pathname.startsWith('/login/operator')
    ? '/control'
    : pathname.startsWith('/login/merchant')
      ? '/merchant'
      : '/chats';
  return <Navigate replace to={`/auth/sign-in?${new URLSearchParams({ next }).toString()}`} />;
}

export function LegacyAppRedirect() {
  const { pathname } = useLocation();
  const next = pathname.startsWith('/app/control')
    ? '/control'
    : pathname.startsWith('/app/register')
      ? '/merchant'
      : '/chats';
  return <Navigate replace to={next} />;
}
