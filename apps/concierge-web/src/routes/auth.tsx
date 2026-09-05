import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { authErrorMessage, useAuth } from '../auth';
import { DEFAULT_SIGNED_IN_PATH, safeNextPath } from '../navigation';
import { RouteStatus } from '../route-guards';

function AuthPage({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const next = safeNextPath(search.get('next')) ?? DEFAULT_SIGNED_IN_PATH;
  const query = new URLSearchParams({ next }).toString();

  if (auth.loading) {
    return (
      <RouteStatus
        title="Checking your session"
        body="Charter is checking whether this browser is already signed in."
      />
    );
  }
  if (auth.session) {
    return <Navigate replace to={next} />;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.configured || busy) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      if (mode === 'sign-up') {
        const session = await auth.signUp({
          email: email.trim().toLowerCase(),
          password,
          options: { data: { name: name.trim() } },
        });
        if (!session) {
          setMessage('Check your email to confirm the account, then return to sign in.');
          return;
        }
      } else {
        await auth.signInWithPassword({
          email: email.trim().toLowerCase(),
          password,
        });
      }
      navigate(next, { replace: true });
    } catch (cause) {
      setMessage(authErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const creating = mode === 'sign-up';
  return (
    <section className="auth-page">
      <div className="auth-context fade">
        <p className="eyebrow">A verified account, many roles</p>
        <h2>Buy from a shop and operate the shops you belong to.</h2>
        <p>
          Charter derives membership and platform access from the API. This form never chooses a
          role.
        </p>
      </div>
      <form className="auth-sheet" onSubmit={(event) => void submit(event)}>
        <p className="eyebrow">{creating ? 'New account' : 'Welcome back'}</p>
        <h1 data-route-heading tabIndex={-1}>
          {creating ? 'Create your Charter account' : 'Sign in to Charter'}
        </h1>
        {!auth.configured ? (
          <div className="configuration-note" role="status">
            <strong>Authentication is not configured for this local build.</strong>
            <span>
              Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to the frontend environment.
            </span>
          </div>
        ) : null}
        {creating ? (
          <label>
            Name
            <input
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </label>
        ) : null}
        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete={creating ? 'new-password' : 'current-password'}
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        {message || auth.error ? (
          <p className="form-message" role="alert">
            {message ?? auth.error}
          </p>
        ) : null}
        <button type="submit" disabled={!auth.configured || busy}>
          {busy ? 'Working…' : creating ? 'Create account' : 'Sign in'}
        </button>
        <p className="form-switch">
          {creating ? 'Already have an account?' : 'Need an account?'}{' '}
          <Link to={`/auth/${creating ? 'sign-in' : 'sign-up'}?${query}`}>
            {creating ? 'Sign in' : 'Create one'}
          </Link>
        </p>
      </form>
    </section>
  );
}

export function SignInPage() {
  return <AuthPage mode="sign-in" />;
}

export function SignUpPage() {
  return <AuthPage mode="sign-up" />;
}
