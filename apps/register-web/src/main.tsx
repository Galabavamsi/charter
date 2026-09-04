import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@charter/ui/tokens.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <main style={{ maxWidth: 680, margin: '12vh auto', padding: '1.5rem' }}>
      <p>Charter</p>
      <h1>Register moved into the canonical account shell.</h1>
      <p>The retired development surface no longer makes unauthenticated merchant API calls.</p>
      <a href="/merchant">Open Register</a>
    </main>
  </StrictMode>,
);
