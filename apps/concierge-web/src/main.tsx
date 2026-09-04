import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@charter/ui/tokens.css';
import './charter.css';
import './product.css';
import './merchant.css';
import { App, createAppBrowserRouter } from './App';

const router = createAppBrowserRouter();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div className="bloom" />
    <App router={router} />
  </StrictMode>,
);
