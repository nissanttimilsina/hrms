import { Container, Seo, ButtonLink } from '../components/core.jsx';

export default function NotFound() {
  return (
    <Container className="max-w-xl py-24 text-center">
      <Seo title="Page not found" noindex />
      <p className="text-sm font-semibold text-brand-600">404</p>
      <h1 className="mt-2 text-3xl font-semibold">We couldn’t find that page</h1>
      <p className="mt-3 text-ink-500">The page may have moved. Try the homepage or our features.</p>
      <div className="mt-8 flex justify-center gap-3"><ButtonLink to="/" size="md">Go home</ButtonLink><ButtonLink to="/features" variant="secondary" size="md">See features</ButtonLink></div>
    </Container>
  );
}
