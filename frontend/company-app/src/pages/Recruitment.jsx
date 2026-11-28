import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Briefcase, Calendar, Copy, Download, ExternalLink, FileText, MapPin, Plus, Send, UserCheck, UserPlus, Users, XCircle, CheckCircle2, Upload } from 'lucide-react';
import { Button, Card, CardBody, CardHeader, DataTable, Dialog, EmptyState, Field, Input, Select, Skeleton, Textarea, Checkbox, Badge, cn, useToast } from '@hrms/shared-ui';
import { api, useAuth, useAction, PageHeader, StatusBadge, npr, dt, todayKtm, addDays } from '../lib.jsx';
import { PersonPicker, PeoplePicker, Tabs, BackLink, ErrorNote, Rating, Stars, label, useDownload } from './kit.jsx';

const STAGES = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED'];
const STAGE_LABEL = { APPLIED: 'Applied', SCREENING: 'Screening', INTERVIEW: 'Interview', OFFER: 'Offer', HIRED: 'Hired', REJECTED: 'Rejected', WITHDRAWN: 'Withdrawn' };
const STAGE_TONE = { APPLIED: 'neutral', SCREENING: 'info', INTERVIEW: 'brand', OFFER: 'warning', HIRED: 'success', REJECTED: 'danger', WITHDRAWN: 'neutral' };
const TYPES = [['PERMANENT', 'Permanent'], ['CONTRACT', 'Contract'], ['PROBATION', 'Probation'], ['PART_TIME', 'Part time'], ['INTERN', 'Internship'], ['TEMPORARY', 'Temporary']];
const SOURCES = [['REFERRAL', 'Referral'], ['JOB_PORTAL', 'Job portal'], ['SOCIAL', 'Social media'], ['WALK_IN', 'Walk-in'], ['AGENCY', 'Agency'], ['OTHER', 'Other']];
const REC = { STRONG_YES: 'Strong yes', YES: 'Yes', NO: 'No', STRONG_NO: 'Strong no' };
const SCORE_AREAS = [['skills', 'Skills for the role'], ['experience', 'Relevant experience'], ['communication', 'Communication'], ['attitude', 'Attitude'], ['culture', 'Fits the team']];
const StageBadge = ({ s }) => <Badge tone={STAGE_TONE[s]} dot>{STAGE_LABEL[s]}</Badge>;
const salary = (j) => (j.salaryMin != null || j.salaryMax != null ? [j.salaryMin, j.salaryMax].filter((x) => x != null).map((x) => npr(x)).join(' – ') : null);

const useOrg = () => {
  const d = useQuery({ queryKey: ['departments'], queryFn: () => api.get('/departments?pageSize=100&sort=name&order=asc') });
  const b = useQuery({ queryKey: ['branches'], queryFn: () => api.get('/branches?pageSize=100&sort=name&order=asc') });
  const g = useQuery({ queryKey: ['designations'], queryFn: () => api.get('/designations?pageSize=100') });
  const opt = (q) => (q.data ?? []).map((x) => ({ value: x.id, label: x.name }));
  return { depts: opt(d), branches: opt(b), designations: opt(g) };
};

// =========================================================================== job openings
function JobDialog({ job, onClose, onDone }) {
  const org = useOrg();
  const [v, setV] = useState(() => ({
    title: job?.title ?? '', departmentId: job?.departmentId ?? '', branchId: job?.branchId ?? '', designationId: job?.designationId ?? '', employmentType: job?.employmentType ?? 'PERMANENT',
    location: job?.location ?? '', positions: job?.positions ?? 1, description: job?.description ?? '', requirements: job?.requirements ?? '', salaryMin: job?.salaryMin ?? '', salaryMax: job?.salaryMax ?? '',
    showSalary: job?.showSalary ?? false, published: job?.published ?? true, closesOn: job?.closesOn ?? '', hiringManagerId: job?.hiringManagerId ?? '',
  }));
  const save = useAction((b) => (job ? api.patch(`/recruitment/jobs/${job.id}`, b) : api.post('/recruitment/jobs', b)), { success: job ? 'Job saved' : 'Job created as a draft', invalidate: [['jobs'], ['job']], onDone });
  const fe = save.error?.fieldErrors ?? {};
  const set = (k) => (e) => setV((p) => ({ ...p, [k]: e.target.value }));
  const n = (x) => (x === '' ? null : Number(x));
  const submit = () => save.mutate({ ...v, departmentId: v.departmentId || null, branchId: v.branchId || null, designationId: v.designationId || null, hiringManagerId: v.hiringManagerId || null, closesOn: v.closesOn || null, positions: Number(v.positions) || 1, salaryMin: n(v.salaryMin), salaryMax: n(v.salaryMax), location: v.location || undefined, requirements: v.requirements || undefined });
  return (
    <Dialog open onClose={onClose} title={job ? `Edit ${job.title}` : 'New job opening'} description="Published openings appear on your careers page while they are open." size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={submit}>{job ? 'Save' : 'Create'}</Button></>}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="Job title" required error={fe.title} className="sm:col-span-2"><Input value={v.title} maxLength={120} placeholder="e.g. Sales Officer" onChange={set('title')} /></Field>
        <Field label="Department"><Select value={v.departmentId} onChange={set('departmentId')} placeholder="Choose" options={org.depts} /></Field>
        <Field label="Designation"><Select value={v.designationId} onChange={set('designationId')} placeholder="Choose" options={org.designations} /></Field>
        <Field label="Branch"><Select value={v.branchId} onChange={set('branchId')} placeholder="Choose" options={org.branches} /></Field>
        <Field label="Location" hint="Shown on the careers page"><Input value={v.location} maxLength={120} placeholder="e.g. Kathmandu" onChange={set('location')} /></Field>
        <Field label="Type"><Select value={v.employmentType} onChange={set('employmentType')} options={TYPES.map(([value, l]) => ({ value, label: l }))} /></Field>
        <Field label="Positions" error={fe.positions}><Input type="number" min="1" value={v.positions} onChange={set('positions')} /></Field>
        <Field label="About the role" required error={fe.description} className="sm:col-span-2"><Textarea rows={5} value={v.description} maxLength={8000} onChange={set('description')} placeholder="What the person will do, who they work with, what success looks like." /></Field>
        <Field label="Requirements" className="sm:col-span-2"><Textarea rows={3} value={v.requirements} maxLength={4000} onChange={set('requirements')} placeholder="Education, experience, licences, languages…" /></Field>
        <Field label="Salary from (NPR/month)" error={fe.salaryMin}><Input type="number" min="0" value={v.salaryMin} onChange={set('salaryMin')} /></Field>
        <Field label="Salary to (NPR/month)" error={fe.salaryMax}><Input type="number" min="0" value={v.salaryMax} onChange={set('salaryMax')} /></Field>
        <Field label="Applications close on"><Input type="date" min={todayKtm()} value={v.closesOn} onChange={set('closesOn')} /></Field>
        <Field label="Hiring manager" hint="Hears about new applicants"><PersonPicker value={v.hiringManagerId} onChange={(id) => setV({ ...v, hiringManagerId: id })} /></Field>
        <div className="flex flex-wrap gap-4 sm:col-span-2">
          <Checkbox label="Show on the careers page" checked={v.published} onChange={(e) => setV({ ...v, published: e.target.checked })} />
          <Checkbox label="Show the salary range" checked={v.showSalary} onChange={(e) => setV({ ...v, showSalary: e.target.checked })} />
        </div>
      </div>
    </Dialog>
  );
}

export function Jobs() {
  const a = useAuth();
  const nav = useNavigate();
  const [status, setStatus] = useState('OPEN');
  const { data = [], isPending } = useQuery({ queryKey: ['jobs', status], queryFn: () => api.get(`/recruitment/jobs${status ? `?status=${status}` : ''}`) });
  const { data: interviews = [] } = useQuery({ queryKey: ['my-interviews'], queryFn: () => api.get('/recruitment/interviews') });
  const [dlg, setDlg] = useState(false);
  const toast = useToast();
  const careers = `${window.location.origin}/careers`;
  return (
    <>
      <PageHeader title="Recruitment" description="Job openings, applicants and interviews."
        actions={<>
          <Button variant="secondary" onClick={() => { navigator.clipboard?.writeText(careers); toast.success('Careers page link copied', careers); }}><Copy className="size-4" />Careers page link</Button>
          {a.can('recruitment:create') && <Button onClick={() => setDlg(true)}><Plus className="size-4" />New opening</Button>}
        </>} />
      {interviews.length > 0 && (
        <Card className="mb-4"><CardHeader title="Your upcoming interviews" actions={<Link to="/interviews" className="text-sm font-medium text-brand-700 hover:underline">All</Link>} />
          <ul className="divide-y divide-line">{interviews.slice(0, 3).map((i) => <li key={i.id}><Link to={`/interviews/${i.id}`} className="flex flex-wrap justify-between gap-2 px-5 py-2.5 text-sm hover:bg-subtle"><span><span className="font-medium text-ink-900">{i.candidate.name}</span> · {i.candidate.job}</span><span className="text-ink-500">{dt(i.scheduledAt, true)}</span></Link></li>)}</ul>
        </Card>
      )}
      <Tabs value={status} onChange={setStatus} tabs={[['OPEN', 'Open'], ['DRAFT', 'Drafts'], ['ON_HOLD', 'On hold'], ['FILLED', 'Filled'], ['CLOSED', 'Closed'], ['', 'All']]} />
      {isPending ? <Skeleton className="h-48" /> : !data.length ? (
        <Card><EmptyState icon={<Briefcase className="size-5" />} title={status === 'OPEN' ? 'No open jobs' : 'Nothing here'} description={status === 'OPEN' ? 'Create an opening, then open it to start receiving applications on your careers page.' : undefined} action={status === 'OPEN' && a.can('recruitment:create') ? <Button onClick={() => setDlg(true)}>New opening</Button> : undefined} /></Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 [&>*]:min-w-0">
          {data.map((j) => (
            <Link key={j.id} to={`/recruitment/jobs/${j.id}`} className="block rounded-lg border border-line bg-surface p-4 shadow-card hover:border-brand-600">
              <div className="flex items-start justify-between gap-2"><p className="font-semibold text-ink-900">{j.title}</p><StatusBadge value={j.status} /></div>
              <p className="mt-0.5 text-sm text-ink-500">{[j.department, j.location ?? j.branch].filter(Boolean).join(' · ') || j.key}</p>
              <div className="mt-3 grid grid-cols-5 gap-1 text-center">
                {STAGES.map((s) => <div key={s} className="rounded bg-subtle px-1 py-1.5"><p className="text-base font-semibold tabular-nums text-ink-900">{j.pipeline[s]}</p><p className="truncate text-[10px] text-ink-500">{STAGE_LABEL[s]}</p></div>)}
              </div>
              <p className="mt-2 text-xs text-ink-400">{j.positions} position{j.positions === 1 ? '' : 's'}{j.closesOn ? ` · closes ${dt(j.closesOn)}` : ''}{!j.published ? ' · not on careers page' : ''}</p>
            </Link>
          ))}
        </div>
      )}
      {dlg && <JobDialog onClose={() => setDlg(false)} onDone={(j) => { setDlg(false); nav(`/recruitment/jobs/${j.id}`); }} />}
    </>
  );
}

export function JobDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { data: j, isPending, error } = useQuery({ queryKey: ['job', id], queryFn: () => api.get(`/recruitment/jobs/${id}`) });
  const [dlg, setDlg] = useState(null);
  const [showClosed, setShowClosed] = useState(false);
  const status = useAction((s) => api.post(`/recruitment/jobs/${id}/status`, { status: s }), { success: (r) => `Job ${STAGE_LABEL[r.status]?.toLowerCase() ?? r.status.replace('_', ' ').toLowerCase()}`, invalidate: [['job', id], ['jobs']] });
  if (isPending) return <Skeleton className="h-96" />;
  if (error) return <EmptyState title="Job not found" description={error.message} />;
  const ab = j.abilities;
  const active = j.candidates.filter((c) => STAGES.includes(c.stage));
  const closed = j.candidates.filter((c) => !STAGES.includes(c.stage));
  return (
    <>
      <BackLink to="/recruitment">Recruitment</BackLink>
      <PageHeader title={j.title} description={`${j.key} · ${[j.department, j.designation, j.location ?? j.branch].filter(Boolean).join(' · ')}`}
        actions={<>
          {ab.edit && <Button variant="secondary" onClick={() => setDlg('edit')}>Edit</Button>}
          {ab.edit && ['DRAFT', 'ON_HOLD', 'CLOSED'].includes(j.status) && <Button variant="secondary" onClick={() => status.mutate('OPEN')}>Open for applications</Button>}
          {ab.edit && j.status === 'OPEN' && <Button variant="secondary" onClick={() => status.mutate('ON_HOLD')}>Put on hold</Button>}
          {ab.edit && ['OPEN', 'ON_HOLD'].includes(j.status) && <Button variant="ghost" onClick={() => status.mutate('CLOSED')}>Close</Button>}
          {ab.edit && <Button onClick={() => setDlg('add')}><UserPlus className="size-4" />Add candidate</Button>}
        </>} />
      {j.status === 'OPEN' && j.published && (
        <Card className="mb-4"><CardBody className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="min-w-0 truncate text-ink-700">Public page: <span className="text-brand-700">{j.careersUrl}</span></span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => { navigator.clipboard?.writeText(j.careersUrl); toast.success('Link copied'); }}><Copy className="size-4" />Copy</Button>
            <a href={`/careers/${j.slug}`} target="_blank" rel="noreferrer"><Button size="sm" variant="ghost"><ExternalLink className="size-4" />Open</Button></a>
          </div>
        </CardBody></Card>
      )}
      {/* Pipeline: columns on wide screens, grouped list on phones. */}
      <div className="hidden gap-3 lg:grid lg:grid-cols-5">
        {STAGES.map((s) => {
          const list = active.filter((c) => c.stage === s);
          return (
            <div key={s} className="min-w-0 rounded-lg bg-subtle p-2">
              <p className="mb-2 flex items-center justify-between px-1 text-xs font-semibold text-ink-700">{STAGE_LABEL[s]}<span className="rounded-full bg-white px-1.5 text-ink-500">{list.length}</span></p>
              <div className="space-y-2">{list.map((c) => <CandidateCard key={c.id} c={c} onClick={() => nav(`/recruitment/candidates/${c.id}`)} />)}</div>
              {!list.length && <p className="px-1 pb-2 text-xs text-ink-400">No one</p>}
            </div>
          );
        })}
      </div>
      <div className="space-y-3 lg:hidden">
        {STAGES.map((s) => {
          const list = active.filter((c) => c.stage === s);
          if (!list.length) return null;
          return <div key={s}><p className="mb-1.5 text-xs font-semibold text-ink-500">{STAGE_LABEL[s]} · {list.length}</p><div className="space-y-2">{list.map((c) => <CandidateCard key={c.id} c={c} onClick={() => nav(`/recruitment/candidates/${c.id}`)} />)}</div></div>;
        })}
        {!active.length && <Card><EmptyState icon={<Users className="size-5" />} title="No applicants yet" description="Applications from the careers page appear here." /></Card>}
      </div>
      {closed.length > 0 && (
        <div className="mt-4">
          <Button variant="ghost" size="sm" onClick={() => setShowClosed((x) => !x)}>{showClosed ? 'Hide' : 'Show'} {closed.length} rejected or withdrawn</Button>
          {showClosed && <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4 [&>*]:min-w-0">{closed.map((c) => <CandidateCard key={c.id} c={c} onClick={() => nav(`/recruitment/candidates/${c.id}`)} />)}</div>}
        </div>
      )}
      <Card className="mt-4"><CardHeader title="Job description" description={[TYPES.find(([k]) => k === j.employmentType)?.[1], `${j.positions} position${j.positions === 1 ? '' : 's'}`, salary(j)].filter(Boolean).join(' · ')} />
        <CardBody className="space-y-3 text-sm text-ink-700"><p className="whitespace-pre-wrap">{j.description}</p>{j.requirements && <><p className="font-medium text-ink-900">Requirements</p><p className="whitespace-pre-wrap">{j.requirements}</p></>}</CardBody>
      </Card>
      {dlg === 'edit' && <JobDialog job={j} onClose={() => setDlg(null)} onDone={() => setDlg(null)} />}
      {dlg === 'add' && <AddCandidateDialog jobId={j.id} onClose={() => setDlg(null)} onDone={(c) => { setDlg(null); nav(`/recruitment/candidates/${c.id}`); }} />}
    </>
  );
}

const CandidateCard = ({ c, onClick }) => (
  <button type="button" onClick={onClick} className="w-full rounded-md border border-line bg-white p-2.5 text-left shadow-card hover:border-brand-600">
    <p className="truncate text-sm font-medium text-ink-900">{c.name}</p>
    <p className="truncate text-xs text-ink-500">{c.currentTitle ?? c.email}</p>
    <div className="mt-1 flex items-center justify-between gap-2">{c.rating ? <Stars value={c.rating} /> : <span className="text-[11px] text-ink-400">{dt(c.createdAt)}</span>}{!STAGES.includes(c.stage) && <StageBadge s={c.stage} />}</div>
  </button>
);

function AddCandidateDialog({ jobId, onClose, onDone }) {
  const fileRef = useRef(null);
  const [v, setV] = useState({ firstName: '', lastName: '', email: '', phone: '', currentTitle: '', experienceYears: '', expectedSalary: '', source: 'REFERRAL', coverNote: '' });
  const [file, setFile] = useState(null);
  const save = useAction(() => {
    const fd = new FormData();
    fd.append('jobId', jobId);
    Object.entries(v).forEach(([k, x]) => { if (x !== '') fd.append(k, x); });
    if (file) fd.append('cv', file);
    return api.post('/recruitment/candidates', fd);
  }, { success: 'Candidate added', invalidate: [['job', jobId]], onDone });
  const fe = save.error?.fieldErrors ?? {};
  const set = (k) => (e) => setV((p) => ({ ...p, [k]: e.target.value }));
  return (
    <Dialog open onClose={onClose} title="Add a candidate" description="For CVs that came by email, referral or walk-in." size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate()}>Add</Button></>}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="First name" required error={fe.firstName}><Input value={v.firstName} onChange={set('firstName')} /></Field>
        <Field label="Last name" required error={fe.lastName}><Input value={v.lastName} onChange={set('lastName')} /></Field>
        <Field label="Email" required error={fe.email}><Input type="email" value={v.email} onChange={set('email')} /></Field>
        <Field label="Phone" error={fe.phone}><Input value={v.phone} onChange={set('phone')} /></Field>
        <Field label="Current job title"><Input value={v.currentTitle} onChange={set('currentTitle')} /></Field>
        <Field label="Source"><Select value={v.source} onChange={set('source')} options={SOURCES.map(([value, l]) => ({ value, label: l }))} /></Field>
        <Field label="Experience (years)"><Input type="number" min="0" step="0.5" value={v.experienceYears} onChange={set('experienceYears')} /></Field>
        <Field label="Expected salary (NPR/month)"><Input type="number" min="0" value={v.expectedSalary} onChange={set('expectedSalary')} /></Field>
        <Field label="Notes" className="sm:col-span-2"><Textarea rows={2} value={v.coverNote} onChange={set('coverNote')} /></Field>
        <div className="sm:col-span-2">
          <input ref={fileRef} type="file" accept="application/pdf,image/jpeg,image/png" className="sr-only" aria-label="CV file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <Button variant="secondary" onClick={() => fileRef.current?.click()}><Upload className="size-4" />{file ? file.name : 'Attach CV (PDF)'}</Button>
          {fe.cv && <p className="mt-1 text-xs text-danger-600">{fe.cv}</p>}
        </div>
      </div>
    </Dialog>
  );
}

// =========================================================================== candidate
export function CandidateDetail() {
  const { id } = useParams();
  const key = ['candidate', id];
  const { data: c, isPending, error } = useQuery({ queryKey: key, queryFn: () => api.get(`/recruitment/candidates/${id}`) });
  const [dlg, setDlg] = useState(null);
  const [note, setNote] = useState('');
  const download = useDownload();
  const inv = [key, ['job'], ['jobs']];
  const move = useAction((b) => api.post(`/recruitment/candidates/${id}/stage`, b), { success: (r) => `Moved to ${STAGE_LABEL[r.stage].toLowerCase()}`, invalidate: inv, onDone: () => setDlg(null) });
  const addNote = useAction(() => api.post(`/recruitment/candidates/${id}/notes`, { note }), { success: 'Note added', invalidate: [key], onDone: () => setNote('') });
  const rate = useAction((rating) => api.patch(`/recruitment/candidates/${id}`, { rating }), { invalidate: [key] });
  const respond = useAction((b) => api.post(`/recruitment/candidates/${id}/offer/response`, b), { success: 'Recorded', invalidate: inv });
  if (isPending) return <Skeleton className="h-96" />;
  if (error) return <EmptyState title="Candidate not found" description={error.message} />;
  const ab = c.abilities;
  const next = { APPLIED: 'SCREENING', SCREENING: 'INTERVIEW' }[c.stage];
  return (
    <>
      <BackLink to={`/recruitment/jobs/${c.jobId}`}>{c.job.title}</BackLink>
      <PageHeader title={c.name} description={`${c.key} · ${[c.currentTitle, c.experienceYears != null && `${c.experienceYears} yrs experience`].filter(Boolean).join(' · ') || c.email}`}
        actions={<>
          {c.hasCv && <Button variant="secondary" onClick={() => download(`/recruitment/candidates/${id}/cv`, `cv-${c.key}.pdf`)}><Download className="size-4" />CV</Button>}
          {ab.move && <Button variant="ghost" onClick={() => setDlg('reject')}><XCircle className="size-4" />Reject</Button>}
          {ab.interview && <Button variant="secondary" onClick={() => setDlg('interview')}><Calendar className="size-4" />Schedule interview</Button>}
          {ab.move && next && <Button variant="secondary" onClick={() => move.mutate({ stage: next })}>Move to {STAGE_LABEL[next].toLowerCase()}</Button>}
          {ab.offer && <Button variant={c.stage === 'OFFER' ? 'secondary' : 'primary'} onClick={() => setDlg('offer')}><Send className="size-4" />{c.offer ? 'Change offer' : 'Make an offer'}</Button>}
          {ab.hire && <Button onClick={() => setDlg('hire')}><UserCheck className="size-4" />Hire</Button>}
        </>} />
      <div className="mb-4 flex flex-wrap items-center gap-1">
        {STAGES.map((s, i) => <span key={s} className={cn('rounded-full px-2.5 py-1 text-xs font-medium', c.stage === s ? 'bg-brand-600 text-white' : STAGES.indexOf(c.stage) > i ? 'bg-brand-50 text-brand-700' : 'bg-subtle text-ink-500')}>{STAGE_LABEL[s]}</span>)}
        {!STAGES.includes(c.stage) && <StageBadge s={c.stage} />}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.5fr_1fr] [&>*]:min-w-0">
        <div className="space-y-4">
          {c.offer && (
            <Card><CardHeader title="Offer" description={`${c.offer.reference} · ${c.offer.status === 'SENT' ? `valid until ${dt(c.offer.expiresOn)}` : label(c.offer.status)}`}
              actions={<Button size="sm" variant="secondary" onClick={() => download(`/recruitment/candidates/${id}/offer.pdf`, `offer-letter-${c.key}.pdf`)}><FileText className="size-4" />Offer letter</Button>} />
              <CardBody className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-ink-500">Position</span><span className="font-medium">{c.offer.designation}</span></div>
                <div className="flex justify-between"><span className="text-ink-500">Monthly salary</span><span className="font-medium tabular-nums">{npr(c.offer.salary)}</span></div>
                <div className="flex justify-between"><span className="text-ink-500">Joining date</span><span className="font-medium">{dt(c.offer.joiningDate)}</span></div>
                {c.stage === 'OFFER' && c.offer.status === 'SENT' && ab.offer && <div className="flex gap-2 pt-2"><Button size="sm" variant="secondary" onClick={() => respond.mutate({ accepted: true })}><CheckCircle2 className="size-4" />Accepted</Button><Button size="sm" variant="ghost" onClick={() => respond.mutate({ accepted: false })}>Declined</Button></div>}
              </CardBody>
            </Card>
          )}
          <Card>
            <CardHeader title="Interviews" />
            {!c.interviews.length ? <CardBody className="text-sm text-ink-500">No interviews yet.</CardBody> : (
              <ul className="divide-y divide-line">
                {c.interviews.map((i) => (
                  <li key={i.id} className="px-5 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2"><Link to={`/interviews/${i.id}`} className="text-sm font-medium text-ink-900 hover:underline">{i.round}</Link><StatusBadge value={i.status} /></div>
                    <p className="text-xs text-ink-500">{dt(i.scheduledAt, true)} · {label(i.mode)}{i.location ? ` · ${i.location}` : ''} · {i.interviewers.map((x) => x.name).join(', ')}</p>
                    {i.feedback.map((f) => (
                      <div key={f.authorId} className="mt-2 rounded-md bg-subtle p-2.5 text-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium text-ink-900">{f.by}</span><span className="flex items-center gap-2"><Stars value={f.rating} /><Badge tone={f.recommendation.includes('YES') ? 'success' : 'danger'}>{REC[f.recommendation]}</Badge></span></div>
                        {f.notes && <p className="mt-1 text-ink-700">{f.notes}</p>}
                      </div>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Activity" />
            <CardBody>
              <div className="mb-4 flex gap-2"><Input value={note} placeholder="Add a note for the hiring team" onChange={(e) => setNote(e.target.value)} /><Button variant="secondary" disabled={!note.trim()} loading={addNote.isPending} onClick={() => addNote.mutate()}>Add</Button></div>
              <ol className="space-y-3">
                {c.timeline.map((e) => (
                  <li key={e.id} className="text-sm">
                    <p className="text-ink-900">{eventText(e)}</p>
                    <p className="text-xs text-ink-500">{dt(e.at, true)}{e.by ? ` · ${e.by}` : ''}</p>
                  </li>
                ))}
              </ol>
            </CardBody>
          </Card>
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Candidate" />
            <CardBody className="space-y-2 text-sm">
              <p><a href={`mailto:${c.email}`} className="text-brand-700 hover:underline">{c.email}</a></p>
              {c.phone && <p><a href={`tel:${c.phone}`} className="text-brand-700 hover:underline">{c.phone}</a></p>}
              <div className="flex justify-between"><span className="text-ink-500">Source</span><span>{label(c.source)}</span></div>
              {c.expectedSalary != null && <div className="flex justify-between"><span className="text-ink-500">Expects</span><span className="tabular-nums">{npr(c.expectedSalary)}</span></div>}
              {c.noticeDays != null && <div className="flex justify-between"><span className="text-ink-500">Notice period</span><span>{c.noticeDays} days</span></div>}
              <div className="flex justify-between"><span className="text-ink-500">Applied</span><span>{dt(c.createdAt)}</span></div>
              <div className="pt-2"><p className="mb-1 text-xs text-ink-500">Your rating</p><Rating value={c.rating} onChange={(n) => rate.mutate(n)} labels={{ 1: 'Poor fit', 2: 'Weak', 3: 'Possible', 4: 'Good', 5: 'Excellent' }} readOnly={!ab.move} size="sm" /></div>
            </CardBody>
          </Card>
          {c.coverNote && <Card><CardHeader title="Cover note" /><CardBody className="whitespace-pre-wrap text-sm text-ink-700">{c.coverNote}</CardBody></Card>}
          {c.rejectReason && <Card><CardHeader title={c.stage === 'WITHDRAWN' ? 'Withdrawn' : 'Rejected'} /><CardBody className="text-sm text-ink-700">{c.rejectReason}</CardBody></Card>}
          {c.otherApplications.length > 0 && <Card><CardHeader title="Other applications" /><ul className="divide-y divide-line">{c.otherApplications.map((o) => <li key={o.id}><Link to={`/recruitment/candidates/${o.id}`} className="flex justify-between gap-2 px-5 py-2.5 text-sm hover:bg-subtle"><span className="truncate">{o.job}</span><StageBadge s={o.stage} /></Link></li>)}</ul></Card>}
        </div>
      </div>
      {dlg === 'reject' && <RejectDialog action={move} onClose={() => setDlg(null)} />}
      {dlg === 'interview' && <InterviewDialog id={id} onClose={() => setDlg(null)} />}
      {dlg === 'offer' && <OfferDialog c={c} onClose={() => setDlg(null)} />}
      {dlg === 'hire' && <HireDialog c={c} onClose={() => setDlg(null)} />}
    </>
  );
}

function eventText(e) {
  const d = e.data ?? {};
  switch (e.type) {
    case 'APPLIED': return `Applied${d.source === 'CAREERS' ? ' on the careers page' : ` (${label(d.source)})`}`;
    case 'STAGE': return `Moved from ${STAGE_LABEL[d.from]?.toLowerCase()} to ${STAGE_LABEL[d.to]?.toLowerCase()}${d.reason ? `: ${d.reason}` : ''}`;
    case 'NOTE': return d.note;
    case 'INTERVIEW': return d.status ? `${d.round} ${d.status === 'CANCELLED' ? 'cancelled' : 'marked done'}` : `Interview scheduled: ${d.round}, ${dt(d.scheduledAt, true)}`;
    case 'FEEDBACK': return `Scorecard for ${d.round}: ${d.rating}/5, ${REC[d.recommendation]?.toLowerCase()}`;
    case 'OFFER': return d.status ? `Offer ${d.status.toLowerCase()}` : `Offer made: ${npr(d.salary)} a month, joining ${dt(d.joiningDate)}`;
    case 'HIRED': return `Hired as employee ${d.employeeCode}, joining ${dt(d.joinedOn)}`;
    case 'EMAIL': return 'Outcome email sent to the candidate';
    default: return e.type;
  }
}

function RejectDialog({ action, onClose }) {
  const [v, setV] = useState({ reason: '', notifyCandidate: true });
  return (
    <Dialog open onClose={onClose} title="Reject this candidate?"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" loading={action.isPending} onClick={() => action.mutate({ stage: 'REJECTED', reason: v.reason, notifyCandidate: v.notifyCandidate })}>Reject</Button></>}>
      <div className="space-y-4">
        <Field label="Reason (for your records)" required error={action.error?.fieldErrors?.reason}><Textarea rows={2} value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>
        <Checkbox label="Send a polite email to the candidate (the reason is not included)" checked={v.notifyCandidate} onChange={(e) => setV({ ...v, notifyCandidate: e.target.checked })} />
      </div>
    </Dialog>
  );
}

function InterviewDialog({ id, onClose }) {
  const [v, setV] = useState({ round: 'First interview', date: addDays(todayKtm(), 2), time: '11:00', durationMinutes: 45, mode: 'IN_PERSON', location: '', people: [], notifyCandidate: true });
  const save = useAction((b) => api.post(`/recruitment/candidates/${id}/interviews`, b), { success: 'Interview scheduled', invalidate: [['candidate', id], ['my-interviews']], onDone: onClose });
  const fe = save.error?.fieldErrors ?? {};
  const submit = () => save.mutate({ round: v.round, scheduledAt: new Date(`${v.date}T${v.time}:00+05:45`).toISOString(), durationMinutes: Number(v.durationMinutes), mode: v.mode, location: v.location || undefined, interviewerIds: v.people.map((p) => p.userId), notifyCandidate: v.notifyCandidate });
  return (
    <Dialog open onClose={onClose} title="Schedule an interview" size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!v.people.length} onClick={submit}>Schedule</Button></>}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="Round" required error={fe.round}><Input value={v.round} onChange={(e) => setV({ ...v, round: e.target.value })} /></Field>
        <Field label="How"><Select value={v.mode} onChange={(e) => setV({ ...v, mode: e.target.value })} options={[{ value: 'IN_PERSON', label: 'In person' }, { value: 'PHONE', label: 'Phone' }, { value: 'VIDEO', label: 'Video call' }]} /></Field>
        <Field label="Date"><Input type="date" min={todayKtm()} value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="Time"><Input type="time" value={v.time} onChange={(e) => setV({ ...v, time: e.target.value })} /></Field><Field label="Minutes"><Input type="number" min="10" value={v.durationMinutes} onChange={(e) => setV({ ...v, durationMinutes: e.target.value })} /></Field></div>
        <Field label={v.mode === 'VIDEO' ? 'Meeting link' : 'Place'} className="sm:col-span-2"><Input value={v.location} onChange={(e) => setV({ ...v, location: e.target.value })} placeholder={v.mode === 'VIDEO' ? 'https://meet…' : 'e.g. Head office, 2nd floor'} /></Field>
        <Field label="Interviewers" required error={fe.interviewerIds} hint="People with a login. They get the CV and a scorecard." className="sm:col-span-2"><PeoplePicker withLogin value={v.people} onChange={(people) => setV({ ...v, people })} max={10} /></Field>
        <div className="sm:col-span-2"><Checkbox label="Email the invitation to the candidate" checked={v.notifyCandidate} onChange={(e) => setV({ ...v, notifyCandidate: e.target.checked })} /></div>
      </div>
    </Dialog>
  );
}

function OfferDialog({ c, onClose }) {
  const org = useOrg();
  const o = c.offer;
  const [v, setV] = useState({ salary: o?.salary ?? c.expectedSalary ?? '', joiningDate: o?.joiningDate ?? addDays(todayKtm(), 15), designationId: o?.designationId ?? '', employmentType: o?.employmentType ?? 'PERMANENT', probationMonths: o?.probationMonths ?? 3, expiresOn: o?.expiresOn ?? addDays(todayKtm(), 7), terms: o?.terms ?? '' });
  const save = useAction((b) => api.post(`/recruitment/candidates/${c.id}/offer`, b), { success: 'Offer recorded. Download the letter to send it.', invalidate: [['candidate', c.id], ['job']], onDone: onClose });
  const fe = save.error?.fieldErrors ?? {};
  return (
    <Dialog open onClose={onClose} title={`Offer for ${c.name}`} description="The offer letter is printed on your letterhead (Letter requests → Letterhead)." size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate({ ...v, salary: Number(v.salary), probationMonths: Number(v.probationMonths), designationId: v.designationId || null, terms: v.terms || undefined })}>Save offer</Button></>}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="Gross monthly salary (NPR)" required error={fe.salary}><Input type="number" min="0" value={v.salary} onChange={(e) => setV({ ...v, salary: e.target.value })} /></Field>
        <Field label="Joining date" required error={fe.joiningDate}><Input type="date" min={todayKtm()} value={v.joiningDate} onChange={(e) => setV({ ...v, joiningDate: e.target.value })} /></Field>
        <Field label="Designation" hint="Leave empty to use the job's"><Select value={v.designationId} onChange={(e) => setV({ ...v, designationId: e.target.value })} placeholder="As in the job" options={org.designations} /></Field>
        <Field label="Type"><Select value={v.employmentType} onChange={(e) => setV({ ...v, employmentType: e.target.value })} options={TYPES.map(([value, l]) => ({ value, label: l }))} /></Field>
        <Field label="Probation (months)"><Input type="number" min="0" max="12" value={v.probationMonths} onChange={(e) => setV({ ...v, probationMonths: e.target.value })} /></Field>
        <Field label="Offer valid until" required error={fe.expiresOn}><Input type="date" min={todayKtm()} value={v.expiresOn} onChange={(e) => setV({ ...v, expiresOn: e.target.value })} /></Field>
        <Field label="Other terms (printed on the letter)" className="sm:col-span-2"><Textarea rows={3} value={v.terms} maxLength={2000} onChange={(e) => setV({ ...v, terms: e.target.value })} placeholder="e.g. Transport allowance of NPR 3,000 a month. Working hours 10:00–17:00, Sunday to Friday." /></Field>
      </div>
    </Dialog>
  );
}

function HireDialog({ c, onClose }) {
  const nav = useNavigate();
  const org = useOrg();
  const [v, setV] = useState({ joinedOn: c.offer?.joiningDate ?? todayKtm(), branchId: '', departmentId: '', managerId: '', startOnboarding: true });
  const hire = useAction((b) => api.post(`/recruitment/candidates/${c.id}/hire`, b), {
    success: (r) => `Hired. Employee ${r.employeeCode} created${r.journeyId ? ' with a joining checklist' : ''}.`, invalidate: [['candidate', c.id], ['job'], ['jobs']],
    onDone: (r) => { onClose(); nav(r.journeyId ? `/onboarding/${r.journeyId}` : `/employees/${r.employeeId}`); },
  });
  const fe = hire.error?.fieldErrors ?? {};
  return (
    <Dialog open onClose={onClose} title={`Hire ${c.name}`} description="Creates the employee record from the application, so nothing is typed twice. Add salary and documents on their profile afterwards." size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={hire.isPending} disabled={!v.branchId} onClick={() => hire.mutate({ joinedOn: v.joinedOn, branchId: v.branchId, departmentId: v.departmentId || undefined, managerId: v.managerId || undefined, startOnboarding: v.startOnboarding })}>Hire</Button></>}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="Joining date" required error={fe.joinedOn}><Input type="date" value={v.joinedOn} onChange={(e) => setV({ ...v, joinedOn: e.target.value })} /></Field>
        <Field label="Branch" required error={fe.branchId}><Select value={v.branchId} onChange={(e) => setV({ ...v, branchId: e.target.value })} placeholder="Choose" options={org.branches} /></Field>
        <Field label="Department" hint="Leave empty to use the job's"><Select value={v.departmentId} onChange={(e) => setV({ ...v, departmentId: e.target.value })} placeholder="As in the job" options={org.depts} /></Field>
        <Field label="Reports to" hint="Leave empty for the hiring manager"><PersonPicker value={v.managerId} onChange={(managerId) => setV({ ...v, managerId })} /></Field>
        {c.abilities.startOnboarding && <div className="sm:col-span-2"><Checkbox label="Start the joining checklist" checked={v.startOnboarding} onChange={(e) => setV({ ...v, startOnboarding: e.target.checked })} /></div>}
      </div>
      <div className="mt-3"><ErrorNote error={hire.error && !Object.keys(fe).length ? hire.error : null} /></div>
    </Dialog>
  );
}

// =========================================================================== interviews (interviewers)
export function Interviews() {
  const nav = useNavigate();
  const [scope, setScope] = useState('upcoming');
  const { data = [], isPending } = useQuery({ queryKey: ['my-interviews', scope], queryFn: () => api.get(`/recruitment/interviews?upcoming=${scope === 'upcoming'}`) });
  return (
    <>
      <PageHeader title="My interviews" description="Interviews you are part of. Read the CV beforehand and fill in the scorecard after." />
      <Tabs value={scope} onChange={setScope} tabs={[['upcoming', 'Upcoming'], ['past', 'All']]} />
      <DataTable loading={isPending} rows={data} onRowClick={(r) => nav(`/interviews/${r.id}`)}
        empty={<EmptyState icon={<Calendar className="size-5" />} title="No interviews" description="When HR adds you to an interview it appears here." />}
        mobile={(r) => <Link to={`/interviews/${r.id}`} className="block"><p className="font-medium text-ink-900">{r.candidate.name}</p><p className="text-xs text-ink-500">{r.candidate.job} · {r.round}</p><p className="text-xs text-ink-500">{dt(r.scheduledAt, true)} · {r.myFeedback ? 'Scorecard sent' : 'Scorecard due'}</p></Link>}
        columns={[
          { key: 'when', header: 'When', render: (r) => dt(r.scheduledAt, true) },
          { key: 'candidate', header: 'Candidate', render: (r) => <Link to={`/interviews/${r.id}`} className="font-medium text-ink-900 hover:underline">{r.candidate.name}</Link> },
          { key: 'job', header: 'Job', render: (r) => <><p>{r.candidate.job}</p><p className="text-xs text-ink-400">{r.round}</p></> },
          { key: 'card', header: 'Scorecard', render: (r) => (r.myFeedback ? <Badge tone="success">Sent</Badge> : <Badge tone="warning">Due</Badge>) },
        ]} />
    </>
  );
}

export function InterviewDetail() {
  const { id } = useParams();
  const { data: i, isPending, error } = useQuery({ queryKey: ['interview', id], queryFn: () => api.get(`/recruitment/interviews/${id}`) });
  const download = useDownload();
  if (isPending) return <Skeleton className="h-96" />;
  if (error) return <EmptyState title="Interview not found" description={error.message} />;
  const c = i.candidate;
  return (
    <>
      <BackLink to="/interviews">My interviews</BackLink>
      <PageHeader title={`${c.name}: ${i.round}`} description={`${c.job?.title ?? ''} · ${dt(i.scheduledAt, true)} · ${label(i.mode)}${i.location ? ` · ${i.location}` : ''}`}
        actions={c.hasCv && <Button variant="secondary" onClick={() => download(`/recruitment/interviews/${id}/cv`, `cv-${c.key}.pdf`)}><Download className="size-4" />CV</Button>} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.2fr] [&>*]:min-w-0">
        <div className="space-y-4">
          <Card><CardHeader title="Candidate" /><CardBody className="space-y-2 text-sm">
            {c.currentTitle && <p className="font-medium text-ink-900">{c.currentTitle}</p>}
            {c.experienceYears != null && <p className="text-ink-700">{c.experienceYears} years of experience</p>}
            {c.coverNote && <p className="whitespace-pre-wrap rounded-md bg-subtle p-3 text-ink-700">{c.coverNote}</p>}
            <p className="text-xs text-ink-500">Interviewers: {i.interviewers.map((x) => x.name).join(', ')}</p>
          </CardBody></Card>
          {i.feedback.filter((f) => !i.canGiveFeedback || f.by).length > 0 && (
            <Card><CardHeader title="Scorecards" /><ul className="divide-y divide-line">{i.feedback.map((f) => <li key={f.authorId} className="px-5 py-3 text-sm"><div className="flex justify-between gap-2"><span className="font-medium">{f.by}</span><span className="flex items-center gap-2"><Stars value={f.rating} />{REC[f.recommendation]}</span></div>{f.notes && <p className="mt-1 text-ink-700">{f.notes}</p>}</li>)}</ul></Card>
          )}
        </div>
        {i.canGiveFeedback && <Scorecard i={i} />}
      </div>
    </>
  );
}

function Scorecard({ i }) {
  const mine = i.mine;
  const [v, setV] = useState({ rating: mine?.rating ?? null, recommendation: mine?.recommendation ?? '', scores: mine?.scores ?? {}, notes: mine?.notes ?? '' });
  const save = useAction((b) => api.put(`/recruitment/interviews/${i.id}/feedback`, b), { success: 'Scorecard saved', invalidate: [['interview', i.id], ['my-interviews']] });
  return (
    <Card>
      <CardHeader title="Your scorecard" description="Score on your own before reading others' scorecards." />
      <CardBody className="space-y-4">
        {SCORE_AREAS.map(([k, l]) => <div key={k} className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm text-ink-700">{l}</span><Rating size="sm" name={l} labels={{ 1: 'Poor', 2: 'Below', 3: 'Good', 4: 'Strong', 5: 'Excellent' }} value={v.scores[k]} onChange={(n) => setV({ ...v, scores: { ...v.scores, [k]: n } })} /></div>)}
        <div className="border-t border-line pt-4"><p className="mb-1.5 text-sm font-medium text-ink-900">Overall</p><Rating name="Overall" labels={{ 1: 'Poor', 2: 'Below the bar', 3: 'Meets the bar', 4: 'Strong', 5: 'Exceptional' }} value={v.rating} onChange={(rating) => setV({ ...v, rating })} /></div>
        <div><p className="mb-1.5 text-sm font-medium text-ink-900">Should we hire?</p><div className="flex flex-wrap gap-2">{Object.entries(REC).map(([k, l]) => <Button key={k} size="sm" variant={v.recommendation === k ? 'primary' : 'secondary'} onClick={() => setV({ ...v, recommendation: k })}>{l}</Button>)}</div></div>
        <Field label="Notes"><Textarea rows={4} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} placeholder="Evidence for your scores: examples, answers, concerns." /></Field>
        <ErrorNote error={save.error} />
        <Button loading={save.isPending} disabled={!v.rating || !v.recommendation} onClick={() => save.mutate({ ...v, notes: v.notes || undefined })}>Save scorecard</Button>
      </CardBody>
    </Card>
  );
}

// =========================================================================== public careers pages
export function Careers() {
  const { data, isPending, error } = useQuery({ queryKey: ['careers'], queryFn: () => api.get('/careers', { auth: false }), retry: false });
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      {isPending ? <Skeleton className="h-64" /> : error ? <Card><EmptyState title="No careers page here" description="This company does not list jobs online." /></Card> : (
        <>
          <p className="text-sm font-medium text-brand-700">Careers</p>
          <h1 className="mt-1 text-2xl font-semibold text-ink-900">Work at {data.company}</h1>
          <p className="mt-2 text-ink-500">{data.jobs.length ? `${data.jobs.length} open position${data.jobs.length === 1 ? '' : 's'}` : 'There are no open positions right now. Please check back later.'}</p>
          <div className="mt-6 space-y-3">
            {data.jobs.map((j) => (
              <Link key={j.slug} to={`/careers/${j.slug}`} className="block rounded-lg border border-line bg-surface p-4 shadow-card hover:border-brand-600">
                <p className="font-semibold text-ink-900">{j.title}</p>
                <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-ink-500">
                  {(j.location || j.branch) && <span className="inline-flex items-center gap-1"><MapPin className="size-3.5" />{j.location ?? j.branch}</span>}
                  {j.department && <span>{j.department}</span>}<span>{TYPES.find(([k]) => k === j.employmentType)?.[1]}</span>
                  {j.closesOn && <span>Apply by {dt(j.closesOn)}</span>}
                </p>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function CareerJob() {
  const { slug } = useParams();
  const { data, isPending, error } = useQuery({ queryKey: ['career', slug], queryFn: () => api.get(`/careers/${slug}`, { auth: false }), retry: false });
  const [sent, setSent] = useState(false);
  if (isPending) return <div className="mx-auto max-w-3xl px-4 py-10"><Skeleton className="h-96" /></div>;
  if (error) return <div className="mx-auto max-w-3xl px-4 py-10"><Card><EmptyState title="This job is no longer open" description="It may have been filled or closed." action={<Link to="/careers"><Button variant="secondary">See open jobs</Button></Link>} /></Card></div>;
  const j = data.job;
  const range = j.salary ? [j.salary.min, j.salary.max].filter((x) => x != null).map((x) => npr(x)).join(' – ') : null;
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <Link to="/careers" className="text-sm text-ink-500 hover:text-ink-900">← All jobs at {data.company}</Link>
      <h1 className="mt-3 text-2xl font-semibold text-ink-900">{j.title}</h1>
      <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-ink-500">
        {(j.location || j.branch) && <span className="inline-flex items-center gap-1"><MapPin className="size-3.5" />{j.location ?? j.branch}</span>}
        {j.department && <span>{j.department}</span>}<span>{TYPES.find(([k]) => k === j.employmentType)?.[1]}</span>
        {range && <span>{range} a month</span>}{j.closesOn && <span>Apply by {dt(j.closesOn)}</span>}
      </p>
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[1.3fr_1fr] [&>*]:min-w-0">
        <div className="space-y-4 text-sm leading-relaxed text-ink-700">
          <p className="whitespace-pre-wrap">{j.description}</p>
          {j.requirements && <><h2 className="text-base font-semibold text-ink-900">What we are looking for</h2><p className="whitespace-pre-wrap">{j.requirements}</p></>}
        </div>
        <div>{sent ? <Card><CardBody className="text-center"><CheckCircle2 className="mx-auto size-8 text-success-600" /><p className="mt-2 font-semibold text-ink-900">Application sent</p><p className="mt-1 text-sm text-ink-500">Thank you. We have emailed you a confirmation and will contact you if your profile matches.</p></CardBody></Card> : <ApplyForm slug={slug} onSent={() => setSent(true)} />}</div>
      </div>
    </div>
  );
}

function ApplyForm({ slug, onSent }) {
  const fileRef = useRef(null);
  const [v, setV] = useState({ firstName: '', lastName: '', email: '', phone: '', currentTitle: '', experienceYears: '', expectedSalary: '', noticeDays: '', coverNote: '', website: '' });
  const [file, setFile] = useState(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setV((p) => ({ ...p, [k]: e.target.value }));
  const fe = err?.fieldErrors ?? {};
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    const fd = new FormData();
    Object.entries(v).forEach(([k, x]) => { if (x !== '') fd.append(k, x); });
    fd.append('consent', 'true');
    if (file) fd.append('cv', file);
    try { await api.post(`/careers/${slug}/apply`, fd, { auth: false }); onSent(); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <Card>
      <CardHeader title="Apply for this job" />
      <CardBody>
        <form onSubmit={submit} noValidate className="space-y-3">
          <div className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
            <Field label="First name" required error={fe.firstName}><Input value={v.firstName} autoComplete="given-name" onChange={set('firstName')} /></Field>
            <Field label="Last name" required error={fe.lastName}><Input value={v.lastName} autoComplete="family-name" onChange={set('lastName')} /></Field>
          </div>
          <Field label="Email" required error={fe.email}><Input type="email" autoComplete="email" value={v.email} onChange={set('email')} /></Field>
          <Field label="Phone" error={fe.phone}><Input type="tel" autoComplete="tel" value={v.phone} onChange={set('phone')} /></Field>
          <Field label="Current job title"><Input value={v.currentTitle} onChange={set('currentTitle')} /></Field>
          <div className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
            <Field label="Experience (years)"><Input type="number" min="0" step="0.5" value={v.experienceYears} onChange={set('experienceYears')} /></Field>
            <Field label="Notice period (days)"><Input type="number" min="0" value={v.noticeDays} onChange={set('noticeDays')} /></Field>
          </div>
          <Field label="Expected salary (NPR/month)"><Input type="number" min="0" value={v.expectedSalary} onChange={set('expectedSalary')} /></Field>
          <Field label="Why are you a good fit?"><Textarea rows={3} value={v.coverNote} maxLength={3000} onChange={set('coverNote')} /></Field>
          <input type="text" name="website" tabIndex={-1} autoComplete="off" className="hidden" value={v.website} onChange={set('website')} aria-hidden="true" />
          <div>
            <input ref={fileRef} type="file" accept="application/pdf" className="sr-only" aria-label="CV (PDF)" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <button type="button" onClick={() => fileRef.current?.click()} className={cn('flex w-full items-center gap-3 rounded-lg border border-dashed px-4 py-3 text-left text-sm hover:bg-subtle', fe.cv ? 'border-danger-600' : 'border-line-strong')}>
              <Upload className="size-5 shrink-0 text-ink-400" /><span className="min-w-0 truncate font-medium text-ink-900">{file ? file.name : 'Attach your CV (PDF) *'}</span>
            </button>
            {fe.cv && <p role="alert" className="mt-1.5 text-xs font-medium text-danger-600">{fe.cv}</p>}
          </div>
          <Checkbox label="I agree that the company stores my application to consider me for jobs." checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          {err && !Object.keys(fe).length && <p role="alert" className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-700">{err.message}</p>}
          <Button type="submit" className="w-full" loading={busy} disabled={!consent}>Send application</Button>
        </form>
      </CardBody>
    </Card>
  );
}

