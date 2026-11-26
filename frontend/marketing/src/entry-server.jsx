import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App, { STATIC_ROUTES } from './App.jsx';
import { HeadContext } from './components/core.jsx';
import { FEATURES } from './content/features.js';
import { INDUSTRIES } from './content/industries.js';

export const routes = [...STATIC_ROUTES, ...FEATURES.map((f) => `/features/${f.slug}`), ...INDUSTRIES.map((i) => `/industries/${i.slug}`)];

export function render(url) {
  const head = {};
  const html = renderToString(
    <HeadContext.Provider value={head}>
      <QueryClientProvider client={new QueryClient()}><StaticRouter location={url}><App /></StaticRouter></QueryClientProvider>
    </HeadContext.Provider>,
  );
  return { html, head };
}
