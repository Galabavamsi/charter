import { useEffect, useState } from 'react';
import { isRouteErrorResponse, useRouteError } from 'react-router';
import { useDocumentTitle } from './document-title';
import { RouteStatus } from './route-guards';

const RELOAD_KEY = 'charter.chunk-reload-at';
const RELOAD_WINDOW_MS = 60_000;

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? '');
  return /dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError|Loading chunk/i.test(
    message,
  );
}

// After a redeploy the old hashed chunks are gone, and one reload picks up the new
// index. The timestamp stops a reload loop when the chunk is really missing.
function claimAutoReload(): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < RELOAD_WINDOW_MS) {
      return false;
    }
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

function ErrorActions() {
  return (
    <>
      <button type="button" className="primary-link" onClick={() => window.location.reload()}>
        Reload
      </button>
      <a className="quiet-link" href="/">
        Home
      </a>
    </>
  );
}

export function RouteErrorPage() {
  const error = useRouteError();
  const chunkFailure = isChunkLoadError(error);
  const [reloading, setReloading] = useState(false);
  useDocumentTitle('Something went wrong — Charter');

  useEffect(() => {
    if (chunkFailure && claimAutoReload()) {
      setReloading(true);
      window.location.reload();
    }
  }, [chunkFailure]);

  if (reloading) {
    return (
      <RouteStatus
        title="Updating Charter"
        body="A newer version was just deployed. Reloading this page…"
      />
    );
  }
  if (chunkFailure) {
    return (
      <RouteStatus
        alert
        title="Charter was updated"
        body="This page needs a fresh copy of the app. Reload to continue."
        action={<ErrorActions />}
      />
    );
  }
  if (isRouteErrorResponse(error) && error.status === 404) {
    return (
      <RouteStatus
        code="404"
        title="Page not found"
        body="That Charter route does not exist."
        action={<ErrorActions />}
      />
    );
  }
  return (
    <RouteStatus
      alert
      title="Something went wrong"
      body="This page hit an unexpected error. Reload, or head back to the start."
      action={<ErrorActions />}
    />
  );
}
