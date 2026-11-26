import { useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { Button, Field, Input } from '@hrms/shared-ui';
import { api, useAuth, isGenericHost } from '../lib.jsx';

const Frame = ({ title, subtitle, children }) => (
  <div className="grid min-h-dvh place-items-center bg-canvas p-4">
    <div className="w-full max-w-sm rounded-xl border border-line bg-white p-8 shadow-card">
      <h1 className="text-xl font-semibold">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-ink-500">{subtitle}</p>}
      <div className="mt-6">{children}</div>
    </div>
  </div>
);

export function Login() {
  const { login } = useAuth();
  const [v, setV] = useState({ email: '', password: '', workspace: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const generic = isGenericHost();
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await login({ email: v.email, password: v.password, ...(generic && { workspace: v.workspace }) }); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <Frame title="Sign in" subtitle={generic ? 'Enter your company workspace and credentials' : window.location.hostname}>
      <form onSubmit={submit} className="space-y-4">
        {generic && <Field label="Workspace" required><Input value={v.workspace} onChange={(e) => setV({ ...v, workspace: e.target.value.toLowerCase() })} placeholder="yourcompany" /></Field>}
        <Field label="Email" required><Input type="email" autoComplete="username" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} /></Field>
        <Field label="Password" required error={err}><Input type="password" autoComplete="current-password" value={v.password} onChange={(e) => setV({ ...v, password: e.target.value })} /></Field>
        <Button type="submit" className="w-full" loading={busy}>Sign in</Button>
        <p className="text-center text-sm"><Link to="/forgot-password" className="text-brand-700">Forgot password?</Link></p>
      </form>
    </Frame>
  );
}

function SetPassword({ title, subtitle, onSubmit, askName }) {
  const [v, setV] = useState({ password: '', confirm: '', fullName: '' });
  const [err, setErr] = useState({});
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const submit = async (e) => {
    e.preventDefault();
    if (v.password !== v.confirm) { setErr({ confirm: 'Passwords do not match' }); return; }
    setBusy(true); setErr({});
    try { await onSubmit(v); setDone(true); } catch (x) { setErr({ ...x.fieldErrors, _: x.code === 'VALIDATION_ERROR' ? undefined : x.message }); } finally { setBusy(false); }
  };
  if (done) return <Frame title="All set" subtitle="You can now sign in with your new password."><Button className="w-full" onClick={() => nav('/')}>Go to sign in</Button></Frame>;
  return (
    <Frame title={title} subtitle={subtitle}>
      <form onSubmit={submit} className="space-y-4">
        {askName && <Field label="Your full name"><Input value={v.fullName} onChange={(e) => setV({ ...v, fullName: e.target.value })} autoComplete="name" /></Field>}
        <Field label="New password" required hint="At least 10 characters with upper-case, lower-case and a number" error={err.password}><Input type="password" autoComplete="new-password" value={v.password} onChange={(e) => setV({ ...v, password: e.target.value })} /></Field>
        <Field label="Confirm password" required error={err.confirm || err._}><Input type="password" autoComplete="new-password" value={v.confirm} onChange={(e) => setV({ ...v, confirm: e.target.value })} /></Field>
        <Button type="submit" className="w-full" loading={busy}>Save password</Button>
      </form>
    </Frame>
  );
}

export function AcceptInvite() {
  const [p] = useSearchParams();
  return <SetPassword title="Join your team" subtitle="Set a password to activate your account." askName onSubmit={(v) => api.post('/auth/invitations/accept', { token: p.get('token'), password: v.password, ...(v.fullName && { fullName: v.fullName }) }, { auth: false })} />;
}
export function ResetPassword() {
  const [p] = useSearchParams();
  return <SetPassword title="Choose a new password" onSubmit={(v) => api.post('/auth/password/reset', { token: p.get('token'), password: v.password }, { auth: false })} />;
}
export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  return (
    <Frame title="Reset your password" subtitle="We'll email you a link to choose a new one.">
      {sent ? <p className="text-sm text-success-700">If an account exists for {email}, a reset link is on its way. It expires in 30 minutes.</p> : (
        <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); await api.post('/auth/password/forgot', { email }, { auth: false }).catch(() => {}); setSent(true); }}>
          <Field label="Email" required><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Button type="submit" className="w-full">Send reset link</Button>
        </form>
      )}
      <p className="mt-4 text-center text-sm"><Link to="/" className="text-brand-700">Back to sign in</Link></p>
    </Frame>
  );
}
