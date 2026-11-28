import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, Flag, MessageSquareQuote, Plus, Rocket, Target, ClipboardCheck } from 'lucide-react';
import { Button, Card, CardBody, CardHeader, DataTable, Dialog, EmptyState, Field, Input, Select, Skeleton, Textarea, Checkbox, Badge, cn } from '@hrms/shared-ui';
import { api, useAuth, useAction, PageHeader, StatusBadge, dt, todayKtm } from '../lib.jsx';
import { PersonPicker, PeoplePicker, Tabs, Progress, BackLink, ErrorNote, Rating, RATING_LABELS, label, useDownload } from './kit.jsx';

const A_STATUS = { SELF_REVIEW: 'Self review', MANAGER_REVIEW: 'Manager review', HR_REVIEW: 'HR sign-off', COMPLETED: 'Ready to read', ACKNOWLEDGED: 'Done' };
const A_TONE = { SELF_REVIEW: 'warning', MANAGER_REVIEW: 'info', HR_REVIEW: 'brand', COMPLETED: 'success', ACKNOWLEDGED: 'neutral' };
const G_STATUS = [['ACTIVE', 'Active'], ['ACHIEVED', 'Achieved'], ['PARTLY_ACHIEVED', 'Partly achieved'], ['MISSED', 'Missed'], ['DROPPED', 'Dropped']];
const RECS = [['NONE', 'No change'], ['CONFIRM', 'Confirm employment'], ['INCREMENT', 'Salary increase'], ['PROMOTION', 'Promotion'], ['TRAINING', 'Training'], ['PIP', 'Improvement plan'], ['EXTEND_PROBATION', 'Extend probation']];
const AStatus = ({ s }) => <Badge tone={A_TONE[s]} dot>{A_STATUS[s]}</Badge>;
const fmt = (n) => (n == null ? '—' : Number(n).toFixed(2).replace(/\.?0+$/, ''));

// =========================================================================== goals
function GoalDialog({ goal, employeeId, onClose }) {
  const [v, setV] = useState(() => ({ title: goal?.title ?? '', description: goal?.description ?? '', measure: goal?.measure ?? '', target: goal?.target ?? '', weight: goal?.weight ?? 0, dueDate: goal?.dueDate ?? '' }));
  const save = useAction((b) => (goal ? api.patch(`/appraisals/goals/${goal.id}`, b) : api.post('/appraisals/goals', b)), { success: 'Goal saved', invalidate: [['goals'], ['team-goals'], ['appraisal']], onDone: onClose });
  const fe = save.error?.fieldErrors ?? {};
  const set = (k) => (e) => setV((p) => ({ ...p, [k]: e.target.value }));
  return (
    <Dialog open onClose={onClose} title={goal ? 'Edit goal' : 'New goal'} description="A clear, measurable result to reach by a date." size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate({ ...(!goal && employeeId && { employeeId }), title: v.title, description: v.description || undefined, measure: v.measure || undefined, target: v.target || undefined, weight: Number(v.weight) || 0, dueDate: v.dueDate || null })}>Save</Button></>}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="Goal" required error={fe.title} className="sm:col-span-2"><Input value={v.title} maxLength={200} onChange={set('title')} placeholder="e.g. Grow monthly sales in Lalitpur" /></Field>
        <Field label="How it is measured"><Input value={v.measure} maxLength={200} onChange={set('measure')} placeholder="e.g. Monthly sales (NPR)" /></Field>
        <Field label="Target"><Input value={v.target} maxLength={120} onChange={set('target')} placeholder="e.g. 15 lakh" /></Field>
        <Field label="Weight (%)" error={fe.weight} hint="How much it counts in the review. All goals together: 100% at most."><Input type="number" min="0" max="100" value={v.weight} onChange={set('weight')} /></Field>
        <Field label="Due"><Input type="date" value={v.dueDate} onChange={set('dueDate')} /></Field>
        <Field label="Details" className="sm:col-span-2"><Textarea rows={2} value={v.description} onChange={set('description')} /></Field>
      </div>
    </Dialog>
  );
}

function ProgressDialog({ goal, onClose }) {
  const [v, setV] = useState({ progress: goal.progress, actual: goal.actual ?? '', status: goal.status });
  const save = useAction((b) => api.patch(`/appraisals/goals/${goal.id}`, b), { success: 'Progress saved', invalidate: [['goals'], ['team-goals']], onDone: onClose });
  return (
    <Dialog open onClose={onClose} title="Update progress" description={goal.title}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate({ progress: Number(v.progress), actual: v.actual || undefined, ...(goal.canChangeStatus && v.status !== goal.status && { status: v.status }) })}>Save</Button></>}>
      <div className="space-y-4">
        <Field label={`Progress: ${v.progress}%`}><input type="range" min="0" max="100" step="5" value={v.progress} onChange={(e) => setV({ ...v, progress: e.target.value })} className="w-full accent-brand-600" aria-label="Progress" /></Field>
        <Field label="Result so far" hint={goal.target ? `Target: ${goal.target}` : undefined}><Input value={v.actual} maxLength={120} onChange={(e) => setV({ ...v, actual: e.target.value })} /></Field>
        {goal.canChangeStatus && <Field label="Outcome"><Select value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })} options={G_STATUS.map(([value, l]) => ({ value, label: l }))} /></Field>}
        <ErrorNote error={save.error} />
      </div>
    </Dialog>
  );
}

function GoalList({ goals, onEdit, onProgress, showPerson }) {
  if (!goals.length) return null;
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 [&>*]:min-w-0">
      {goals.map((g) => (
        <Card key={g.id}><CardBody>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">{showPerson && <p className="text-xs font-medium text-ink-500">{g.employee?.name}</p>}<p className="font-semibold text-ink-900">{g.title}</p><p className="text-xs text-ink-500">{[g.measure, g.target && `target ${g.target}`, g.dueDate && `by ${dt(g.dueDate)}`].filter(Boolean).join(' · ')}</p></div>
            <div className="flex shrink-0 flex-col items-end gap-1">{g.weight > 0 && <Badge>Weight {g.weight}%</Badge>}{g.status !== 'ACTIVE' && <Badge tone={g.status === 'ACHIEVED' ? 'success' : g.status === 'MISSED' ? 'danger' : 'neutral'}>{label(g.status)}</Badge>}</div>
          </div>
          <div className="mt-3"><Progress value={g.progress} tone={g.status === 'ACHIEVED' ? 'success' : 'brand'} /></div>
          {g.actual && <p className="mt-1 text-xs text-ink-500">Result: {g.actual}</p>}
          {(onEdit || onProgress) && g.canEdit !== false && g.status === 'ACTIVE' && (
            <div className="mt-3 flex gap-2">{onProgress && <Button size="sm" variant="secondary" onClick={() => onProgress(g)}>Update progress</Button>}{onEdit && g.canChangeStatus && <Button size="sm" variant="ghost" onClick={() => onEdit(g)}>Edit</Button>}</div>
          )}
        </CardBody></Card>
      ))}
    </div>
  );
}

export function MyGoals() {
  const { data = [], isPending } = useQuery({ queryKey: ['goals', 'mine'], queryFn: () => api.get('/appraisals/goals') });
  const [dlg, setDlg] = useState(null);
  const active = data.filter((g) => g.status === 'ACTIVE');
  const closed = data.filter((g) => !['ACTIVE', 'DROPPED'].includes(g.status));
  const weight = active.reduce((n, g) => n + g.weight, 0);
  return (
    <>
      <PageHeader title="My goals" description="What you are working towards, and how far you have got." actions={<Button onClick={() => setDlg({ new: true })}><Plus className="size-4" />New goal</Button>} />
      {isPending ? <Skeleton className="h-48" /> : !data.length ? (
        <Card><EmptyState icon={<Target className="size-5" />} title="No goals yet" description="Agree two to five goals with your manager. Clear goals make reviews fair." action={<Button onClick={() => setDlg({ new: true })}>New goal</Button>} /></Card>
      ) : (
        <div className="space-y-5">
          {active.length > 0 && weight !== 100 && weight > 0 && <p className="rounded-md bg-warning-50 px-3 py-2 text-sm text-warning-700">Your active goals add up to {weight}%. Agree weights that total 100% with your manager.</p>}
          <GoalList goals={active} onProgress={(g) => setDlg({ progress: g })} onEdit={(g) => setDlg({ edit: g })} />
          {closed.length > 0 && <><p className="text-sm font-semibold text-ink-700">Finished</p><GoalList goals={closed} /></>}
        </div>
      )}
      {dlg?.new && <GoalDialog onClose={() => setDlg(null)} />}
      {dlg?.edit && <GoalDialog goal={dlg.edit} onClose={() => setDlg(null)} />}
      {dlg?.progress && <ProgressDialog goal={dlg.progress} onClose={() => setDlg(null)} />}
    </>
  );
}

// =========================================================================== my appraisals
export function MyAppraisals() {
  const [sp] = useSearchParams();
  const [tab, setTab] = useState(sp.get('tab') ?? 'reviews');
  const { data = [], isPending } = useQuery({ queryKey: ['appraisals', 'mine'], queryFn: () => api.get('/appraisals?view=mine') });
  const { data: fb = [] } = useQuery({ queryKey: ['feedback-mine'], queryFn: () => api.get('/appraisals/feedback/mine') });
  const [give, setGive] = useState(null);
  const open = fb.filter((f) => f.open);
  return (
    <>
      <PageHeader title="My reviews" description="Your performance reviews, and feedback colleagues asked you for." />
      <Tabs value={tab} onChange={setTab} tabs={[['reviews', 'My reviews'], ['feedback', 'Feedback requests', open.length]]} />
      {tab === 'reviews' ? (isPending ? <Skeleton className="h-40" /> : !data.length ? (
        <Card><EmptyState icon={<ClipboardCheck className="size-5" />} title="No reviews yet" description="When HR starts a review cycle, your self review appears here." /></Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 [&>*]:min-w-0">
          {data.map((x) => (
            <Link key={x.id} to={`/appraisals/${x.id}`} className="block rounded-lg border border-line bg-surface p-4 shadow-card hover:border-brand-600">
              <div className="flex items-start justify-between gap-2"><p className="font-semibold text-ink-900">{x.cycle.name}</p><AStatus s={x.status} /></div>
              <p className="text-sm text-ink-500">{dt(x.cycle.periodStart)} – {dt(x.cycle.periodEnd)}{x.reviewer ? ` · reviewer ${x.reviewer.name}` : ''}</p>
              {x.status === 'SELF_REVIEW' && x.cycle.selfReviewDue && <p className="mt-2 text-xs font-medium text-warning-700">Self review due {dt(x.cycle.selfReviewDue)}</p>}
              {x.finalRating != null && <p className="mt-2 text-sm">Rating <span className="font-semibold">{fmt(x.finalRating)}</span> · {RATING_LABELS[Math.round(x.finalRating)]}</p>}
            </Link>
          ))}
        </div>
      )) : (
        !fb.length ? <Card><EmptyState icon={<MessageSquareQuote className="size-5" />} title="No feedback requests" description="When a manager asks for your view of a colleague, it appears here." /></Card> : (
          <Card><ul className="divide-y divide-line">{fb.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
              <div className="min-w-0"><p className="text-sm font-medium text-ink-900">{f.about.name}</p><p className="text-xs text-ink-500">{f.cycle}{f.submittedAt ? ` · sent ${dt(f.submittedAt)}` : ''}</p></div>
              {f.open ? <Button size="sm" onClick={() => setGive(f)}>Give feedback</Button> : <Badge tone={f.submittedAt ? 'success' : 'neutral'}>{f.submittedAt ? 'Sent' : 'Closed'}</Badge>}
            </li>
          ))}</ul></Card>
        )
      )}
      {give && <PeerFeedbackDialog f={give} onClose={() => setGive(null)} />}
    </>
  );
}

function PeerFeedbackDialog({ f, onClose }) {
  const [v, setV] = useState({ rating: null, strengths: '', improvements: '' });
  const save = useAction((b) => api.put(`/appraisals/feedback/${f.id}`, b), { success: 'Feedback sent. Thank you.', invalidate: [['feedback-mine']], onDone: onClose });
  const fe = save.error?.fieldErrors ?? {};
  return (
    <Dialog open onClose={onClose} title={`Feedback about ${f.about.name}`} description="It goes to their reviewer and HR, not to them directly. Be specific and fair." size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!v.rating} onClick={() => save.mutate({ ...v, improvements: v.improvements || undefined })}>Send</Button></>}>
      <div className="space-y-4">
        <Field label="Working with them overall"><Rating value={v.rating} onChange={(rating) => setV({ ...v, rating })} /></Field>
        <Field label="What do they do well?" required error={fe.strengths}><Textarea rows={3} value={v.strengths} onChange={(e) => setV({ ...v, strengths: e.target.value })} /></Field>
        <Field label="What could they do better?"><Textarea rows={3} value={v.improvements} onChange={(e) => setV({ ...v, improvements: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

// =========================================================================== appraisal form
export function AppraisalDetail() {
  const { id } = useParams();
  const key = ['appraisal', id];
  const { data: a, isPending, error } = useQuery({ queryKey: key, queryFn: () => api.get(`/appraisals/${id}`) });
  const [dlg, setDlg] = useState(null);
  if (isPending) return <Skeleton className="h-96" />;
  if (error) return <EmptyState title="Review not found" description={error.message} />;
  const ab = a.abilities;
  return (
    <>
      <BackLink to={ab.selfReview || ab.acknowledge || a.selfReview && !ab.managerReview ? '/me/appraisals' : '/appraisals'}>Reviews</BackLink>
      <PageHeader title={`${a.employee.name}: ${a.cycle.name}`} description={`${dt(a.cycle.periodStart)} – ${dt(a.cycle.periodEnd)}${a.reviewer ? ` · reviewer ${a.reviewer.name}` : ''}`}
        actions={<>
          {ab.requestFeedback && <Button variant="secondary" onClick={() => setDlg('peers')}><MessageSquareQuote className="size-4" />Ask for 360° feedback</Button>}
          {ab.changeReviewer && <Button variant="ghost" onClick={() => setDlg('reviewer')}>Change reviewer</Button>}
          {ab.reopen && <Button variant="secondary" onClick={() => setDlg('reopen')}>Send back</Button>}
          {ab.finalize && <Button onClick={() => setDlg('finalize')}>Sign off</Button>}
          {ab.acknowledge && <Button onClick={() => setDlg('ack')}>Acknowledge</Button>}
        </>} />
      <div className="mb-4 flex flex-wrap items-center gap-1">
        {['SELF_REVIEW', 'MANAGER_REVIEW', 'HR_REVIEW', 'COMPLETED', 'ACKNOWLEDGED'].map((s, i, arr) => <span key={s} className={cn('rounded-full px-2.5 py-1 text-xs font-medium', a.status === s ? 'bg-brand-600 text-white' : arr.indexOf(a.status) > i ? 'bg-brand-50 text-brand-700' : 'bg-subtle text-ink-500')}>{A_STATUS[s]}</span>)}
      </div>
      {(a.finalRating != null || a.calculatedRating != null) && (
        <Card className="mb-4"><CardBody className="flex flex-wrap items-center gap-6">
          {a.finalRating != null && <div><p className="text-xs font-medium text-ink-500">Final rating</p><p className="text-3xl font-semibold tabular-nums text-ink-900">{fmt(a.finalRating)}</p><p className="text-sm text-ink-500">{RATING_LABELS[Math.round(a.finalRating)]}</p></div>}
          {a.calculatedRating != null && <div><p className="text-xs font-medium text-ink-500">Calculated</p><p className="text-xl font-semibold tabular-nums">{fmt(a.calculatedRating)}</p><p className="text-xs text-ink-500">Goals {fmt(a.goalScore)} · competencies {fmt(a.competencyScore)}</p></div>}
          {a.workScore != null && <div><p className="text-xs font-medium text-ink-500">Day-to-day work score</p><p className="text-xl font-semibold tabular-nums">{a.workScore}</p><p className="text-xs text-ink-500">Tasks, reports, punctuality</p></div>}
          {a.recommendation && a.recommendation !== 'NONE' && <div><p className="text-xs font-medium text-ink-500">Recommendation</p><p className="font-semibold">{RECS.find(([k]) => k === a.recommendation)?.[1]}</p></div>}
          {a.calibrationNote && <p className="w-full rounded-md bg-subtle p-2 text-sm text-ink-700">HR note: {a.calibrationNote}</p>}
          {a.employeeComment && <p className="w-full rounded-md bg-subtle p-2 text-sm text-ink-700">{a.employee.name.split(' ')[0]}'s comment: {a.employeeComment}</p>}
        </CardBody></Card>
      )}
      {ab.selfReview ? <ReviewForm a={a} who="self" /> : ab.managerReview ? <ReviewForm a={a} who="manager" /> : <ReviewView a={a} />}
      {a.peerFeedback.length > 0 && (
        <Card className="mt-4"><CardHeader title="360° feedback" description="Visible to the reviewer and HR." />
          <ul className="divide-y divide-line">{a.peerFeedback.map((f) => (
            <li key={f.id} className="px-5 py-3 text-sm">
              <div className="flex justify-between gap-2"><span className="font-medium">{f.from.name}</span>{f.submittedAt ? <span>{f.rating} / 5</span> : <Badge tone="warning">Waiting</Badge>}</div>
              {f.strengths && <p className="mt-1 text-ink-700"><span className="text-ink-500">Strengths: </span>{f.strengths}</p>}
              {f.improvements && <p className="mt-1 text-ink-700"><span className="text-ink-500">Could improve: </span>{f.improvements}</p>}
            </li>
          ))}</ul>
        </Card>
      )}
      {dlg === 'peers' && <PeersDialog a={a} onClose={() => setDlg(null)} />}
      {dlg === 'finalize' && <FinalizeDialog a={a} onClose={() => setDlg(null)} />}
      {dlg === 'reopen' && <ReopenDialog a={a} onClose={() => setDlg(null)} />}
      {dlg === 'ack' && <AckDialog a={a} onClose={() => setDlg(null)} />}
      {dlg === 'reviewer' && <ReviewerDialog a={a} onClose={() => setDlg(null)} />}
    </>
  );
}

function ReviewForm({ a, who }) {
  const self = who === 'self';
  const start = (self ? a.selfReview : a.managerReview) ?? {};
  const [v, setV] = useState({ goals: start.goals ?? {}, competencies: start.competencies ?? {}, summary: start.summary ?? '', strengths: start.strengths ?? '', improvements: start.improvements ?? '', recommendation: start.recommendation ?? 'NONE' });
  const save = useAction((b) => api.put(`/appraisals/${a.id}/${self ? 'self' : 'manager'}`, b), { success: (r, b) => (b.submit ? (self ? 'Self review submitted to your manager' : 'Review submitted for HR sign-off') : 'Draft saved'), invalidate: [['appraisal', a.id], ['appraisals']] });
  const setItem = (group, k, patch) => setV((p) => ({ ...p, [group]: { ...p[group], [k]: { ...p[group][k], ...patch } } }));
  const body = (submit) => ({ goals: v.goals, competencies: v.competencies, summary: v.summary || undefined, ...(!self && { strengths: v.strengths || undefined, improvements: v.improvements || undefined, recommendation: v.recommendation }), submit });
  const other = self ? null : a.selfReview;
  const useComp = a.goalWeight < 100;
  return (
    <div className="space-y-4">
      {!self && !other && <p className="rounded-md bg-warning-50 px-3 py-2 text-sm text-warning-700">{a.employee.name.split(' ')[0]} has not submitted the self review yet.{a.abilities.managerCanSubmit ? ' You can still complete yours.' : ' You can draft yours and submit it once theirs is in.'}</p>}
      <Card>
        <CardHeader title={`Goals (${a.goalWeight}% of the rating)`} description={self ? 'Rate how well you met each goal and add a comment.' : 'Rate each goal. The employee\'s own rating is shown for comparison.'} />
        {!a.goals.length ? <CardBody className="text-sm text-ink-500">No goals in this review.</CardBody> : (
          <ul className="divide-y divide-line">{a.goals.map((g) => (
            <li key={g.id} className="space-y-2 px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><p className="font-medium text-ink-900">{g.title}</p><p className="text-xs text-ink-500">{[g.target && `Target ${g.target}`, g.actual && `Result ${g.actual}`, `${g.progress}% done`, g.weight && `weight ${g.weight}%`].filter(Boolean).join(' · ')}</p></div>{other?.goals?.[g.id]?.rating && <Badge>Self: {other.goals[g.id].rating}</Badge>}</div>
              <Rating name={g.title} value={v.goals[g.id]?.rating} onChange={(n) => setItem('goals', g.id, { rating: n })} />
              <Input aria-label="Comment" placeholder="Comment" value={v.goals[g.id]?.comment ?? ''} onChange={(e) => setItem('goals', g.id, { comment: e.target.value })} />
            </li>
          ))}</ul>
        )}
      </Card>
      {useComp && (
        <Card>
          <CardHeader title={`Competencies (${100 - a.goalWeight}% of the rating)`} />
          <ul className="divide-y divide-line">{a.competencies.map((c) => (
            <li key={c.key} className="space-y-2 px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><p className="font-medium text-ink-900">{c.name}</p>{c.description && <p className="text-xs text-ink-500">{c.description}</p>}</div>{other?.competencies?.[c.key]?.rating && <Badge>Self: {other.competencies[c.key].rating}</Badge>}</div>
              <Rating name={c.name} value={v.competencies[c.key]?.rating} onChange={(n) => setItem('competencies', c.key, { rating: n })} />
            </li>
          ))}</ul>
        </Card>
      )}
      <Card><CardBody className="space-y-4">
        {other?.summary && <p className="rounded-md bg-subtle p-3 text-sm text-ink-700"><span className="text-ink-500">Employee's summary: </span>{other.summary}</p>}
        <Field label={self ? 'Your summary of the period' : 'Overall comments'}><Textarea rows={3} value={v.summary} onChange={(e) => setV({ ...v, summary: e.target.value })} placeholder={self ? 'Achievements, challenges, what support you need' : undefined} /></Field>
        {!self && <>
          <Field label="Strengths"><Textarea rows={2} value={v.strengths} onChange={(e) => setV({ ...v, strengths: e.target.value })} /></Field>
          <Field label="To improve"><Textarea rows={2} value={v.improvements} onChange={(e) => setV({ ...v, improvements: e.target.value })} /></Field>
          <Field label="Recommendation"><Select value={v.recommendation} onChange={(e) => setV({ ...v, recommendation: e.target.value })} options={RECS.map(([value, l]) => ({ value, label: l }))} /></Field>
        </>}
        <ErrorNote error={save.error} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" loading={save.isPending && !save.variables?.submit} onClick={() => save.mutate(body(false))}>Save draft</Button>
          <Button loading={save.isPending && save.variables?.submit} disabled={!self && !a.abilities.managerCanSubmit} onClick={() => save.mutate(body(true))}>{self ? 'Submit to my manager' : 'Submit for sign-off'}</Button>
        </div>
      </CardBody></Card>
    </div>
  );
}

function ReviewView({ a }) {
  const col = (r, k, group) => r?.[group]?.[k];
  const show = (r) => !!r;
  if (!show(a.selfReview) && !show(a.managerReview)) return <Card><CardBody className="text-sm text-ink-500">Nothing to show yet.</CardBody></Card>;
  const Cell = ({ x }) => (x?.rating ? <div><span className="font-semibold tabular-nums">{x.rating}</span>{x.comment && <p className="text-xs text-ink-500">{x.comment}</p>}</div> : <span className="text-ink-400">—</span>);
  const rows = [...a.goals.map((g) => ({ k: g.id, name: g.title, group: 'goals', sub: g.target ? `Target ${g.target}` : null })), ...(a.goalWeight < 100 ? a.competencies.map((c) => ({ k: c.key, name: c.name, group: 'competencies' })) : [])];
  return (
    <Card>
      <CardHeader title="Ratings" />
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-subtle text-xs text-ink-500"><tr><th className="px-5 py-2 font-semibold">Item</th>{show(a.selfReview) && <th className="px-3 py-2 font-semibold">Self</th>}{show(a.managerReview) && <th className="px-3 py-2 font-semibold">Manager</th>}</tr></thead>
          <tbody className="divide-y divide-line">{rows.map((r) => <tr key={r.k}><td className="px-5 py-2.5"><p className="font-medium text-ink-900">{r.name}</p>{r.sub && <p className="text-xs text-ink-500">{r.sub}</p>}</td>{show(a.selfReview) && <td className="px-3 py-2.5"><Cell x={col(a.selfReview, r.k, r.group)} /></td>}{show(a.managerReview) && <td className="px-3 py-2.5"><Cell x={col(a.managerReview, r.k, r.group)} /></td>}</tr>)}</tbody>
        </table>
      </div>
      <CardBody className="space-y-2 border-t border-line text-sm">
        {a.selfReview?.summary && <p><span className="text-ink-500">Employee's summary: </span>{a.selfReview.summary}</p>}
        {a.managerReview?.summary && <p><span className="text-ink-500">Manager's comments: </span>{a.managerReview.summary}</p>}
        {a.managerReview?.strengths && <p><span className="text-ink-500">Strengths: </span>{a.managerReview.strengths}</p>}
        {a.managerReview?.improvements && <p><span className="text-ink-500">To improve: </span>{a.managerReview.improvements}</p>}
      </CardBody>
    </Card>
  );
}

function PeersDialog({ a, onClose }) {
  const [people, setPeople] = useState([]);
  const save = useAction((b) => api.post(`/appraisals/${a.id}/feedback-requests`, b), { success: (r) => `${r.requested} request${r.requested === 1 ? '' : 's'} sent`, invalidate: [['appraisal', a.id]], onDone: onClose });
  return (
    <Dialog open onClose={onClose} title="Ask colleagues for feedback" description={`Up to 8 people who work closely with ${a.employee.name}. Their answers come to you and HR.`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!people.length} onClick={() => save.mutate({ employeeIds: people.map((p) => p.id) })}>Send requests</Button></>}>
      <PeoplePicker value={people} onChange={setPeople} exclude={[a.employee.id, ...a.peerFeedback.map((f) => f.from.id)]} max={8} />
    </Dialog>
  );
}

function FinalizeDialog({ a, onClose }) {
  const [v, setV] = useState({ finalRating: a.calculatedRating ?? '', calibrationNote: '', recommendation: a.recommendation ?? 'NONE' });
  const save = useAction((b) => api.post(`/appraisals/${a.id}/finalize`, b), { success: 'Signed off. The employee can now read it.', invalidate: [['appraisal', a.id], ['appraisals']], onDone: onClose });
  const fe = save.error?.fieldErrors ?? {};
  const changed = v.finalRating !== '' && a.calculatedRating != null && Math.abs(Number(v.finalRating) - a.calculatedRating) >= 0.01;
  return (
    <Dialog open onClose={onClose} title="Sign off this review" description={`Calculated rating ${fmt(a.calculatedRating)}. Change it only after calibration, and say why.`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate({ finalRating: Number(v.finalRating), calibrationNote: v.calibrationNote || undefined, recommendation: v.recommendation })}>Sign off</Button></>}>
      <div className="space-y-4">
        <Field label="Final rating (1 to 5)" error={fe.finalRating}><Input type="number" min="1" max="5" step="0.1" value={v.finalRating} onChange={(e) => setV({ ...v, finalRating: e.target.value })} /></Field>
        <Field label="Calibration note" required={changed} error={fe.calibrationNote}><Textarea rows={2} value={v.calibrationNote} onChange={(e) => setV({ ...v, calibrationNote: e.target.value })} /></Field>
        <Field label="Recommendation"><Select value={v.recommendation} onChange={(e) => setV({ ...v, recommendation: e.target.value })} options={RECS.map(([value, l]) => ({ value, label: l }))} /></Field>
      </div>
    </Dialog>
  );
}

function ReopenDialog({ a, onClose }) {
  const [note, setNote] = useState('');
  const save = useAction((b) => api.post(`/appraisals/${a.id}/reopen`, b), { success: 'Sent back to the reviewer', invalidate: [['appraisal', a.id]], onDone: onClose });
  return (
    <Dialog open onClose={onClose} title="Send back to the reviewer"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate({ note })}>Send back</Button></>}>
      <Field label="What should change?" required error={save.error?.fieldErrors?.note}><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </Dialog>
  );
}

function AckDialog({ a, onClose }) {
  const [comment, setComment] = useState('');
  const save = useAction((b) => api.post(`/appraisals/${a.id}/acknowledge`, b), { success: 'Acknowledged', invalidate: [['appraisal', a.id], ['appraisals']], onDone: onClose });
  return (
    <Dialog open onClose={onClose} title="Acknowledge your review" description="This confirms you have read it. It does not mean you agree with everything; add a comment if you want."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate({ comment: comment || undefined })}>Acknowledge</Button></>}>
      <Field label="Your comment (optional)"><Textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
    </Dialog>
  );
}

function ReviewerDialog({ a, onClose }) {
  const [id, setId] = useState('');
  const save = useAction((b) => api.post(`/appraisals/${a.id}/reviewer`, b), { success: 'Reviewer changed', invalidate: [['appraisal', a.id]], onDone: onClose });
  return (
    <Dialog open onClose={onClose} title="Change reviewer"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!id} onClick={() => save.mutate({ reviewerId: id })}>Save</Button></>}>
      <PersonPicker value={id} onChange={setId} />
      <div className="mt-3"><ErrorNote error={save.error} /></div>
    </Dialog>
  );
}

// =========================================================================== managers and HR
export function Appraisals() {
  const a = useAuth();
  const nav = useNavigate();
  const hr = a.can('appraisals:configure');
  const [tab, setTab] = useState('review');
  const { data: review = [], isPending } = useQuery({ queryKey: ['appraisals', 'review'], queryFn: () => api.get('/appraisals?view=review') });
  const { data: goals = [] } = useQuery({ queryKey: ['team-goals'], queryFn: () => api.get('/appraisals/goals/team'), enabled: tab === 'goals' });
  const { data: cycles = [] } = useQuery({ queryKey: ['cycles'], queryFn: () => api.get('/appraisals/cycles'), enabled: tab === 'cycles' || hr });
  const { data: signoff = [] } = useQuery({ queryKey: ['appraisals', 'signoff'], queryFn: () => api.get('/appraisals?view=all&status=HR_REVIEW'), enabled: a.can('appraisals:approve') });
  const [dlg, setDlg] = useState(null);
  const todo = review.filter((x) => ['SELF_REVIEW', 'MANAGER_REVIEW'].includes(x.status));
  return (
    <>
      <PageHeader title="Performance reviews" description="Goals for your team, reviews to write, and review cycles."
        actions={<>
          <Button variant="secondary" onClick={() => setDlg({ goal: true })}><Flag className="size-4" />Set a goal</Button>
          {hr && <Button onClick={() => setDlg({ cycle: true })}><Plus className="size-4" />New review cycle</Button>}
        </>} />
      <Tabs value={tab} onChange={setTab} tabs={[['review', 'To review', todo.length], a.can('appraisals:approve') && ['signoff', 'To sign off', signoff.length], ['goals', 'Team goals'], ['cycles', 'Cycles']]} />
      {tab === 'review' && <AppraisalTable rows={review} loading={isPending} onOpen={(x) => nav(`/appraisals/${x.id}`)} empty="No reviews for you to write." />}
      {tab === 'signoff' && <AppraisalTable rows={signoff} onOpen={(x) => nav(`/appraisals/${x.id}`)} empty="Nothing waiting for sign-off." />}
      {tab === 'goals' && (goals.length ? <GoalList goals={goals} showPerson /> : <Card><EmptyState icon={<Target className="size-5" />} title="No team goals yet" action={<Button onClick={() => setDlg({ goal: true })}>Set a goal</Button>} /></Card>)}
      {tab === 'cycles' && (
        <DataTable rows={cycles} onRowClick={(c) => nav(`/appraisals/cycles/${c.id}`)}
          empty={<EmptyState icon={<ClipboardCheck className="size-5" />} title="No review cycles" description={hr ? 'Create a cycle, for example an annual review for the fiscal year, then launch it.' : undefined} action={hr ? <Button onClick={() => setDlg({ cycle: true })}>New review cycle</Button> : undefined} />}
          mobile={(c) => <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-medium text-ink-900">{c.name}</p><p className="text-xs text-ink-500">{dt(c.periodStart)} – {dt(c.periodEnd)} · {c.completed} of {c.total} done</p></div><StatusBadge value={c.status} /></div>}
          columns={[
            { key: 'name', header: 'Cycle', render: (c) => <span className="font-medium text-ink-900">{c.name}</span> },
            { key: 'period', header: 'Period', render: (c) => `${dt(c.periodStart)} – ${dt(c.periodEnd)}` },
            { key: 'progress', header: 'Done', render: (c) => <div className="w-40"><Progress value={c.total ? Math.round((c.completed / c.total) * 100) : 0} /><p className="text-xs text-ink-400">{c.completed} of {c.total}</p></div> },
            { key: 'status', header: 'Status', render: (c) => <StatusBadge value={c.status} /> },
          ]} />
      )}
      {dlg?.goal && <TeamGoalDialog onClose={() => setDlg(null)} />}
      {dlg?.cycle && <CycleDialog onClose={() => setDlg(null)} onDone={(c) => { setDlg(null); nav(`/appraisals/cycles/${c.id}`); }} />}
    </>
  );
}

function AppraisalTable({ rows, loading, onOpen, empty }) {
  return (
    <DataTable rows={rows} loading={loading} onRowClick={onOpen}
      empty={<EmptyState icon={<ClipboardCheck className="size-5" />} title={empty} />}
      mobile={(x) => <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-medium text-ink-900">{x.employee.name}</p><p className="text-xs text-ink-500">{x.cycle.name}{x.cycle.managerReviewDue ? ` · due ${dt(x.cycle.managerReviewDue)}` : ''}</p></div><AStatus s={x.status} /></div>}
      columns={[
        { key: 'employee', header: 'Employee', render: (x) => <><p className="font-medium text-ink-900">{x.employee.name}</p><p className="text-xs text-ink-400">{x.employee.code}</p></> },
        { key: 'cycle', header: 'Cycle', render: (x) => x.cycle.name },
        { key: 'reviewer', header: 'Reviewer', render: (x) => x.reviewer?.name ?? '—' },
        { key: 'rating', header: 'Rating', render: (x) => fmt(x.finalRating ?? x.calculatedRating) },
        { key: 'status', header: 'Stage', render: (x) => <AStatus s={x.status} /> },
      ]} />
  );
}

function TeamGoalDialog({ onClose }) {
  const [emp, setEmp] = useState('');
  if (!emp) {
    return (
      <Dialog open onClose={onClose} title="Set a goal" description="Choose the person first.">
        <PersonPicker value={emp} onChange={setEmp} />
      </Dialog>
    );
  }
  return <GoalDialog employeeId={emp} onClose={onClose} />;
}

const COMPETENCIES = [
  { key: 'knowledge', name: 'Job knowledge', description: 'Understands the work, tools and procedures of the role.' },
  { key: 'quality', name: 'Quality of work', description: 'Accurate, thorough work that rarely needs to be redone.' },
  { key: 'productivity', name: 'Productivity', description: 'Gets the expected amount of work done on time.' },
  { key: 'communication', name: 'Communication', description: 'Shares information clearly with colleagues and customers.' },
  { key: 'teamwork', name: 'Teamwork', description: 'Works well with others and helps the team succeed.' },
  { key: 'initiative', name: 'Initiative', description: 'Spots problems and improvements and acts on them.' },
  { key: 'reliability', name: 'Reliability', description: 'Keeps commitments, is punctual and dependable.' },
];

function CycleDialog({ cycle, onClose, onDone }) {
  const [v, setV] = useState(() => ({
    name: cycle?.name ?? '', periodStart: cycle?.periodStart ?? '', periodEnd: cycle?.periodEnd ?? '', selfReviewDue: cycle?.selfReviewDue ?? '', managerReviewDue: cycle?.managerReviewDue ?? '',
    goalWeight: cycle?.goalWeight ?? 60, peerFeedback: cycle?.peerFeedback ?? true, competencies: cycle?.competencies ?? COMPETENCIES,
  }));
  const save = useAction((b) => (cycle ? api.put(`/appraisals/cycles/${cycle.id}`, b) : api.post('/appraisals/cycles', b)), { success: 'Cycle saved', invalidate: [['cycles'], ['cycle']], onDone });
  const fe = save.error?.fieldErrors ?? {};
  const locked = cycle && cycle.status !== 'DRAFT';
  const set = (k) => (e) => setV((p) => ({ ...p, [k]: e.target.value }));
  return (
    <Dialog open onClose={onClose} title={cycle ? 'Edit review cycle' : 'New review cycle'} description={locked ? 'After launch only the due dates can change.' : 'Set the period and how the rating is worked out. You choose who takes part when you launch it.'} size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate({ ...v, goalWeight: Number(v.goalWeight), selfReviewDue: v.selfReviewDue || null, managerReviewDue: v.managerReviewDue || null, competencies: v.competencies.map(({ key, name, description }) => ({ key, name, ...(description && { description }) })) })}>Save</Button></>}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="Name" required error={fe.name} className="sm:col-span-2"><Input disabled={locked} value={v.name} onChange={set('name')} placeholder="e.g. Annual review 2083/84" /></Field>
        <Field label="Period from" required error={fe.periodStart}><Input disabled={locked} type="date" value={v.periodStart} onChange={set('periodStart')} /></Field>
        <Field label="Period to" required error={fe.periodEnd}><Input disabled={locked} type="date" value={v.periodEnd} onChange={set('periodEnd')} /></Field>
        <Field label="Self reviews due"><Input type="date" min={todayKtm()} value={v.selfReviewDue} onChange={set('selfReviewDue')} /></Field>
        <Field label="Manager reviews due"><Input type="date" min={todayKtm()} value={v.managerReviewDue} onChange={set('managerReviewDue')} /></Field>
        <Field label={`Goals count for ${v.goalWeight}% of the rating, competencies ${100 - v.goalWeight}%`} className="sm:col-span-2"><input disabled={locked} type="range" min="0" max="100" step="10" value={v.goalWeight} onChange={set('goalWeight')} className="w-full accent-brand-600" aria-label="Goals weight" /></Field>
        <div className="sm:col-span-2"><Checkbox disabled={locked} label="Reviewers can ask colleagues for 360° feedback" checked={v.peerFeedback} onChange={(e) => setV({ ...v, peerFeedback: e.target.checked })} /></div>
        {!locked && Number(v.goalWeight) < 100 && (
          <div className="sm:col-span-2">
            <p className="mb-1.5 text-sm font-medium text-ink-900">Competencies</p>
            <div className="space-y-2">{v.competencies.map((c, i) => (
              <div key={c.key} className="flex items-center gap-2"><Input aria-label="Competency" value={c.name} onChange={(e) => setV({ ...v, competencies: v.competencies.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} /><Button size="sm" variant="ghost" onClick={() => setV({ ...v, competencies: v.competencies.filter((_, j) => j !== i) })}>Remove</Button></div>
            ))}</div>
            <Button size="sm" variant="secondary" className="mt-2" onClick={() => setV({ ...v, competencies: [...v.competencies, { key: `c${Date.now().toString(36)}`, name: 'New competency' }] })}><Plus className="size-4" />Add competency</Button>
            {fe.competencies && <p className="mt-1 text-xs text-danger-600">{fe.competencies}</p>}
          </div>
        )}
      </div>
    </Dialog>
  );
}

export function CycleDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const a = useAuth();
  const { data: cycles = [] } = useQuery({ queryKey: ['cycles'], queryFn: () => api.get('/appraisals/cycles') });
  const c = cycles.find((x) => x.id === id);
  const { data: rows = [], isPending } = useQuery({ queryKey: ['appraisals', 'cycle', id], queryFn: () => api.get(`/appraisals?view=all&cycleId=${id}`) });
  const [dlg, setDlg] = useState(null);
  const close = useAction(() => api.post(`/appraisals/cycles/${id}/close`, {}), { success: (r) => `Cycle closed${r.unfinished ? `. ${r.unfinished} review(s) were not finished.` : ''}`, invalidate: [['cycles']] });
  const download = useDownload();
  if (!c) return <Skeleton className="h-64" />;
  const hr = a.can('appraisals:configure');
  return (
    <>
      <BackLink to="/appraisals">Performance reviews</BackLink>
      <PageHeader title={c.name} description={`${dt(c.periodStart)} – ${dt(c.periodEnd)} · goals ${c.goalWeight}%, competencies ${100 - c.goalWeight}%`}
        actions={<>
          {a.can('appraisals:export') && rows.length > 0 && <Button variant="secondary" onClick={() => download(`/appraisals/cycles/${id}/export`, `appraisals-${c.name}.csv`)}><Download className="size-4" />Export</Button>}
          {hr && <Button variant="secondary" onClick={() => setDlg('edit')}>Edit</Button>}
          {hr && c.status === 'ACTIVE' && <Button variant="ghost" onClick={() => close.mutate()}>Close cycle</Button>}
          {hr && c.status !== 'CLOSED' && <Button onClick={() => setDlg('launch')}><Rocket className="size-4" />{c.status === 'DRAFT' ? 'Launch' : 'Add people'}</Button>}
        </>} />
      <div className="mb-4 flex flex-wrap gap-2">{Object.entries(A_STATUS).map(([k, l]) => { const n = rows.filter((x) => x.status === k).length; return n ? <Badge key={k} tone={A_TONE[k]}>{l}: {n}</Badge> : null; })}</div>
      <AppraisalTable rows={rows} loading={isPending} onOpen={(x) => nav(`/appraisals/${x.id}`)} empty={c.status === 'DRAFT' ? 'Launch the cycle to start the reviews.' : 'Nobody in this cycle yet.'} />
      {dlg === 'edit' && <CycleDialog cycle={c} onClose={() => setDlg(null)} onDone={() => setDlg(null)} />}
      {dlg === 'launch' && <LaunchDialog c={c} onClose={() => setDlg(null)} />}
    </>
  );
}

function LaunchDialog({ c, onClose }) {
  const { data: depts = [] } = useQuery({ queryKey: ['departments'], queryFn: () => api.get('/departments?pageSize=100&sort=name&order=asc') });
  const [v, setV] = useState({ who: 'all', departmentIds: [], people: [] });
  const save = useAction((b) => api.post(`/appraisals/cycles/${c.id}/launch`, b), { success: (r) => `${r.added} review${r.added === 1 ? '' : 's'} started${r.withoutManager ? `. ${r.withoutManager} without a manager go to HR.` : ''}`, invalidate: [['cycles'], ['appraisals']], onDone: onClose });
  const body = v.who === 'all' ? {} : v.who === 'dept' ? { departmentIds: v.departmentIds } : { employeeIds: v.people.map((p) => p.id) };
  return (
    <Dialog open onClose={onClose} title={c.status === 'DRAFT' ? `Launch ${c.name}` : 'Add people'} description="Each person gets a self review; their manager is the reviewer. Goals due in the period join the review." size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate(body)}>{c.status === 'DRAFT' ? 'Launch' : 'Add'}</Button></>}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">{[['all', 'Everyone'], ['dept', 'Departments'], ['people', 'Chosen people']].map(([k, l]) => <Button key={k} size="sm" variant={v.who === k ? 'primary' : 'secondary'} onClick={() => setV({ ...v, who: k })}>{l}</Button>)}</div>
        {v.who === 'dept' && <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">{depts.map((d) => <Checkbox key={d.id} label={d.name} checked={v.departmentIds.includes(d.id)} onChange={(e) => setV({ ...v, departmentIds: e.target.checked ? [...v.departmentIds, d.id] : v.departmentIds.filter((x) => x !== d.id) })} />)}</div>}
        {v.who === 'people' && <PeoplePicker value={v.people} onChange={(people) => setV({ ...v, people })} max={200} />}
        <ErrorNote error={save.error} />
      </div>
    </Dialog>
  );
}
