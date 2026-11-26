import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App.jsx';
import './styles.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } });
const tree = (
  <StrictMode>
    <QueryClientProvider client={queryClient}><BrowserRouter><App /></BrowserRouter></QueryClientProvider>
  </StrictMode>
);
const root = document.getElementById('root');
// Prerendered pages hydrate; everything else renders client-side.
if (root.hasChildNodes()) hydrateRoot(root, tree); else createRoot(root).render(tree);
