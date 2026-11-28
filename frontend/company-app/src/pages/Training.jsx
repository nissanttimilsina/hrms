import { useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Award, BookOpen, CalendarPlus, Download, GraduationCap, Plus, Upload, Users } from 'lucide-react';
import { Button, Card, CardBody, CardHeader, DataTable, Dialog, EmptyState, Field, Input, Select, Skeleton, Textarea, Checkbox, Badge } from '@hrms/shared-ui';
import { api, useAuth, useAction, PageHeader, StatusBadge, npr, dt, todayKtm, addDays } from '../lib.jsx';
import { PeoplePicker, Tabs, Tiles, BackLink, ErrorNote, Rating, label, useDownload } from './kit.jsx';

const DELIVERY = [['IN_PERSON', 'In person'], ['ONLINE', 'Online'], ['EXTERNAL', 'External provider'], ['ON_THE_JOB', 'On the job']];
const CERT_TONE = { VALID: 'success', EXPIRING: 'warning', EXPIRED: 'danger' };
const CERT_TEXT = { VALID: 'Valid', EXPIRING: 'Expires soon', EXPIRED: 'Expired' };
const STATUS_TEXT = { REQUESTED: 'Waiting for approval', ENROLLED: 'Enrolled', COMPLETED: 'Completed', NO_SHOW: 'Did not attend', CANCELLED: 'Cancelled', REJECTED: 'Not approved' };
const when = (s) => (s ? `${dt(s.startsAt, true)}${s.location ? ` · ${s.location}` : ''}` : 'Date to be announced');

// =========================================================================== employee
export function MyTraining() {
  const [tab, setTab] = useState('mine');
  const { data: mine = [], isPending } = useQuery({ queryKey: ['my-training'], queryFn: () => api.get('/training/enrollments?view=mine') });
  const { data: sum } = useQuery({ queryKey: ['training-summary'], queryFn: () => api.get('/training/summary') });
  const [rate, setRate] = useState(null);
  const [upload, setUpload] = useState(null);
  const download = useDownload();
  const current = mine.filter((e) => ['REQUESTED', 'ENROLLED'].includes(e.status));
  const done = mine.filter((e) => e.status === 'COMPLETED');
  const m = sum?.mine;
  return (
    <>
      <PageHeader title="My training" description="Courses you are on, what you have completed, and certificates." />
      <Tiles tiles={[
        { label: 'Coming up', value: m?.upcoming, hint: m?.requested ? `${m.requested} waiting for approval` : undefined },
        { label: 'Completed this year', value: m?.completedThisYear },
        { label: 'Training hours this year', value: m?.hoursThisYear },
        { label: 'Certificates to renew', value: m?.expiring, tone: m?.expiring ? 'warning' : undefined },
      ]} />
      <Tabs value={tab} onChange={setTab} tabs={[['mine', 'My courses'], ['catalog', 'Browse courses']]} />
      {tab === 'catalog' ? <Catalog /> : isPending ? <Skeleton className="h-48" /> : !mine.length ? (
        <Card><EmptyState icon={<GraduationCap className="size-5" />} title="No training yet" description="Browse the courses on offer and ask for a place." action={<Button onClick={() => setTab('catalog')}>Browse courses</Button>} /></Card>
      ) : (
        <div className="space-y-4">
          {current.length > 0 && <div className="grid grid-cols-1 gap-3 md:grid-cols-2 [&>*]:min-w-0">{current.map((e) => (
            <Card key={e.id}><CardBody>
              <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-semibold text-ink-900">{e.course.title}</p><p className="text-sm text-ink-500">{when(e.session)}</p></div><Badge tone={e.status === 'ENROLLED' ? 'success' : 'warning'}>{STATUS_TEXT[e.status]}</Badge></div>
              {e.decisionNote && <p className="mt-2 text-sm text-ink-700">{e.decisionNote}</p>}
            </CardBody></Card>
          ))}</div>}
          <Card>
            <CardHeader title="Completed" />
            {!done.length ? <CardBody className="text-sm text-ink-500">Nothing completed yet.</CardBody> : (
              <ul className="divide-y divide-line">{done.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0"><p className="text-sm font-medium text-ink-900">{e.course.title}</p><p className="text-xs text-ink-500">Completed {dt(e.completedOn)}{e.score != null ? ` · score ${e.score}` : ''}{e.certificateExpiresOn ? ` · certificate until ${dt(e.certificateExpiresOn)}` : ''}</p></div>
                  <div className="flex flex-wrap items-center gap-2">
                    {e.certificateState && <Badge tone={CERT_TONE[e.certificateState]}>{CERT_TEXT[e.certificateState]}</Badge>}
                    {e.hasCertificate ? <Button size="sm" variant="ghost" onClick={() => download(`/training/enrollments/${e.id}/certificate`, `certificate-${e.course.title}.pdf`)}><Download className="size-4" />Certificate</Button>
                      : <Button size="sm" variant="ghost" onClick={() => setUpload(e)}><Upload className="size-4" />Add certificate</Button>}
                    {e.abilities.feedback && <Button size="sm" variant="secondary" onClick={() => setRate(e)}>Rate it</Button>}
                  </div>
                </li>
              ))}</ul>
            )}
          </Card>
        </div>
      )}
      {rate && <FeedbackDialog e={rate} onClose={() => setRate(null)} />}
      {upload && <CertificateDialog e={upload} onClose={() => setUpload(null)} />}
    </>
  );
}

function Catalog() {
  const { data = [], isPending } = useQuery({ queryKey: ['training-courses'], queryFn: () => api.get('/training/courses') });
  const [ask, setAsk] = useState(null);
  if (isPending) return <Skeleton className="h-48" />;
  if (!data.length) return <Card><EmptyState icon={<BookOpen className="size-5" />} title="No courses yet" description="HR has not added any courses." /></Card>;
  return (
    <>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 [&>*]:min-w-0">
        {data.map((c) => (
          <Card key={c.id}><CardBody className="flex h-full flex-col">
            <div className="flex items-start justify-between gap-2"><p className="font-semibold text-ink-900">{c.title}</p>{c.mandatory && <Badge tone="warning">Required</Badge>}</div>
            <p className="text-xs text-ink-500">{c.category} · {DELIVERY.find(([k]) => k === c.delivery)?.[1]}{c.durationHours ? ` · ${c.durationHours} h` : ''}</p>
            {c.description && <p className="mt-2 line-clamp-3 text-sm text-ink-700">{c.description}</p>}
            {c.nextSessions.length > 0 && <p className="mt-2 text-xs text-ink-500">Next: {when(c.nextSessions[0])}</p>}
            <div className="mt-auto pt-3">
              {c.myStatus ? <Badge tone={c.myStatus === 'COMPLETED' ? 'success' : 'brand'}>{STATUS_TEXT[c.myStatus]}</Badge>
                : c.selfEnroll ? <Button size="sm" onClick={() => setAsk(c)}>Ask for a place</Button> : <p className="text-xs text-ink-400">By invitation from HR</p>}
            </div>
          </CardBody></Card>
        ))}
      </div>
      {ask && <RequestDialog c={ask} onClose={() => setAsk(null)} />}
    </>
  );
}

function RequestDialog({ c, onClose }) {
  const [v, setV] = useState({ sessionId: c.nextSessions[0]?.id ?? '', note: '' });
  const req = useAction((b) => api.post('/training/enrollments', b), { success: 'Request sent to your manager', invalidate: [['training-courses'], ['my-training'], ['training-summary']], onDone: onClose });
  return (
    <Dialog open onClose={onClose} title={`Ask for a place: ${c.title}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={req.isPending} onClick={() => req.mutate({ courseId: c.id, sessionId: v.sessionId || null, note: v.note || undefined })}>Send request</Button></>}>
      <div className="space-y-4">
        {c.nextSessions.length > 0 && <Field label="Session"><Select value={v.sessionId} onChange={(e) => setV({ ...v, sessionId: e.target.value })} placeholder="Any date" options={c.nextSessions.map((s) => ({ value: s.id, label: when(s) }))} /></Field>}
        <Field label="Why do you want it? (optional)"><Textarea rows={3} value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} /></Field>
        <ErrorNote error={req.error} />
      </div>
    </Dialog>
  );
}

function FeedbackDialog({ e, onClose }) {
  const [v, setV] = useState({ rating: null, comment: '' });
  const save = useAction((b) => api.post(`/training/enrollments/${e.id}/feedback`, b), { success: 'Thank you', invalidate: [['my-training']], onDone: onClose });
  return (
    <Dialog open onClose={onClose} title={`How was ${e.course.title}?`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!v.rating} onClick={() => save.mutate({ rating: v.rating, comment: v.comment || undefined })}>Send</Button></>}>
      <div className="space-y-4">
        <Rating name="Rating" value={v.rating} onChange={(rating) => setV({ ...v, rating })} labels={{ 1: 'Not useful', 2: 'Somewhat useful', 3: 'Useful', 4: 'Very useful', 5: 'Excellent' }} />
        <Field label="Comment"><Textarea rows={3} value={v.comment} onChange={(e2) => setV({ ...v, comment: e2.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

function CertificateDialog({ e, onClose }) {
  const ref = useRef(null);
  const [file, setFile] = useState(null);
  const save = useAction(() => { const fd = new FormData(); fd.append('certificate', file); return api.post(`/training/enrollments/${e.id}/certificate`, fd); }, { success: 'Certificate saved', invalidate: [['my-training'], ['course']], onDone: onClose });
  return (
    <Dialog open onClose={onClose} title="Add the certificate" description={e.course.title}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!file} onClick={() => save.mutate()}>Save</Button></>}>
      <input ref={ref} type="file" accept="application/pdf,image/jpeg,image/png" className="sr-only" aria-label="Certificate file" onChange={(x) => setFile(x.target.files?.[0] ?? null)} />
      <Button variant="secondary" onClick={() => ref.current?.click()}><Upload className="size-4" />{file ? file.name : 'Choose a PDF or photo'}</Button>
      <div className="mt-3"><ErrorNote error={save.error} /></div>
    </Dialog>
  );
}

// =========================================================================== HR and managers
export function TrainingAdmin() {
  const a = useAuth();
  const nav = useNavigate();
  const [tab, setTab] = useState(new URLSearchParams(window.location.search).get('tab') ?? 'courses');
  const manage = a.can('training:manage');
  const { data: courses = [], isPending } = useQuery({ queryKey: ['training-courses', 'all'], queryFn: () => api.get('/training/courses?all=true') });
  const { data: sessions = [] } = useQuery({ queryKey: ['training-sessions'], queryFn: () => api.get('/training/sessions'), enabled: tab === 'sessions' });
  const { data: requests = [] } = useQuery({ queryKey: ['training-requests'], queryFn: () => api.get('/training/enrollments?view=requests') });
  const { data: certs = [] } = useQuery({ queryKey: ['training-certs'], queryFn: () => api.get('/training/enrollments?view=team&certificates=expiring'), enabled: tab === 'certs' });
  const { data: sum } = useQuery({ queryKey: ['training-summary'], queryFn: () => api.get('/training/summary') });
  const [dlg, setDlg] = useState(null);
  const decide = useAction(({ id, ...b }) => api.post(`/training/enrollments/${id}/decide`, b), { success: (r) => (r.status === 'ENROLLED' ? 'Approved' : 'Declined'), invalidate: [['training-requests'], ['training-summary']] });
  const t = sum?.team;
  return (
    <>
      <PageHeader title="Training" description="Courses, sessions, requests from your people, and certificates."
        actions={<>
          {a.can('training:export') && <Button variant="secondary" onClick={() => setDlg('export')}><Download className="size-4" />Export</Button>}
          {manage && <Button onClick={() => setDlg('course')}><Plus className="size-4" />New course</Button>}
        </>} />
      <Tiles tiles={[
        { label: 'Requests to decide', value: t?.requests, tone: t?.requests ? 'warning' : undefined, onClick: () => setTab('requests') },
        { label: 'Upcoming sessions', value: t?.upcomingSessions, onClick: () => setTab('sessions') },
        { label: 'Certificates expiring', value: t?.expiring, hint: 'In the next 60 days', tone: t?.expiring ? 'warning' : undefined, onClick: () => setTab('certs') },
        { label: 'Expired certificates', value: t?.expired, tone: t?.expired ? 'danger' : undefined, onClick: () => setTab('compliance') },
      ]} />
      <Tabs value={tab} onChange={setTab} tabs={[['courses', 'Courses'], ['sessions', 'Sessions'], ['requests', 'Requests', requests.length], ['certs', 'Certificates'], ['compliance', 'Required training']]} />
      {tab === 'courses' && (isPending ? <Skeleton className="h-48" /> : (
        <DataTable rows={courses} onRowClick={(r) => nav(`/training/courses/${r.id}`)}
          empty={<EmptyState icon={<BookOpen className="size-5" />} title="No courses yet" description="Add the trainings your company runs or pays for: safety, product, sales, software, compliance." action={manage ? <Button onClick={() => setDlg('course')}>New course</Button> : undefined} />}
          mobile={(c) => <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-medium text-ink-900">{c.title}</p><p className="text-xs text-ink-400">{c.category}{c.nextSessions[0] ? ` · next ${dt(c.nextSessions[0].startsAt)}` : ''}</p></div>{c.mandatory ? <Badge tone="warning">Required</Badge> : !c.active ? <Badge>Not in use</Badge> : null}</div>}
          columns={[
            { key: 'title', header: 'Course', render: (c) => <><p className="font-medium text-ink-900">{c.title}</p><p className="text-xs text-ink-400">{c.category} · {DELIVERY.find(([k]) => k === c.delivery)?.[1]}</p></> },
            { key: 'hours', header: 'Hours', align: 'right', render: (c) => c.durationHours ?? '—' },
            { key: 'next', header: 'Next session', render: (c) => (c.nextSessions[0] ? dt(c.nextSessions[0].startsAt, true) : '—') },
            { key: 'flags', header: '', render: (c) => <span className="flex gap-1">{c.mandatory && <Badge tone="warning">Required</Badge>}{c.certificateValidMonths && <Badge>Certificate</Badge>}{!c.active && <Badge>Not in use</Badge>}</span> },
          ]} />
      ))}
      {tab === 'sessions' && (
        <DataTable rows={sessions} onRowClick={(r) => nav(`/training/courses/${r.courseId}`)}
          empty={<EmptyState icon={<CalendarPlus className="size-5" />} title="No sessions scheduled" description="Open a course to schedule a session." />}
          mobile={(s) => <><p className="font-medium text-ink-900">{s.course.title}</p><p className="text-xs text-ink-500">{when(s)} · {s.enrolled}{s.capacity ? ` of ${s.capacity}` : ''} enrolled</p></>}
          columns={[
            { key: 'when', header: 'When', render: (s) => dt(s.startsAt, true) },
            { key: 'course', header: 'Course', render: (s) => <span className="font-medium text-ink-900">{s.course.title}</span> },
            { key: 'where', header: 'Where', render: (s) => s.location ?? '—' },
            { key: 'seats', header: 'Enrolled', align: 'right', render: (s) => `${s.enrolled}${s.capacity ? ` / ${s.capacity}` : ''}` },
            { key: 'status', header: 'Status', render: (s) => <StatusBadge value={s.status} /> },
          ]} />
      )}
      {tab === 'requests' && (
        <DataTable rows={requests}
          empty={<EmptyState icon={<Users className="size-5" />} title="No requests waiting" description="When someone in your team asks for a course, it appears here." />}
          mobile={(e) => <><p className="font-medium text-ink-900">{e.employee.name}</p><p className="text-xs text-ink-500">{e.course.title} · {when(e.session)}</p>{e.requestNote && <p className="mt-1 text-sm text-ink-700">{e.requestNote}</p>}<div className="mt-2 flex gap-2"><Button size="sm" loading={decide.isPending} onClick={() => decide.mutate({ id: e.id, approve: true })}>Approve</Button><Button size="sm" variant="ghost" onClick={() => setDlg({ decline: e })}>Decline</Button></div></>}
          columns={[
            { key: 'employee', header: 'Employee', render: (e) => <><p className="font-medium text-ink-900">{e.employee.name}</p><p className="text-xs text-ink-400">{e.employee.code}</p></> },
            { key: 'course', header: 'Course', render: (e) => <><p>{e.course.title}</p><p className="text-xs text-ink-400">{when(e.session)}</p></> },
            { key: 'note', header: 'Reason', render: (e) => <span className="line-clamp-2 max-w-64 text-ink-700">{e.requestNote ?? '—'}</span> },
            { key: 'x', header: '', render: (e) => <div className="flex justify-end gap-1"><Button size="sm" loading={decide.isPending} onClick={() => decide.mutate({ id: e.id, approve: true })}>Approve</Button><Button size="sm" variant="ghost" onClick={() => setDlg({ decline: e })}>Decline</Button></div> },
          ]} />
      )}
      {tab === 'certs' && (
        <DataTable rows={certs}
          empty={<EmptyState icon={<Award className="size-5" />} title="No certificates expiring soon" />}
          mobile={(e) => <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-medium text-ink-900">{e.employee.name}</p><p className="text-xs text-ink-500">{e.course.title} · until {dt(e.certificateExpiresOn)}</p></div><Badge tone={CERT_TONE[e.certificateState]}>{CERT_TEXT[e.certificateState]}</Badge></div>}
          columns={[
            { key: 'employee', header: 'Employee', render: (e) => e.employee.name },
            { key: 'course', header: 'Course', render: (e) => e.course.title },
            { key: 'until', header: 'Valid until', render: (e) => dt(e.certificateExpiresOn) },
            { key: 'state', header: '', render: (e) => <Badge tone={CERT_TONE[e.certificateState]}>{CERT_TEXT[e.certificateState]}</Badge> },
          ]} />
      )}
      {tab === 'compliance' && <Compliance />}
      {dlg === 'course' && <CourseDialog onClose={() => setDlg(null)} onDone={(c) => { setDlg(null); nav(`/training/courses/${c.id}`); }} />}
      {dlg === 'export' && <TrainingExport onClose={() => setDlg(null)} />}
      {dlg?.decline && <DeclineDialog e={dlg.decline} action={decide} onClose={() => setDlg(null)} />}
    </>
  );
}

function DeclineDialog({ e, action, onClose }) {
  const [note, setNote] = useState('');
  return (
    <Dialog open onClose={onClose} title={`Decline ${e.employee.name}'s request?`} description={e.course.title}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" loading={action.isPending} onClick={() => action.mutate({ id: e.id, approve: false, note }, { onSuccess: onClose })}>Decline</Button></>}>
      <Field label="Reason (they see it)" required error={action.error?.fieldErrors?.note}><Textarea rows={2} value={note} onChange={(x) => setNote(x.target.value)} /></Field>
    </Dialog>
  );
}

function Compliance() {
  const { data, isPending } = useQuery({ queryKey: ['training-compliance'], queryFn: () => api.get('/training/compliance') });
  if (isPending) return <Skeleton className="h-48" />;
  if (!data.courses.length) return <Card><EmptyState icon={<Award className="size-5" />} title="No required courses" description="Mark a course as required to track who has done it." /></Card>;
  const STATE = { DONE: ['success', 'Done'], ENROLLED: ['brand', 'Enrolled'], EXPIRED: ['danger', 'Expired'], MISSING: ['warning', 'Missing'] };
  return (
    <DataTable rows={data.rows.map((r) => ({ ...r, id: r.employee.id }))}
      mobile={(r) => <><p className="font-medium text-ink-900">{r.employee.name}</p><div className="mt-1 flex flex-wrap gap-1">{data.courses.map((c) => { const [tone, l] = STATE[r.courses[c.id].state]; return <Badge key={c.id} tone={tone}>{c.title}: {l}</Badge>; })}</div></>}
      columns={[
        { key: 'employee', header: 'Employee', render: (r) => <span className="font-medium text-ink-900">{r.employee.name}</span> },
        ...data.courses.map((c) => ({ key: c.id, header: c.title, render: (r) => { const x = r.courses[c.id]; const [tone, l] = STATE[x.state]; return <><Badge tone={tone}>{l}</Badge>{x.expiresOn && <p className="mt-0.5 text-xs text-ink-400">until {dt(x.expiresOn)}</p>}</>; } })),
      ]} />
  );
}

function CourseDialog({ course, onClose, onDone }) {
  const [v, setV] = useState(() => ({
    title: course?.title ?? '', category: course?.category ?? 'General', description: course?.description ?? '', delivery: course?.delivery ?? 'IN_PERSON', provider: course?.provider ?? '',
    durationHours: course?.durationHours ?? '', costPerPerson: course?.costPerPerson ?? '', certificateValidMonths: course?.certificateValidMonths ?? '',
    mandatory: course?.mandatory ?? false, selfEnroll: course?.selfEnroll ?? true, active: course?.active ?? true,
  }));
  const save = useAction((b) => (course ? api.patch(`/training/courses/${course.id}`, b) : api.post('/training/courses', b)), { success: 'Course saved', invalidate: [['training-courses'], ['course']], onDone });
  const fe = save.error?.fieldErrors ?? {};
  const set = (k) => (e) => setV((p) => ({ ...p, [k]: e.target.value }));
  const n = (x) => (x === '' ? null : Number(x));
  return (
    <Dialog open onClose={onClose} title={course ? 'Edit course' : 'New course'} size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate({ ...v, description: v.description || undefined, provider: v.provider || undefined, durationHours: n(v.durationHours), costPerPerson: n(v.costPerPerson), certificateValidMonths: n(v.certificateValidMonths) })}>Save</Button></>}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="Title" required error={fe.title} className="sm:col-span-2"><Input value={v.title} maxLength={160} onChange={set('title')} /></Field>
        <Field label="Category"><Input value={v.category} maxLength={60} onChange={set('category')} placeholder="Safety, Sales, Software…" /></Field>
        <Field label="Delivery"><Select value={v.delivery} onChange={set('delivery')} options={DELIVERY.map(([value, l]) => ({ value, label: l }))} /></Field>
        <Field label="Provider or trainer"><Input value={v.provider} onChange={set('provider')} /></Field>
        <Field label="Hours"><Input type="number" min="0" step="0.5" value={v.durationHours} onChange={set('durationHours')} /></Field>
        <Field label="Cost per person (NPR)"><Input type="number" min="0" value={v.costPerPerson} onChange={set('costPerPerson')} /></Field>
        <Field label="Certificate valid for (months)" hint="Leave empty if it does not expire"><Input type="number" min="1" value={v.certificateValidMonths} onChange={set('certificateValidMonths')} /></Field>
        <Field label="Description" className="sm:col-span-2"><Textarea rows={3} value={v.description} onChange={set('description')} /></Field>
        <div className="flex flex-wrap gap-4 sm:col-span-2">
          <Checkbox label="Required for everyone" checked={v.mandatory} onChange={(e) => setV({ ...v, mandatory: e.target.checked })} />
          <Checkbox label="Employees can ask for a place" checked={v.selfEnroll} onChange={(e) => setV({ ...v, selfEnroll: e.target.checked })} />
          <Checkbox label="In use" checked={v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} />
        </div>
      </div>
    </Dialog>
  );
}

function TrainingExport({ onClose }) {
  const download = useDownload();
  const [r, setR] = useState({ from: addDays(todayKtm(), -365), to: todayKtm() });
  return (
    <Dialog open onClose={onClose} title="Export completed training" description="A CSV of who completed what, with hours, scores, certificates and cost."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={async () => { await download(`/training/export?from=${r.from}&to=${r.to}`, `training-${r.from}-to-${r.to}.csv`); onClose(); }}>Download CSV</Button></>}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="Completed from"><Input type="date" value={r.from} onChange={(e) => setR({ ...r, from: e.target.value })} /></Field>
        <Field label="To"><Input type="date" value={r.to} onChange={(e) => setR({ ...r, to: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

// =========================================================================== course detail
export function CourseDetail() {
  const { id } = useParams();
  const key = ['course', id];
  const { data: c, isPending, error } = useQuery({ queryKey: key, queryFn: () => api.get(`/training/courses/${id}`) });
  const [dlg, setDlg] = useState(null);
  const sessionStatus = useAction(({ sid, status }) => api.post(`/training/sessions/${sid}/status`, { status }), { success: 'Session updated', invalidate: [key, ['training-sessions']] });
  if (isPending) return <Skeleton className="h-96" />;
  if (error) return <EmptyState title="Course not found" description={error.message} />;
  const ab = c.abilities;
  const upcoming = c.sessions.filter((s) => s.status === 'SCHEDULED');
  return (
    <>
      <BackLink to="/training">Training</BackLink>
      <PageHeader title={c.title} description={[c.category, DELIVERY.find(([k]) => k === c.delivery)?.[1], c.durationHours && `${c.durationHours} hours`, c.provider].filter(Boolean).join(' · ')}
        actions={<>
          {ab.manage && <Button variant="secondary" onClick={() => setDlg('edit')}>Edit</Button>}
          {ab.manage && <Button variant="secondary" onClick={() => setDlg('session')}><CalendarPlus className="size-4" />Schedule session</Button>}
          {ab.enrol && <Button onClick={() => setDlg('enrol')}><Users className="size-4" />Enrol people</Button>}
        </>} />
      <div className="mb-4 flex flex-wrap gap-2">{c.mandatory && <Badge tone="warning">Required for everyone</Badge>}{c.certificateValidMonths && <Badge>Certificate valid {c.certificateValidMonths} months</Badge>}{c.costPerPerson != null && <Badge>{npr(c.costPerPerson)} per person</Badge>}{!c.active && <Badge tone="danger">Not in use</Badge>}</div>
      {c.description && <Card className="mb-4"><CardBody className="whitespace-pre-wrap text-sm text-ink-700">{c.description}</CardBody></Card>}
      <Card className="mb-4">
        <CardHeader title="Sessions" />
        {!c.sessions.length ? <CardBody className="text-sm text-ink-500">No sessions yet.</CardBody> : (
          <ul className="divide-y divide-line">{c.sessions.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
              <div className="min-w-0"><p className="text-sm font-medium text-ink-900">{dt(s.startsAt, true)}</p><p className="text-xs text-ink-500">{[s.location, s.trainer].filter(Boolean).join(' · ') || 'No place set'} · {s.enrolled}{s.capacity ? ` of ${s.capacity}` : ''} enrolled</p></div>
              <div className="flex items-center gap-2"><StatusBadge value={s.status} />
                {ab.manage && s.status === 'SCHEDULED' && <><Button size="sm" variant="ghost" onClick={() => sessionStatus.mutate({ sid: s.id, status: 'COMPLETED' })}>Mark held</Button><Button size="sm" variant="ghost" onClick={() => sessionStatus.mutate({ sid: s.id, status: 'CANCELLED' })}>Cancel</Button></>}
              </div>
            </li>
          ))}</ul>
        )}
      </Card>
      <DataTable rows={c.enrollments}
        empty={<EmptyState icon={<Users className="size-5" />} title="Nobody enrolled yet" />}
        mobile={(e) => <><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-medium text-ink-900">{e.employee.name}</p><p className="text-xs text-ink-500">{e.session ? dt(e.session.startsAt) : 'No session'}{e.completedOn ? ` · completed ${dt(e.completedOn)}` : ''}</p></div><StatusBadge value={e.status} /></div>{e.abilities.complete && <Button size="sm" variant="secondary" className="mt-2" onClick={() => setDlg({ complete: e })}>Record result</Button>}</>}
        columns={[
          { key: 'employee', header: 'Employee', render: (e) => <><p className="font-medium text-ink-900">{e.employee.name}</p><p className="text-xs text-ink-400">{e.employee.code}</p></> },
          { key: 'session', header: 'Session', render: (e) => (e.session ? dt(e.session.startsAt) : '—') },
          { key: 'status', header: 'Status', render: (e) => <StatusBadge value={e.status} /> },
          { key: 'result', header: 'Result', render: (e) => (e.status === 'COMPLETED' ? <>{dt(e.completedOn)}{e.score != null ? ` · ${e.score}` : ''}{e.certificateState && <p><Badge tone={CERT_TONE[e.certificateState]}>{CERT_TEXT[e.certificateState]}</Badge></p>}</> : '—') },
          { key: 'feedback', header: 'Feedback', render: (e) => (e.feedbackRating ? `${e.feedbackRating}/5` : '—') },
          { key: 'x', header: '', render: (e) => (e.abilities.complete ? <Button size="sm" variant="secondary" onClick={() => setDlg({ complete: e })}>Record result</Button> : null) },
        ]} />
      {dlg === 'edit' && <CourseDialog course={c} onClose={() => setDlg(null)} onDone={() => setDlg(null)} />}
      {dlg === 'session' && <SessionDialog courseId={id} onClose={() => setDlg(null)} />}
      {dlg === 'enrol' && <EnrolDialog c={c} sessions={upcoming} onClose={() => setDlg(null)} />}
      {dlg?.complete && <CompleteDialog e={dlg.complete} certificate={!!c.certificateValidMonths} onClose={() => setDlg(null)} />}
    </>
  );
}

function SessionDialog({ courseId, onClose }) {
  const [v, setV] = useState({ date: addDays(todayKtm(), 7), start: '10:00', end: '13:00', location: '', trainer: '', capacity: '' });
  const save = useAction((b) => api.post(`/training/courses/${courseId}/sessions`, b), { success: 'Session scheduled', invalidate: [['course', courseId], ['training-sessions']], onDone: onClose });
  const fe = save.error?.fieldErrors ?? {};
  return (
    <Dialog open onClose={onClose} title="Schedule a session"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate({ startsAt: new Date(`${v.date}T${v.start}:00+05:45`).toISOString(), endsAt: new Date(`${v.date}T${v.end}:00+05:45`).toISOString(), location: v.location || undefined, trainer: v.trainer || undefined, capacity: v.capacity ? Number(v.capacity) : null })}>Schedule</Button></>}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 [&>*]:min-w-0">
        <Field label="Date"><Input type="date" min={todayKtm()} value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} /></Field>
        <Field label="Starts"><Input type="time" value={v.start} onChange={(e) => setV({ ...v, start: e.target.value })} /></Field>
        <Field label="Ends" error={fe.endsAt}><Input type="time" value={v.end} onChange={(e) => setV({ ...v, end: e.target.value })} /></Field>
        <Field label="Place or link" className="sm:col-span-2"><Input value={v.location} onChange={(e) => setV({ ...v, location: e.target.value })} /></Field>
        <Field label="Seats"><Input type="number" min="1" value={v.capacity} onChange={(e) => setV({ ...v, capacity: e.target.value })} placeholder="No limit" /></Field>
        <Field label="Trainer" className="sm:col-span-3"><Input value={v.trainer} onChange={(e) => setV({ ...v, trainer: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

function EnrolDialog({ c, sessions, onClose }) {
  const [v, setV] = useState({ sessionId: sessions[0]?.id ?? '', people: [] });
  const save = useAction((b) => api.post('/training/enrollments', b), {
    success: (r) => `${r.enrolled} enrolled${r.skipped.length ? `. Already enrolled: ${r.skipped.join(', ')}` : ''}`, invalidate: [['course', c.id], ['training-summary']], onDone: onClose,
  });
  return (
    <Dialog open onClose={onClose} title={`Enrol people: ${c.title}`} description="They get a notification with the date and place." size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!v.people.length} onClick={() => save.mutate({ courseId: c.id, sessionId: v.sessionId || null, employeeIds: v.people.map((p) => p.id) })}>Enrol {v.people.length || ''}</Button></>}>
      <div className="space-y-4">
        <Field label="Session"><Select value={v.sessionId} onChange={(e) => setV({ ...v, sessionId: e.target.value })} placeholder="No session yet" options={sessions.map((s) => ({ value: s.id, label: `${dt(s.startsAt, true)}${s.capacity ? ` (${s.capacity - s.enrolled} seats left)` : ''}` }))} /></Field>
        <Field label="People"><PeoplePicker value={v.people} onChange={(people) => setV({ ...v, people })} max={200} /></Field>
        <ErrorNote error={save.error} />
      </div>
    </Dialog>
  );
}

function CompleteDialog({ e, certificate, onClose }) {
  const ref = useRef(null);
  const [v, setV] = useState({ outcome: 'COMPLETED', completedOn: todayKtm(), score: '' });
  const [file, setFile] = useState(null);
  const save = useAction(() => {
    const fd = new FormData(); fd.append('outcome', v.outcome); fd.append('completedOn', v.completedOn); if (v.score !== '') fd.append('score', v.score); if (file) fd.append('certificate', file);
    return api.post(`/training/enrollments/${e.id}/complete`, fd);
  }, { success: 'Result recorded', invalidate: [['course'], ['training-summary'], ['training-compliance']], onDone: onClose });
  return (
    <Dialog open onClose={onClose} title={`Result for ${e.employee.name}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="space-y-4">
        <div className="flex gap-2">{[['COMPLETED', 'Completed'], ['NO_SHOW', 'Did not attend']].map(([k, l]) => <Button key={k} size="sm" variant={v.outcome === k ? 'primary' : 'secondary'} onClick={() => setV({ ...v, outcome: k })}>{l}</Button>)}</div>
        {v.outcome === 'COMPLETED' && <div className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
          <Field label="Completed on"><Input type="date" max={todayKtm()} value={v.completedOn} onChange={(x) => setV({ ...v, completedOn: x.target.value })} /></Field>
          <Field label="Score (optional)"><Input type="number" min="0" max="100" value={v.score} onChange={(x) => setV({ ...v, score: x.target.value })} /></Field>
        </div>}
        {v.outcome === 'COMPLETED' && <div>
          <input ref={ref} type="file" accept="application/pdf,image/jpeg,image/png" className="sr-only" aria-label="Certificate" onChange={(x) => setFile(x.target.files?.[0] ?? null)} />
          <Button size="sm" variant="secondary" onClick={() => ref.current?.click()}><Upload className="size-4" />{file ? file.name : certificate ? 'Attach certificate' : 'Attach certificate (optional)'}</Button>
        </div>}
        <ErrorNote error={save.error} />
      </div>
    </Dialog>
  );
}

