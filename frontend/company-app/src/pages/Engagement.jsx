import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Award, ClipboardList, EyeOff, Eye, Heart, Lock, Plus, Send, Trash2 } from 'lucide-react';
import { Button, Card, CardBody, CardHeader, Dialog, EmptyState, Field, Input, Select, Skeleton, Textarea, Checkbox, Badge, cn } from '@hrms/shared-ui';
import { api, useAuth, useAction, PageHeader, StatusBadge, dt, todayKtm, addDays } from '../lib.jsx';
import { PersonPicker, Tabs, Tiles, BackLink, ErrorNote } from './kit.jsx';

const Q_TYPES = [['RATING', 'Agree / disagree (1–5)'], ['ENPS', 'Recommend us (0–10)'], ['CHOICE', 'Pick one option'], ['TEXT', 'Written answer']];
const AGREE = { 1: 'Strongly disagree', 2: 'Disagree', 3: 'Neutral', 4: 'Agree', 5: 'Strongly agree' };

// =========================================================================== surveys list
export function Surveys() {
  const a = useAuth();
  const nav = useNavigate();
  const manage = a.can('engagement:manage');
  const { data = [], isPending } = useQuery({ queryKey: ['surveys'], queryFn: () => api.get('/engagement/surveys') });
  const [dlg, setDlg] = useState(false);
  const todo = data.filter((s) => s.myTurn);
  return (
    <>
      <PageHeader title="Surveys" description={manage ? 'Ask how people feel about work. Answers are anonymous unless you choose otherwise.' : 'Your honest answers help make this a better place to work.'}
        actions={manage && <Button onClick={() => setDlg(true)}><Plus className="size-4" />New survey</Button>} />
      {todo.length > 0 && (
        <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2 [&>*]:min-w-0">{todo.map((s) => (
          <Card key={s.id} className="border-brand-100 bg-brand-50/50"><CardBody className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0"><p className="font-semibold text-ink-900">{s.title}</p><p className="text-sm text-ink-500">{s.anonymous ? 'Anonymous · ' : ''}{s.questionCount ?? s.questions?.length} questions{s.closesOn ? ` · open until ${dt(s.closesOn)}` : ''}</p></div>
            <Link to={`/surveys/${s.id}`}><Button size="sm">Answer now</Button></Link>
          </CardBody></Card>
        ))}</div>
      )}
      {isPending ? <Skeleton className="h-48" /> : !data.length ? (
        <Card><EmptyState icon={<ClipboardList className="size-5" />} title="No surveys yet" description={manage ? 'Start with a five-question pulse check. It takes people two minutes.' : 'When HR sends a survey, it appears here.'} action={manage ? <Button onClick={() => setDlg(true)}>New survey</Button> : undefined} /></Card>
      ) : (
        <Card><ul className="divide-y divide-line">{data.map((s) => (
          <li key={s.id}><button type="button" onClick={() => nav(`/surveys/${s.id}${manage && s.status !== 'DRAFT' ? '?results=1' : ''}`)} className="flex w-full flex-wrap items-center justify-between gap-2 px-5 py-3 text-left hover:bg-subtle">
            <div className="min-w-0"><p className="flex items-center gap-1.5 text-sm font-medium text-ink-900">{s.anonymous && <Lock className="size-3.5 text-ink-400" />}{s.title}</p><p className="text-xs text-ink-500">{s.openedAt ? `Sent ${dt(s.openedAt)}` : 'Draft'}{s.closesOn ? ` · closes ${dt(s.closesOn)}` : ''}{manage && s.invited ? ` · ${s.responded} of ${s.invited} answered` : ''}</p></div>
            <span className="flex items-center gap-2">{!manage && s.responded && <Badge tone="success">Answered</Badge>}<StatusBadge value={s.status} /></span>
          </button></li>
        ))}</ul></Card>
      )}
      {dlg && <SurveyEditor onClose={() => setDlg(false)} onDone={(s) => { setDlg(false); nav(`/surveys/${s.id}`); }} />}
    </>
  );
}

function SurveyEditor({ survey, onClose, onDone }) {
  const { data: templates = [] } = useQuery({ queryKey: ['survey-templates'], queryFn: () => api.get('/engagement/survey-templates') });
  const { data: depts = [] } = useQuery({ queryKey: ['departments'], queryFn: () => api.get('/departments?pageSize=100&sort=name&order=asc') });
  const [v, setV] = useState(() => survey ? { ...survey, closesOn: survey.closesOn ?? '', departmentIds: survey.audience?.departmentIds ?? [] } : { title: '', description: '', anonymous: true, closesOn: addDays(todayKtm(), 7), departmentIds: [], questions: [], minGroup: 3 });
  const save = useAction((b) => (survey ? api.put(`/engagement/surveys/${survey.id}`, b) : api.post('/engagement/surveys', b)), { success: 'Survey saved as a draft', invalidate: [['surveys'], ['survey']], onDone });
  const setQ = (i, patch) => setV({ ...v, questions: v.questions.map((q, j) => (j === i ? { ...q, ...patch } : q)) });
  const fe = save.error?.fieldErrors ?? {};
  const submit = () => save.mutate({
    title: v.title, description: v.description || undefined, anonymous: v.anonymous, closesOn: v.closesOn || null, minGroup: Number(v.minGroup) || 3,
    audience: v.departmentIds.length ? { departmentIds: v.departmentIds } : {},
    questions: v.questions.map(({ id, type, text, options, required }) => ({ ...(id && { id }), type, text, required: required !== false, ...(type === 'CHOICE' && { options: (options ?? []).filter(Boolean) }) })),
  });
  return (
    <Dialog open onClose={onClose} title={survey ? 'Edit survey' : 'New survey'} size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={submit}>Save draft</Button></>}>
      <div className="space-y-4">
        {!survey && !v.questions.length && templates.length > 0 && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{templates.map((t) => (
            <button key={t.key} type="button" onClick={() => setV({ ...v, title: t.title, description: t.description, questions: t.questions.map((q) => ({ ...q, required: q.required !== false })) })} className="rounded-lg border border-line p-3 text-left hover:border-brand-600 hover:bg-brand-50">
              <p className="text-sm font-semibold text-ink-900">{t.title}</p><p className="text-xs text-ink-500">{t.questions.length} questions · start from this</p>
            </button>
          ))}</div>
        )}
        <Field label="Title" required error={fe.title}><Input value={v.title} maxLength={160} onChange={(e) => setV({ ...v, title: e.target.value })} /></Field>
        <Field label="Introduction"><Textarea rows={2} value={v.description ?? ''} onChange={(e) => setV({ ...v, description: e.target.value })} /></Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
          <Field label="Closes on"><Input type="date" min={todayKtm()} value={v.closesOn} onChange={(e) => setV({ ...v, closesOn: e.target.value })} /></Field>
          <Field label="Show results only when at least … answered" hint="Protects anonymity in small groups"><Input type="number" min="1" max="20" value={v.minGroup} onChange={(e) => setV({ ...v, minGroup: e.target.value })} /></Field>
        </div>
        <Checkbox label="Anonymous: answers are stored without names (recommended)" checked={v.anonymous} onChange={(e) => setV({ ...v, anonymous: e.target.checked })} />
        <div>
          <p className="mb-1.5 text-sm font-medium text-ink-900">Who gets it</p>
          <div className="grid max-h-40 grid-cols-1 gap-1 overflow-auto rounded-md border border-line p-2 sm:grid-cols-2">
            <Checkbox label="Everyone" checked={!v.departmentIds.length} onChange={() => setV({ ...v, departmentIds: [] })} />
            {depts.map((d) => <Checkbox key={d.id} label={d.name} checked={v.departmentIds.includes(d.id)} onChange={(e) => setV({ ...v, departmentIds: e.target.checked ? [...v.departmentIds, d.id] : v.departmentIds.filter((x) => x !== d.id) })} />)}
          </div>
        </div>
        <div>
          <p className="mb-1.5 text-sm font-medium text-ink-900">Questions</p>
          {fe.questions && <p className="mb-1 text-xs text-danger-600">{fe.questions}</p>}
          <div className="space-y-2">{v.questions.map((q, i) => (
            <div key={i} className="space-y-2 rounded-lg border border-line p-3">
              <div className="flex gap-2"><Input aria-label="Question" value={q.text} onChange={(e) => setQ(i, { text: e.target.value })} placeholder="Question" /><button type="button" className="rounded p-1 text-ink-400 hover:text-danger-600" onClick={() => setV({ ...v, questions: v.questions.filter((_, j) => j !== i) })} aria-label="Remove question"><Trash2 className="size-4" /></button></div>
              <div className="flex flex-wrap items-center gap-3"><div className="w-56"><Select aria-label="Answer type" value={q.type} onChange={(e) => setQ(i, { type: e.target.value })} options={Q_TYPES.map(([value, l]) => ({ value, label: l }))} /></div><Checkbox label="Required" checked={q.required !== false} onChange={(e) => setQ(i, { required: e.target.checked })} /></div>
              {q.type === 'CHOICE' && <Input aria-label="Options" value={(q.options ?? []).join(', ')} onChange={(e) => setQ(i, { options: e.target.value.split(',').map((x) => x.trim()) })} placeholder="Options, separated by commas" />}
            </div>
          ))}</div>
          <Button size="sm" variant="secondary" className="mt-2" onClick={() => setV({ ...v, questions: [...v.questions, { type: 'RATING', text: '', required: true }] })}><Plus className="size-4" />Add question</Button>
        </div>
        <ErrorNote error={save.error && !fe.title ? save.error : null} />
      </div>
    </Dialog>
  );
}

// =========================================================================== survey page (answer, manage, results)
export function SurveyPage() {
  const { id } = useParams();
  const a = useAuth();
  const { data: s, isPending, error } = useQuery({ queryKey: ['survey', id], queryFn: () => api.get(`/engagement/surveys/${id}`) });
  const manage = a.can('engagement:manage');
  const [tab, setTab] = useState(new URLSearchParams(window.location.search).get('results') ? 'results' : 'survey');
  const [edit, setEdit] = useState(false);
  const open = useAction(() => api.post(`/engagement/surveys/${id}/open`, {}), { success: (r) => `Sent to ${r.invited} people`, invalidate: [['survey', id], ['surveys']] });
  const close = useAction(() => api.post(`/engagement/surveys/${id}/close`, {}), { success: 'Survey closed', invalidate: [['survey', id], ['surveys']] });
  if (isPending) return <Skeleton className="h-96" />;
  if (error) return <EmptyState title="Survey not found" description={error.message} />;
  return (
    <>
      <BackLink to="/surveys">Surveys</BackLink>
      <PageHeader title={s.title} description={[s.anonymous && 'Anonymous', s.closesOn && `Open until ${dt(s.closesOn)}`].filter(Boolean).join(' · ') || undefined}
        actions={manage && <>
          {s.status === 'DRAFT' && <Button variant="secondary" onClick={() => setEdit(true)}>Edit</Button>}
          {s.status === 'DRAFT' && <Button loading={open.isPending} onClick={() => open.mutate()}><Send className="size-4" />Send survey</Button>}
          {s.status === 'OPEN' && <Button variant="secondary" loading={close.isPending} onClick={() => close.mutate()}>Close now</Button>}
        </>} />
      <ErrorNote error={open.error} />
      {manage && s.status !== 'DRAFT' && <Tabs value={tab} onChange={setTab} tabs={[['results', 'Results'], ['survey', s.canAnswer ? 'Answer' : 'Questions']]} />}
      {tab === 'results' && manage && s.status !== 'DRAFT' ? <Results id={id} /> : s.canAnswer ? <AnswerForm s={s} /> : s.responded ? (
        <Card><EmptyState icon={<Heart className="size-5" />} title="Thank you for answering" description={s.anonymous ? 'Your answers were saved without your name.' : 'Your answers were saved.'} /></Card>
      ) : (
        <Card><CardHeader title="Questions" description={s.status === 'DRAFT' ? 'Send the survey to start collecting answers.' : 'This survey is closed.'} />
          <ol className="divide-y divide-line">{s.questions.map((q, i) => <li key={q.id} className="px-5 py-3 text-sm"><span className="text-ink-400">{i + 1}.</span> {q.text} <span className="text-xs text-ink-400">({Q_TYPES.find(([k]) => k === q.type)?.[1]})</span></li>)}</ol>
        </Card>
      )}
      {edit && <SurveyEditor survey={s} onClose={() => setEdit(false)} onDone={() => setEdit(false)} />}
    </>
  );
}

function AnswerForm({ s }) {
  const [ans, setAns] = useState({});
  const submit = useAction(() => api.post(`/engagement/surveys/${s.id}/respond`, { answers: ans }), { success: 'Thank you. Your answers are in.', invalidate: [['survey', s.id], ['surveys']] });
  const missing = s.questions.filter((q) => q.required !== false && q.type !== 'TEXT' && (ans[q.id] == null || ans[q.id] === ''));
  return (
    <div className="space-y-3">
      {s.description && <p className="text-sm text-ink-700">{s.description}</p>}
      {s.anonymous && <p className="flex items-center gap-2 rounded-md bg-subtle px-3 py-2 text-sm text-ink-700"><Lock className="size-4 shrink-0" />Anonymous: your name is not stored with your answers, and results show only when enough people have answered.</p>}
      {s.questions.map((q, i) => (
        <Card key={q.id}><CardBody className="space-y-3">
          <p className="font-medium text-ink-900"><span className="text-ink-400">{i + 1}. </span>{q.text}{q.required !== false && q.type !== 'TEXT' && <span className="text-danger-600"> *</span>}</p>
          {q.type === 'RATING' && <div className="grid grid-cols-5 gap-1.5" role="radiogroup" aria-label={q.text}>{[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={ans[q.id] === n} onClick={() => setAns({ ...ans, [q.id]: n })} className={cn('rounded-md border px-1 py-2 text-xs font-medium', ans[q.id] === n ? 'border-brand-600 bg-brand-600 text-white' : 'border-line-strong text-ink-700 hover:border-brand-600')}>{AGREE[n]}</button>
          ))}</div>}
          {q.type === 'ENPS' && <div>
            <div className="grid grid-cols-11 gap-1" role="radiogroup" aria-label={q.text}>{Array.from({ length: 11 }, (_, n) => (
              <button key={n} type="button" role="radio" aria-checked={ans[q.id] === n} onClick={() => setAns({ ...ans, [q.id]: n })} className={cn('rounded-md border py-2 text-sm font-semibold tabular-nums', ans[q.id] === n ? 'border-brand-600 bg-brand-600 text-white' : 'border-line-strong text-ink-700 hover:border-brand-600')}>{n}</button>
            ))}</div>
            <div className="mt-1 flex justify-between text-xs text-ink-500"><span>Not at all likely</span><span>Extremely likely</span></div>
          </div>}
          {q.type === 'CHOICE' && <div className="flex flex-wrap gap-2">{q.options.map((o) => <Button key={o} size="sm" variant={ans[q.id] === o ? 'primary' : 'secondary'} onClick={() => setAns({ ...ans, [q.id]: o })}>{o}</Button>)}</div>}
          {q.type === 'TEXT' && <Textarea rows={3} aria-label={q.text} value={ans[q.id] ?? ''} maxLength={2000} onChange={(e) => setAns({ ...ans, [q.id]: e.target.value })} />}
        </CardBody></Card>
      ))}
      <ErrorNote error={submit.error} />
      <div className="flex justify-end"><Button loading={submit.isPending} disabled={missing.length > 0} onClick={() => submit.mutate()}>Send answers</Button></div>
    </div>
  );
}

function Results({ id }) {
  const [dept, setDept] = useState('');
  const { data: r, isPending } = useQuery({ queryKey: ['survey-results', id, dept], queryFn: () => api.get(`/engagement/surveys/${id}/results${dept ? `?departmentId=${dept}` : ''}`) });
  if (isPending) return <Skeleton className="h-64" />;
  const enps = r.questions.find((q) => q.type === 'ENPS');
  const ratings = r.questions.filter((q) => q.type === 'RATING');
  return (
    <div className="space-y-4">
      <Tiles tiles={[
        { label: 'Answered', value: `${r.responses} of ${r.invited}`, hint: `${r.responseRate}% response rate` },
        enps && { label: 'eNPS', value: enps.enps == null ? '—' : `${enps.enps > 0 ? '+' : ''}${enps.enps}`, hint: 'From −100 to +100', tone: enps.enps == null ? undefined : enps.enps >= 20 ? 'success' : enps.enps < 0 ? 'danger' : 'warning' },
        ratings.length > 0 && { label: 'Average favourable', value: `${Math.round(ratings.reduce((n, q) => n + (q.favourable ?? 0), 0) / ratings.length)}%`, hint: 'Agree or strongly agree' },
      ]} />
      {r.groups.length > 0 && <div className="w-60"><Select aria-label="Department" value={dept} onChange={(e) => setDept(e.target.value)} placeholder="Whole company" options={r.groups.map((g) => ({ value: g.id, label: `${g.name} (${g.responses})` }))} /></div>}
      {r.hidden ? (
        <Card><EmptyState icon={<EyeOff className="size-5" />} title="Not enough answers yet" description={`Results appear once at least ${r.survey.minGroup} people have answered${dept ? ' in this department' : ''}, so nobody can be identified.`} /></Card>
      ) : r.questions.map((q, i) => (
        <Card key={q.id}><CardBody>
          <p className="mb-3 font-medium text-ink-900"><span className="text-ink-400">{i + 1}. </span>{q.text}</p>
          {q.type === 'RATING' && <>
            <div className="flex h-7 overflow-hidden rounded-md" aria-label={`Average ${q.average}`}>
              {q.distribution.map((n, k) => n > 0 && <div key={k} style={{ width: `${(n / q.answered) * 100}%` }} className={cn('grid place-items-center text-xs font-medium text-white', ['bg-danger-600', 'bg-warning-600', 'bg-ink-400', 'bg-brand-600', 'bg-success-600'][k])}>{Math.round((n / q.answered) * 100)}%</div>)}
            </div>
            <p className="mt-2 text-sm text-ink-500">Average {q.average} of 5 · {q.favourable}% favourable · {q.answered} answers</p>
          </>}
          {q.type === 'ENPS' && <p className="text-sm text-ink-700"><span className="text-2xl font-semibold text-ink-900">{q.enps > 0 ? '+' : ''}{q.enps}</span> · {q.promoters} promoters (9–10), {q.passives} passive (7–8), {q.detractors} detractors (0–6)</p>}
          {q.type === 'CHOICE' && <div className="space-y-1.5">{q.counts.sort((x, y) => y.count - x.count).map((c) => (
            <div key={c.option} className="flex items-center gap-2 text-sm"><span className="w-40 shrink-0 truncate text-ink-700">{c.option}</span><div className="h-2 flex-1 rounded-full bg-subtle"><div className="h-full rounded-full bg-brand-600" style={{ width: `${q.answered ? (c.count / q.answered) * 100 : 0}%` }} /></div><span className="w-8 text-right tabular-nums text-ink-500">{c.count}</span></div>
          ))}</div>}
          {q.type === 'TEXT' && (q.comments.length ? <ul className="space-y-2">{q.comments.map((t, k) => <li key={k} className="rounded-md bg-subtle p-2.5 text-sm text-ink-700">{t}</li>)}</ul> : <p className="text-sm text-ink-500">No written answers.</p>)}
        </CardBody></Card>
      ))}
    </div>
  );
}

// =========================================================================== recognition
export function Recognition() {
  const a = useAuth();
  const { data, isPending } = useQuery({ queryKey: ['kudos'], queryFn: () => api.get('/engagement/kudos') });
  const [give, setGive] = useState(false);
  const hide = useAction(({ id, hidden }) => api.post(`/engagement/kudos/${id}/hide`, { hidden }), { success: (r) => (r.hidden ? 'Hidden from the wall' : 'Shown again'), invalidate: [['kudos']] });
  return (
    <>
      <PageHeader title="Recognition" description="Say thank you in public when a colleague does great work."
        actions={a.can('engagement:create') && a.employeeId && <Button onClick={() => setGive(true)}><Award className="size-4" />Recognise someone</Button>} />
      {isPending ? <Skeleton className="h-64" /> : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr] [&>*]:min-w-0">
          <div className="space-y-3">
            {!data.items.length ? <Card><EmptyState icon={<Heart className="size-5" />} title="No recognition yet" description="Be the first: thank a colleague who helped you this week." action={a.employeeId ? <Button onClick={() => setGive(true)}>Recognise someone</Button> : undefined} /></Card>
              : data.items.map((k) => (
                <Card key={k.id} className={k.hidden ? 'opacity-60' : ''}><CardBody>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="text-sm text-ink-700"><span className="font-semibold text-ink-900">{k.from.name}</span> recognised <span className="font-semibold text-ink-900">{k.to.name}</span></p>
                    <Badge tone="brand">{k.valueLabel}</Badge>
                  </div>
                  <p className="mt-2 text-ink-900">“{k.message}”</p>
                  <div className="mt-2 flex items-center justify-between gap-2 text-xs text-ink-400"><span>{dt(k.createdAt, true)}</span>
                    {k.canHide && <button type="button" className="inline-flex items-center gap-1 hover:text-ink-900" onClick={() => hide.mutate({ id: k.id, hidden: !k.hidden })}>{k.hidden ? <><Eye className="size-3.5" />Show</> : <><EyeOff className="size-3.5" />Hide</>}</button>}
                  </div>
                </CardBody></Card>
              ))}
          </div>
          <div className="space-y-4">
            {data.mine && <Card><CardBody className="grid grid-cols-2 gap-3 text-center"><div><p className="text-2xl font-semibold">{data.mine.received}</p><p className="text-xs text-ink-500">Received</p></div><div><p className="text-2xl font-semibold">{data.mine.given}</p><p className="text-xs text-ink-500">Given</p></div></CardBody></Card>}
            <Card><CardHeader title="Most recognised this month" />
              {!data.topThisMonth.length ? <CardBody className="text-sm text-ink-500">Nobody yet this month.</CardBody> : <ol className="divide-y divide-line">{data.topThisMonth.map((x, i) => <li key={x.employee.id} className="flex justify-between gap-2 px-5 py-2.5 text-sm"><span><span className="text-ink-400">{i + 1}. </span>{x.employee.name}</span><span className="tabular-nums text-ink-500">{x.count}</span></li>)}</ol>}
            </Card>
          </div>
        </div>
      )}
      {give && <KudosDialog values={data?.values ?? {}} me={a.employeeId} onClose={() => setGive(false)} />}
    </>
  );
}

function KudosDialog({ values, me, onClose }) {
  const [v, setV] = useState({ toEmployeeId: '', value: 'TEAMWORK', message: '' });
  const save = useAction((b) => api.post('/engagement/kudos', b), { success: 'Recognition posted', invalidate: [['kudos']], onDone: onClose });
  const fe = save.error?.fieldErrors ?? {};
  return (
    <Dialog open onClose={onClose} title="Recognise a colleague" description="Everyone in the company can see it."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!v.toEmployeeId} onClick={() => save.mutate(v)}>Post</Button></>}>
      <div className="space-y-4">
        <Field label="Who" required error={fe.toEmployeeId}><PersonPicker value={v.toEmployeeId} exclude={[me]} onChange={(toEmployeeId) => setV({ ...v, toEmployeeId })} /></Field>
        <Field label="For"><div className="flex flex-wrap gap-2">{Object.entries(values).map(([k, l]) => <Button key={k} size="sm" variant={v.value === k ? 'primary' : 'secondary'} onClick={() => setV({ ...v, value: k })}>{l}</Button>)}</div></Field>
        <Field label="What did they do?" required error={fe.message}><Textarea rows={3} maxLength={500} value={v.message} onChange={(e) => setV({ ...v, message: e.target.value })} placeholder="e.g. Stayed late to finish the stock count so the store could open on time." /></Field>
      </div>
    </Dialog>
  );
}

