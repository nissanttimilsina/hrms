import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ClipboardCheck, ClipboardList, DoorOpen, MessageSquareQuote, Workflow, GraduationCap, CalendarClock } from 'lucide-react';
import { Card } from '@hrms/shared-ui';
import { api, useAuth } from '../lib.jsx';

/** Dashboard list of things waiting for this person across the HR modules. Hidden when there is nothing. */
export function ForYou() {
  const a = useAuth();
  const me = a.employeeId;
  const on = (f, p) => a.feature(f) && (!p || a.can(p));
  const q = (key, path, enabled) => useQuery({ queryKey: key, queryFn: () => api.get(path), enabled: !!enabled, retry: false, staleTime: 60_000 });
  const journey = q(['onboarding-mine'], '/onboarding/mine', me && on('onboarding', 'onboarding:view'));
  const surveys = q(['surveys'], '/engagement/surveys', me && on('engagement', 'engagement:view'));
  const reviews = q(['appraisals', 'mine'], '/appraisals?view=mine', me && on('kpi_appraisal', 'appraisals:view'));
  const feedback = q(['feedback-mine'], '/appraisals/feedback/mine', me && on('kpi_appraisal', 'appraisals:view'));
  const inbox = q(['requests-inbox'], '/workflows/requests?view=approvals', on('workflows', 'requests:view'));
  const training = q(['training-summary'], '/training/summary', on('training', 'training:view'));
  const interviews = q(['my-interviews'], '/recruitment/interviews', on('recruitment'));
  const items = [];
  const j = journey.data;
  if (j?.status === 'OPEN') items.push({ to: `/onboarding/${j.id}`, icon: DoorOpen, text: j.kind === 'ONBOARDING' ? 'Your first-days checklist has steps for you' : 'Your exit checklist has steps for you' });
  (surveys.data ?? []).filter((s) => s.myTurn).forEach((s) => items.push({ to: `/surveys/${s.id}`, icon: ClipboardList, text: `Answer the survey: ${s.title}` }));
  (reviews.data ?? []).filter((r) => r.status === 'SELF_REVIEW').forEach((r) => items.push({ to: `/appraisals/${r.id}`, icon: ClipboardCheck, text: `Write your self review for ${r.cycle.name}` }));
  (reviews.data ?? []).filter((r) => r.status === 'COMPLETED').forEach((r) => items.push({ to: `/appraisals/${r.id}`, icon: ClipboardCheck, text: `Your review for ${r.cycle.name} is ready to read` }));
  const fb = (feedback.data ?? []).filter((f) => f.open).length;
  if (fb) items.push({ to: '/me/appraisals?tab=feedback', icon: MessageSquareQuote, text: `${fb} colleague${fb === 1 ? '' : 's'} asked for your feedback` });
  const n = inbox.data?.length ?? 0;
  if (n) items.push({ to: '/requests', icon: Workflow, text: `${n} request${n === 1 ? '' : 's'} waiting for your approval` });
  const tr = training.data?.team?.requests ?? 0;
  if (tr) items.push({ to: '/training?tab=requests', icon: GraduationCap, text: `${tr} training request${tr === 1 ? '' : 's'} to decide` });
  const iv = (interviews.data ?? []).filter((i) => !i.myFeedback && new Date(i.scheduledAt) < new Date(Date.now() + 86_400_000)).length;
  if (iv) items.push({ to: '/interviews', icon: CalendarClock, text: `${iv} interview${iv === 1 ? '' : 's'} today or due a scorecard` });
  if (!items.length) return null;
  return (
    <Card>
      <p className="border-b border-line px-5 py-3 text-sm font-semibold text-ink-900">Waiting for you</p>
      <ul className="divide-y divide-line">
        {items.map((x, i) => (
          <li key={i}><Link to={x.to} className="flex items-center gap-3 px-5 py-3 text-sm hover:bg-subtle"><x.icon className="size-4 shrink-0 text-brand-600" /><span className="min-w-0 flex-1 text-ink-900">{x.text}</span><ArrowRight className="size-4 shrink-0 text-ink-400" /></Link></li>
        ))}
      </ul>
    </Card>
  );
}
