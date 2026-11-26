import { Routes, Route, Outlet } from 'react-router-dom';
import { Header, Footer, ScrollToTop } from './components/core.jsx';
import Home from './pages/Home.jsx';
import { Features, FeatureDetail, Industries, IndustryDetail, Pricing } from './pages/Product.jsx';
import { About, Contact, Demo, Customers, Faq, Help, Status, Blog, BlogPost, Changelog, CmsPage, Signup, VerifyEmail, Login } from './pages/Site.jsx';
import NotFound from './pages/NotFound.jsx';

function Layout() {
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2">Skip to content</a>
      <ScrollToTop />
      <Header />
      <main id="main" className="flex-1"><Outlet /></main>
      <Footer />
    </div>
  );
}

/** Static routes are prerendered to HTML at build time (see scripts/prerender.mjs). */
export const STATIC_ROUTES = ['/', '/features', '/industries', '/pricing', '/about', '/contact', '/demo', '/customers', '/faq', '/help', '/status',
  '/blog', '/resources', '/changelog', '/privacy', '/terms', '/security', '/signup', '/login'];

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="features" element={<Features />} />
        <Route path="features/:slug" element={<FeatureDetail />} />
        <Route path="industries" element={<Industries />} />
        <Route path="industries/:slug" element={<IndustryDetail />} />
        <Route path="pricing" element={<Pricing />} />
        <Route path="about" element={<About />} />
        <Route path="contact" element={<Contact />} />
        <Route path="demo" element={<Demo />} />
        <Route path="customers" element={<Customers />} />
        <Route path="faq" element={<Faq />} />
        <Route path="help" element={<Help />} />
        <Route path="status" element={<Status />} />
        <Route path="blog" element={<Blog />} />
        <Route path="blog/:slug" element={<BlogPost />} />
        <Route path="resources" element={<Blog tag="guide" title="Resources" intro="Practical HR and payroll guides for businesses in Nepal." path="/resources" />} />
        <Route path="changelog" element={<Changelog />} />
        <Route path="privacy" element={<CmsPage slug="privacy-policy" />} />
        <Route path="terms" element={<CmsPage slug="terms-of-service" />} />
        <Route path="security" element={<CmsPage slug="security" />} />
        <Route path="signup" element={<Signup />} />
        <Route path="verify-email" element={<VerifyEmail />} />
        <Route path="login" element={<Login />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
