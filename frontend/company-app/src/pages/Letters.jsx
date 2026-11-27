import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BadgeCheck, Download, FileSignature, FileText, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button, Card, CardBody, CardHeader, DataTable, Dialog, EmptyState, Field, Input, Select, Skeleton, Textarea, cn, useToast } from '@hrms/shared-ui';
import { api, useAuth, useAction, PageHeader, StatusBadge, dt } from '../lib.jsx';

const useTypes = () => useQuery({ queryKey: ['letter-types'], queryFn: () => api.get('/letters/types'), staleTime: Infinity });
const fileName = (l) => `${l.typeLabel.toLowerCase().replace(/\s+/g, '-')}-${(l.reference ?? l.key).replace(/[^\w-]+/g, '-')}.pdf`;

function useDownload() {
  const toast = useToast();
  return async (l) => {
    try { await api.download(`/letters/${l.id}/pdf`, fileName(l)); } catch (e) { toast.error('Could not download the letter', e.message); }
  };
}

// =========================================================================== employee: my letters
function RequestDialog({ open, onClose }) {
  const { data: types } = useTypes();
  const [v, setV] = useState({ type: '', purpose: '', addressedTo: '', details: '' });
  useEffect(() => { if (open) setV({ type: '', purpose: '', addressedTo: '', details: '' }); }, [open]);
  const create = useAction((b) => api.post('/letters', b), { success: 'Request sent to HR', invalidate: [['my-letters']], onDone: onClose });
  const fe = create.error?.fieldErrors ?? {};
  const t = (types ?? []).find((x) => x.value === v.type);
  const set = (k) => (e) => setV((p) => ({ ...p, [k]: e.target.value }));
  return (
    <Dialog open={open} onClose={onClose} title="Request a letter" description="HR prepares it on the company letterhead. You get a notification when it is ready to download." size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={create.isPending} onClick={() => create.mutate({ type: v.type, purpose: v.purpose.trim(), ...(v.addressedTo.trim() && { addressedTo: v.addressedTo.trim() }), ...(v.details.trim() && { details: v.details.trim() }) })}>Send request</Button></>}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Letter type">
          {(types ?? []).map((x) => (
            <button key={x.value} type="button" role="radio" aria-checked={v.type === x.value} onClick={() => setV((p) => ({ ...p, type: x.value }))}
              className={cn('rounded-lg border p-3 text-left', v.type === x.value ? 'border-brand-600 bg-brand-50' : 'border-line hover:bg-subtle')}>
              <p className="text-sm font-semibold text-ink-900">{x.label}</p><p className="mt-0.5 text-xs text-ink-500">{x.hint}</p>
            </button>
          ))}
        </div>
        {fe.type && <p role="alert" className="text-xs font-medium text-danger-600">Choose the type of letter</p>}
        {v.type && <>
          <Field label="What is it for?" required error={fe.purpose} hint={v.type === 'NOC' ? 'e.g. travel to Japan from 1 to 10 Poush for a family visit' : 'e.g. a home loan application, a visa application'}>
            <Input value={v.purpose} maxLength={300} onChange={set('purpose')} />
          </Field>
          <Field label={v.type === 'BANK' ? 'Bank and branch' : 'Addressed to (optional)'} required={v.type === 'BANK'} error={fe.addressedTo} hint={v.type === 'BANK' ? 'One line each, e.g. The Branch Manager / Nabil Bank Ltd. / New Road, Kathmandu' : 'Leave empty for "To whom it may concern"'}>
            <Textarea rows={3} value={v.addressedTo} maxLength={300} onChange={set('addressedTo')} />
          </Field>
          <Field label="Anything else HR should know" error={fe.details}><Textarea rows={2} value={v.details} maxLength={1000} onChange={set('details')} /></Field>
          {t && <p className="text-xs text-ink-500">The letter uses your details as HR has them: name, role, department and joining date{['SALARY', 'BANK'].includes(v.type) ? ', and your current monthly salary' : ''}. If something is wrong, tell HR in the box above.</p>}
        </>}
      </div>
    </Dialog>
  );
}

export function MyLetters() {
  const [open, setOpen] = useState(false);
  const { data, isPending, error } = useQuery({ queryKey: ['my-letters'], queryFn: () => api.get('/letters?view=mine') });
  const cancel = useAction((id) => api.post(`/letters/${id}/cancel`, {}), { success: 'Request cancelled', invalidate: [['my-letters']] });
  const download = useDownload();
  return (
    <>
      <PageHeader title="My letters" description="Employment, salary and experience letters from HR, ready to download." actions={<Button onClick={() => setOpen(true)}><FileSignature className="size-4" />Request a letter</Button>} />
      {isPending ? <Skeleton className="h-48" /> : error ? <Card><EmptyState icon={<FileText className="size-5" />} title="Could not load your letters" description={error.message} /></Card> : !data.length ? (
        <Card><EmptyState icon={<FileText className="size-5" />} title="No letters yet" description="Need proof of employment or salary for a bank, embassy or new job? Request it here instead of emailing HR." action={<Button onClick={() => setOpen(true)}>Request a letter</Button>} /></Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 [&>*]:min-w-0">
          {data.map((l) => (
            <Card key={l.id}>
              <CardBody>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0"><p className="font-semibold text-ink-900">{l.typeLabel}</p><p className="truncate text-sm text-ink-500">{l.purpose}</p></div>
                  <StatusBadge value={l.status} />
                </div>
                <p className="mt-2 text-xs text-ink-500">{l.status === 'ISSUED' ? `Issued ${dt(l.issuedAt)} · Ref ${l.reference}` : l.status === 'REVOKED' ? `Withdrawn by HR ${dt(l.revokedAt)}${l.revokeReason ? `: ${l.revokeReason}` : ''}` : `Requested ${dt(l.createdAt)}`}</p>
                {l.status === 'REJECTED' && l.decisionNote && <p className="mt-2 rounded-md bg-danger-50 p-2 text-sm text-danger-700">{l.decisionNote}</p>}
                <div className="mt-3 flex gap-2">
                  {l.abilities.download && <Button size="sm" onClick={() => download(l)}><Download className="size-4" />Download PDF</Button>}
                  {l.abilities.cancel && <Button size="sm" variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate(l.id)}>Cancel request</Button>}
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
      <RequestDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

// =========================================================================== HR: requests and letterhead
export function Letters() {
  const a = useAuth();
  const [status, setStatus] = useState('PENDING');
  const key = ['letters', status];
  const { data, isPending } = useQuery({ queryKey: key, queryFn: () => api.get(`/letters?view=all${status ? `&status=${status}` : ''}`) });
  const [dlg, setDlg] = useState(null);
  const inv = [['letters']];
  const issue = useAction(({ id, ...b }) => api.post(`/letters/${id}/issue`, b), { success: (l) => `Issued ${l.reference}`, invalidate: inv, onDone: () => setDlg(null) });
  const reject = useAction(({ id, ...b }) => api.post(`/letters/${id}/reject`, b), { success: 'Request rejected', invalidate: inv, onDone: () => setDlg(null) });
  const revoke = useAction(({ id, ...b }) => api.post(`/letters/${id}/revoke`, b), { success: 'Letter withdrawn', invalidate: inv, onDone: () => setDlg(null) });
  const download = useDownload();
  return (
    <>
      <PageHeader title="Letter requests" description="Issue employment, salary and experience letters on the company letterhead."
        actions={<>
          <div className="w-40"><Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: 'PENDING', label: 'Waiting' }, { value: 'ISSUED', label: 'Issued' }, { value: 'REJECTED', label: 'Rejected' }, { value: '', label: 'All' }]} /></div>
          {a.can('letters:configure') && <Button variant="secondary" onClick={() => setDlg({ kind: 'letterhead' })}>Letterhead</Button>}
        </>} />
      <DataTable loading={isPending} rows={data ?? []}
        empty={<EmptyState icon={<FileText className="size-5" />} title={status === 'PENDING' ? 'No requests waiting' : 'Nothing here'} description={status === 'PENDING' ? 'When an employee requests a letter it appears here.' : undefined} />}
        columns={[
          { key: 'employee', header: 'Employee', render: (r) => <><p className="font-medium text-ink-900">{r.employee.name}</p><p className="text-xs text-ink-400">{r.employee.code}</p></> },
          { key: 'type', header: 'Letter', render: (r) => <><p>{r.typeLabel}</p><p className="max-w-72 truncate text-xs text-ink-500">{r.purpose}</p></> },
          { key: 'createdAt', header: 'Requested', render: (r) => dt(r.createdAt) },
          { key: 'status', header: 'Status', render: (r) => <><StatusBadge value={r.status} />{r.reference && <p className="mt-0.5 text-xs text-ink-400">{r.reference}</p>}</> },
          { key: 'x', header: '', render: (r) => (
            <div className="flex justify-end gap-1">
              {r.abilities.issue && <Button size="sm" onClick={() => setDlg({ kind: 'issue', l: r })}>Review and issue</Button>}
              {r.abilities.reject && <Button size="sm" variant="ghost" onClick={() => setDlg({ kind: 'reject', l: r })}>Reject</Button>}
              {r.abilities.download && <Button size="sm" variant="secondary" onClick={() => download(r)}><Download className="size-4" /><span className="sr-only sm:not-sr-only">PDF</span></Button>}
              {r.abilities.revoke && <Button size="sm" variant="ghost" onClick={() => setDlg({ kind: 'revoke', l: r })}>Withdraw</Button>}
            </div>
          ) },
        ]} />
      {dlg?.kind === 'issue' && <IssueDialog l={dlg.l} action={issue} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'reject' && <NoteDialog title={`Reject ${dlg.l.typeLabel.toLowerCase()} request?`} label="Reason (the employee sees this)" submitLabel="Reject" danger action={reject} onSubmit={(reason) => reject.mutate({ id: dlg.l.id, reason })} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'revoke' && <NoteDialog title={`Withdraw ${dlg.l.reference}?`} description="The employee can no longer download it, and the verification page shows it as withdrawn." label="Reason" submitLabel="Withdraw letter" danger action={revoke} onSubmit={(reason) => revoke.mutate({ id: dlg.l.id, reason })} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'letterhead' && <LetterheadDialog onClose={() => setDlg(null)} />}
    </>
  );
}

function IssueDialog({ l, action, onClose }) {
  const { data: head } = useQuery({ queryKey: ['letterhead'], queryFn: () => api.get('/letters/settings') });
  const [v, setV] = useState({ extraParagraph: '', signatoryName: '', signatoryTitle: '' });
  useEffect(() => { if (head) setV((p) => ({ ...p, signatoryName: p.signatoryName || head.signatoryName, signatoryTitle: p.signatoryTitle || head.signatoryTitle })); }, [head]);
  const fe = action.error?.fieldErrors ?? {};
  return (
    <Dialog open onClose={onClose} title={`Issue ${l.typeLabel.toLowerCase()}`} description={`For ${l.employee.name} · ${l.purpose}`} size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={action.isPending} onClick={() => action.mutate({ id: l.id, ...(v.extraParagraph.trim() && { extraParagraph: v.extraParagraph.trim() }), ...(v.signatoryName.trim() && { signatoryName: v.signatoryName.trim() }), ...(v.signatoryTitle.trim() && { signatoryTitle: v.signatoryTitle.trim() }) })}>Issue letter</Button></>}>
      <div className="space-y-4">
        {l.addressedTo && <div className="rounded-md bg-subtle p-3 text-sm"><p className="text-xs font-medium text-ink-500">Addressed to</p><p className="whitespace-pre-line text-ink-900">{l.addressedTo}</p></div>}
        {l.details && <div className="rounded-md bg-subtle p-3 text-sm"><p className="text-xs font-medium text-ink-500">Note from the employee</p><p className="text-ink-900">{l.details}</p></div>}
        <p className="text-sm text-ink-700">The letter is written from the employee's record{['SALARY', 'BANK'].includes(l.type) ? ' and current salary' : ''}. Check the record is correct before you issue it. You can add a paragraph below.</p>
        {head && !head.legalName && !head.address && <p className="rounded-md bg-warning-50 p-3 text-sm text-warning-700">The letterhead has no address yet. Set it under Letterhead so letters show your full company details.</p>}
        <Field label="Additional paragraph (optional)" error={fe.extraParagraph} hint="e.g. a sentence about conduct or performance for an experience letter"><Textarea rows={4} maxLength={1500} value={v.extraParagraph} onChange={(e) => setV({ ...v, extraParagraph: e.target.value })} /></Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
          <Field label="Signed by"><Input value={v.signatoryName} maxLength={120} onChange={(e) => setV({ ...v, signatoryName: e.target.value })} /></Field>
          <Field label="Title"><Input value={v.signatoryTitle} maxLength={120} placeholder="e.g. HR Manager" onChange={(e) => setV({ ...v, signatoryTitle: e.target.value })} /></Field>
        </div>
        {action.error && !Object.keys(fe).length && <p role="alert" className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-700">{action.error.message}</p>}
      </div>
    </Dialog>
  );
}

function NoteDialog({ title, description, label, submitLabel, danger, action, onSubmit, onClose }) {
  const [note, setNote] = useState('');
  const fe = action.error?.fieldErrors ?? {};
  return (
    <Dialog open onClose={onClose} title={title} description={description} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} loading={action.isPending} onClick={() => onSubmit(note.trim())}>{submitLabel}</Button></>}>
      <Field label={label} required error={fe.reason}><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </Dialog>
  );
}

function LetterheadDialog({ onClose }) {
  const { data } = useQuery({ queryKey: ['letterhead'], queryFn: () => api.get('/letters/settings') });
  const [v, setV] = useState(null);
  useEffect(() => { if (data && !v) setV(data); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useAction((b) => api.put('/letters/settings', b), { success: 'Letterhead saved', invalidate: [['letterhead']], onDone: onClose });
  const fe = save.error?.fieldErrors ?? {};
  const f = (k, label, extra = {}) => <Field label={label} error={fe[k]} hint={extra.hint} className={extra.wide ? 'sm:col-span-2' : undefined}>{extra.area ? <Textarea rows={2} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} /> : <Input value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />}</Field>;
  return (
    <Dialog open onClose={onClose} title="Letterhead" description="Printed at the top and bottom of every letter." size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!v} onClick={() => save.mutate(v)}>Save</Button></>}>
      {!v ? <Skeleton className="h-64" /> : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
          {f('legalName', 'Registered company name', { wide: true, hint: 'As registered, e.g. Lishnu Tech Pvt. Ltd.' })}
          {f('address', 'Address', { wide: true, area: true })}
          {f('phone', 'Phone')}{f('email', 'Email')}{f('website', 'Website')}{f('pan', 'PAN / VAT number')}
          {f('signatoryName', 'Default signatory')}{f('signatoryTitle', 'Signatory title')}
          {f('referencePrefix', 'Reference prefix', { hint: 'Letters are numbered like LTR/2083/0001' })}
        </div>
      )}
    </Dialog>
  );
}

// =========================================================================== public verification page
export function VerifyLetter() {
  const { code } = useParams();
  const { data, isPending, error } = useQuery({ queryKey: ['verify', code], queryFn: () => api.get(`/verify/letters/${encodeURIComponent(code)}`, { auth: false }), retry: false });
  const valid = data?.status === 'VALID';
  return (
    <div className="mx-auto max-w-lg px-4 py-12">
      <Card>
        <CardHeader title="Letter verification" description={`Code ${String(code).toUpperCase()}`} />
        <CardBody>
          {isPending ? <Skeleton className="h-32" /> : error ? (
            <div className="flex gap-3"><ShieldAlert className="size-6 shrink-0 text-danger-600" /><div><p className="font-semibold text-ink-900">No letter found</p><p className="mt-1 text-sm text-ink-500">This code does not match any letter issued by this company. Check the code, or contact the company directly.</p></div></div>
          ) : (
            <>
              <div className={cn('mb-4 flex items-center gap-3 rounded-lg p-3', valid ? 'bg-success-50' : 'bg-danger-50')}>
                {valid ? <ShieldCheck className="size-6 text-success-600" /> : <ShieldAlert className="size-6 text-danger-600" />}
                <div><p className={cn('font-semibold', valid ? 'text-success-700' : 'text-danger-700')}>{valid ? 'Genuine letter' : 'This letter was withdrawn'}</p><p className="text-sm text-ink-700">{valid ? `Issued by ${data.company}` : `Withdrawn by ${data.company} on ${data.revokedOn}`}</p></div>
              </div>
              <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                {[['Letter', data.type], ['Reference', data.reference], ['Issued to', data.employee], ['Role', data.designation], ['Issued on', data.issuedOn]].filter(([, x]) => x).map(([k, x]) => <div key={k}><dt className="text-ink-500">{k}</dt><dd className="font-medium text-ink-900">{x}</dd></div>)}
              </dl>
              <p className="mt-4 flex items-start gap-2 text-xs text-ink-500"><BadgeCheck className="mt-0.5 size-4 shrink-0" />Compare these details with the letter you were given. Salary figures are not shown here.</p>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/** Dashboard counter for HR: letter requests waiting. */
export const usePendingLetters = (enabled) => useQuery({ queryKey: ['letters', 'PENDING'], queryFn: () => api.get('/letters?view=all&status=PENDING'), enabled, retry: false });
