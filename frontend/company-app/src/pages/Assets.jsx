import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, Laptop, PackagePlus, AlertTriangle, ArrowLeftRight, Undo2 } from 'lucide-react';
import { Button, Card, CardBody, CardHeader, DataTable, Dialog, EmptyState, Field, Input, Select, Skeleton, Textarea, Checkbox, Badge } from '@hrms/shared-ui';
import { api, useAuth, useAction, useList, PageHeader, StatusBadge, KV, npr, dt, todayKtm } from '../lib.jsx';
import { PersonPicker, Tiles, BackLink, ErrorNote, label, useDownload } from './kit.jsx';

const CONDITIONS = ['NEW', 'GOOD', 'FAIR', 'POOR', 'DAMAGED'];
const condOpts = CONDITIONS.map((c) => ({ value: c, label: label(c) }));
const STATUS_OPTS = [['AVAILABLE', 'Available'], ['ASSIGNED', 'With someone'], ['IN_REPAIR', 'In repair'], ['RETIRED', 'Retired'], ['LOST', 'Lost']].map(([value, l]) => ({ value, label: l }));
const EVENT_TEXT = { CREATED: 'Added to the register', UPDATED: 'Details changed', ASSIGNED: 'Handed over', RETURNED: 'Returned', IN_REPAIR: 'Sent for repair', AVAILABLE: 'Back in stock', RETIRED: 'Retired', LOST: 'Marked as lost', ISSUE: 'Problem reported', NOTE: 'Note' };

const useCategories = () => useQuery({ queryKey: ['asset-categories'], queryFn: () => api.get('/assets/categories'), staleTime: 300_000 });
const useBranches = () => useQuery({ queryKey: ['branches'], queryFn: () => api.get('/branches?pageSize=100&sort=name&order=asc') });

// =========================================================================== register
function AssetDialog({ asset, onClose, onDone }) {
  const { data: cats = [] } = useCategories();
  const { data: branches = [] } = useBranches();
  const [v, setV] = useState(() => ({
    name: asset?.name ?? '', category: asset?.category ?? '', assetTag: asset?.assetTag ?? '', serialNo: asset?.serialNo ?? '', brandModel: asset?.brandModel ?? '',
    branchId: asset?.branchId ?? '', purchaseDate: asset?.purchaseDate ?? '', purchaseCost: asset?.purchaseCost ?? '', vendor: asset?.vendor ?? '',
    warrantyUntil: asset?.warrantyUntil ?? '', condition: asset?.condition ?? 'GOOD', notes: asset?.notes ?? '',
  }));
  const save = useAction((b) => (asset ? api.patch(`/assets/${asset.id}`, b) : api.post('/assets', b)), { success: asset ? 'Asset updated' : 'Asset added', invalidate: [['/assets'], ['asset'], ['asset-summary']], onDone });
  const fe = save.error?.fieldErrors ?? {};
  const set = (k) => (e) => setV((p) => ({ ...p, [k]: e.target.value }));
  const submit = () => save.mutate({
    ...v, branchId: v.branchId || null, purchaseDate: v.purchaseDate || null, warrantyUntil: v.warrantyUntil || null,
    purchaseCost: v.purchaseCost === '' ? null : Number(v.purchaseCost),
  });
  return (
    <Dialog open onClose={onClose} title={asset ? `Edit ${asset.key}` : 'Add an asset'} description="Equipment, devices and other company property you hand to people." size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={submit}>{asset ? 'Save' : 'Add asset'}</Button></>}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="Name" required error={fe.name} className="sm:col-span-2"><Input value={v.name} maxLength={120} placeholder="e.g. Dell Latitude 5440" onChange={set('name')} /></Field>
        <Field label="Category" required error={fe.category}>
          <Input list="asset-cats" value={v.category} maxLength={40} placeholder="Laptop, Mobile phone…" onChange={set('category')} />
          <datalist id="asset-cats">{cats.map((c) => <option key={c} value={c} />)}</datalist>
        </Field>
        <Field label="Condition"><Select value={v.condition} onChange={set('condition')} options={condOpts} /></Field>
        <Field label="Asset tag" error={fe.assetTag} hint="The label stuck on the item"><Input value={v.assetTag} maxLength={60} onChange={set('assetTag')} /></Field>
        <Field label="Serial number" error={fe.serialNo}><Input value={v.serialNo} maxLength={80} onChange={set('serialNo')} /></Field>
        <Field label="Brand and model"><Input value={v.brandModel} maxLength={120} onChange={set('brandModel')} /></Field>
        <Field label="Branch"><Select value={v.branchId} onChange={set('branchId')} placeholder="Any branch" options={branches.map((b) => ({ value: b.id, label: b.name }))} /></Field>
        <Field label="Purchase date"><Input type="date" value={v.purchaseDate} max={todayKtm()} onChange={set('purchaseDate')} /></Field>
        <Field label="Cost (NPR)" error={fe.purchaseCost}><Input type="number" min="0" value={v.purchaseCost} onChange={set('purchaseCost')} /></Field>
        <Field label="Bought from"><Input value={v.vendor} maxLength={120} onChange={set('vendor')} /></Field>
        <Field label="Warranty until"><Input type="date" value={v.warrantyUntil} onChange={set('warrantyUntil')} /></Field>
        <Field label="Notes" className="sm:col-span-2"><Textarea rows={2} value={v.notes} maxLength={1000} onChange={set('notes')} /></Field>
      </div>
      <div className="mt-3"><ErrorNote error={save.error?.code === 'DUPLICATE_TAG' ? save.error : null} /></div>
    </Dialog>
  );
}

export function Assets() {
  const a = useAuth();
  const nav = useNavigate();
  const list = useList('/assets', {});
  const { data: sum } = useQuery({ queryKey: ['asset-summary'], queryFn: () => api.get('/assets/summary') });
  const { data: cats = [] } = useCategories();
  const [dlg, setDlg] = useState(false);
  const download = useDownload();
  const p = list.params;
  return (
    <>
      <PageHeader title="Assets" description="Company equipment, who has it, and its history."
        actions={<>
          {a.can('assets:export') && <Button variant="secondary" onClick={() => download('/assets/export', 'assets.csv')}><Download className="size-4" />Export</Button>}
          {a.can('assets:create') && <Button onClick={() => setDlg(true)}><PackagePlus className="size-4" />Add asset</Button>}
        </>} />
      <Tiles tiles={[
        { label: 'Items', value: sum?.total, hint: sum ? `${sum.byStatus.AVAILABLE} available` : undefined, onClick: () => list.set({ status: undefined, warranty: undefined }) },
        { label: 'With people', value: sum?.byStatus.ASSIGNED, hint: sum?.overdueReturns ? `${sum.overdueReturns} past the return date` : undefined, tone: sum?.overdueReturns ? 'warning' : undefined, onClick: () => list.set({ status: 'ASSIGNED', warranty: undefined }) },
        { label: 'In repair', value: sum?.byStatus.IN_REPAIR, onClick: () => list.set({ status: 'IN_REPAIR', warranty: undefined }) },
        { label: 'Warranty ending soon', value: sum?.warrantyExpiring, hint: 'In the next 60 days', tone: sum?.warrantyExpiring ? 'warning' : undefined, onClick: () => list.set({ warranty: 'expiring', status: undefined }) },
      ]} />
      <div className="mb-4 flex flex-wrap gap-2">
        <Input placeholder="Search name, tag or serial…" className="max-w-xs" aria-label="Search" defaultValue={p.search ?? ''} onChange={(e) => list.set({ search: e.target.value || undefined })} />
        <div className="w-40"><Select aria-label="Status" placeholder="Any status" value={p.status ?? ''} onChange={(e) => list.set({ status: e.target.value || undefined })} options={STATUS_OPTS} /></div>
        <div className="w-44"><Select aria-label="Category" placeholder="Any category" value={p.category ?? ''} onChange={(e) => list.set({ category: e.target.value || undefined })} options={cats.map((c) => ({ value: c, label: c }))} /></div>
        {p.warranty && <Button variant="ghost" size="sm" onClick={() => list.set({ warranty: undefined })}>Clear warranty filter</Button>}
      </div>
      <DataTable loading={list.loading} rows={list.rows} meta={list.meta} onPage={list.page} onRowClick={(r) => nav(`/assets/${r.id}`)}
        empty={<EmptyState icon={<Laptop className="size-5" />} title={p.status || p.search || p.category ? 'Nothing matches' : 'No assets yet'} description={p.status || p.search ? undefined : 'Add laptops, phones, ID cards and other items you give to employees.'} action={!p.status && a.can('assets:create') ? <Button onClick={() => setDlg(true)}>Add asset</Button> : undefined} />}
        mobile={(r) => (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0"><p className="truncate font-medium text-ink-900">{r.name}</p><p className="text-xs text-ink-400">{r.key} · {r.category}{r.assetTag ? ` · ${r.assetTag}` : ''}</p>{r.holder && <p className="text-xs text-ink-500">With {r.holder.name}</p>}</div>
            <StatusBadge value={r.status} />
          </div>
        )}
        columns={[
          { key: 'name', header: 'Item', render: (r) => <><p className="font-medium text-ink-900">{r.name}</p><p className="text-xs text-ink-400">{r.key} · {r.category}{r.brandModel ? ` · ${r.brandModel}` : ''}</p></> },
          { key: 'tag', header: 'Tag / serial', render: (r) => <><p>{r.assetTag ?? '—'}</p>{r.serialNo && <p className="text-xs text-ink-400">{r.serialNo}</p>}</> },
          { key: 'holder', header: 'With', render: (r) => (r.holder ? <><p>{r.holder.name}</p><p className="text-xs text-ink-400">since {dt(r.assignedAt)}</p></> : <span className="text-ink-400">—</span>) },
          { key: 'condition', header: 'Condition', render: (r) => label(r.condition) },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge value={r.status} /> },
        ]} />
      {dlg && <AssetDialog onClose={() => setDlg(false)} onDone={(x) => { setDlg(false); nav(`/assets/${x.id}`); }} />}
    </>
  );
}

// =========================================================================== detail
export function AssetDetail() {
  const { id } = useParams();
  const { data: x, isPending, error } = useQuery({ queryKey: ['asset', id], queryFn: () => api.get(`/assets/${id}`) });
  const [dlg, setDlg] = useState(null);
  const inv = [['asset', id], ['/assets'], ['asset-summary']];
  const done = { invalidate: inv, onDone: () => setDlg(null) };
  const assign = useAction((b) => api.post(`/assets/${id}/assign`, b), { success: 'Handed over', ...done });
  const ret = useAction((b) => api.post(`/assets/${id}/return`, b), { success: 'Item returned', ...done });
  const status = useAction((b) => api.post(`/assets/${id}/status`, b), { success: 'Status changed', ...done });
  if (isPending) return <Skeleton className="h-96" />;
  if (error) return <EmptyState title="Asset not found" description={error.message} />;
  const ab = x.abilities;
  return (
    <>
      <BackLink to={ab.edit ? '/assets' : '/me/assets'}>{ab.edit ? 'Assets' : 'My assets'}</BackLink>
      <PageHeader title={x.name} description={`${x.key} · ${x.category}`}
        actions={<>
          {ab.edit && <Button variant="secondary" onClick={() => setDlg('edit')}>Edit</Button>}
          {ab.setStatus && <Button variant="secondary" onClick={() => setDlg('status')}>Change status</Button>}
          {ab.return && <Button variant="secondary" onClick={() => setDlg('return')}><Undo2 className="size-4" />Take back</Button>}
          {ab.assign && <Button onClick={() => setDlg('assign')}><ArrowLeftRight className="size-4" />Hand over</Button>}
          {ab.report && <Button variant="secondary" onClick={() => setDlg('report')}><AlertTriangle className="size-4" />Report a problem</Button>}
        </>} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr] [&>*]:min-w-0">
        <div className="space-y-4">
          <Card>
            <CardBody className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-xs font-medium text-ink-500">Now</p>
                <p className="text-lg font-semibold text-ink-900">{x.holder ? `With ${x.holder.name}` : label(x.status)}</p>
                {x.holder && <p className="text-sm text-ink-500">Since {dt(x.assignedAt)}{x.dueBackOn ? ` · due back ${dt(x.dueBackOn)}` : ''}</p>}
              </div>
              <StatusBadge value={x.status} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <KV items={[['Asset tag', x.assetTag], ['Serial number', x.serialNo], ['Brand and model', x.brandModel], ['Branch', x.branch], ['Condition', label(x.condition)],
                ['Purchase date', x.purchaseDate && dt(x.purchaseDate)], ['Cost', x.purchaseCost != null ? npr(x.purchaseCost) : null], ['Bought from', x.vendor],
                ['Warranty until', x.warrantyUntil && dt(x.warrantyUntil)]]} />
              {x.notes && <p className="mt-4 whitespace-pre-wrap rounded-md bg-subtle p-3 text-sm text-ink-700">{x.notes}</p>}
            </CardBody>
          </Card>
        </div>
        <Card className="self-start">
          <CardHeader title="History" />
          <CardBody>
            <ol className="relative space-y-4 border-l border-line pl-5">
              {x.history.map((e) => (
                <li key={e.id} className="relative">
                  <span className={`absolute -left-[26px] top-1 size-3 rounded-full border-2 border-surface ${e.type === 'ISSUE' || e.type === 'LOST' ? 'bg-danger-600' : e.type === 'ASSIGNED' ? 'bg-brand-600' : 'bg-success-600'}`} aria-hidden="true" />
                  <p className="text-sm font-medium text-ink-900">{EVENT_TEXT[e.type]}{e.employee ? (e.type === 'ASSIGNED' ? ` to ${e.employee.name}` : e.type === 'RETURNED' ? ` by ${e.employee.name}` : '') : ''}</p>
                  <p className="text-xs text-ink-500">{dt(e.at, true)}{e.by ? ` · ${e.by}` : ''}{e.condition ? ` · ${label(e.condition)}` : ''}</p>
                  {e.note && <p className="mt-1 text-sm text-ink-700">{e.note}</p>}
                </li>
              ))}
            </ol>
          </CardBody>
        </Card>
      </div>
      {dlg === 'edit' && <AssetDialog asset={x} onClose={() => setDlg(null)} onDone={() => setDlg(null)} />}
      {dlg === 'assign' && <AssignDialog action={assign} onClose={() => setDlg(null)} />}
      {dlg === 'return' && <ReturnDialog x={x} action={ret} onClose={() => setDlg(null)} />}
      {dlg === 'status' && <StatusDialog x={x} action={status} onClose={() => setDlg(null)} />}
      {dlg === 'report' && <ReportDialog x={x} onClose={() => setDlg(null)} />}
    </>
  );
}

function AssignDialog({ action, onClose }) {
  const [v, setV] = useState({ employeeId: '', dueBackOn: '', note: '' });
  const fe = action.error?.fieldErrors ?? {};
  return (
    <Dialog open onClose={onClose} title="Hand over" description="The person gets a notification and sees the item under My assets."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={action.isPending} disabled={!v.employeeId} onClick={() => action.mutate({ employeeId: v.employeeId, dueBackOn: v.dueBackOn || null, note: v.note || undefined })}>Hand over</Button></>}>
      <div className="space-y-4">
        <Field label="To" required error={fe.employeeId}><PersonPicker value={v.employeeId} onChange={(employeeId) => setV({ ...v, employeeId })} /></Field>
        <Field label="Return by (optional)" error={fe.dueBackOn} hint="For loans, e.g. a projector for an event"><Input type="date" min={todayKtm()} value={v.dueBackOn} onChange={(e) => setV({ ...v, dueBackOn: e.target.value })} /></Field>
        <Field label="Note"><Textarea rows={2} value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} placeholder="e.g. With charger and bag" /></Field>
      </div>
    </Dialog>
  );
}

function ReturnDialog({ x, action, onClose }) {
  const [v, setV] = useState({ condition: x.condition, note: '', toRepair: false });
  return (
    <Dialog open onClose={onClose} title={`Take back from ${x.holder?.name}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={action.isPending} onClick={() => action.mutate({ ...v, note: v.note || undefined })}>Take back</Button></>}>
      <div className="space-y-4">
        <Field label="Condition now" hint="Damaged items go to repair"><Select value={v.condition} onChange={(e) => setV({ ...v, condition: e.target.value })} options={condOpts} /></Field>
        <Checkbox label="Send it for repair" checked={v.toRepair || v.condition === 'DAMAGED'} disabled={v.condition === 'DAMAGED'} onChange={(e) => setV({ ...v, toRepair: e.target.checked })} />
        <Field label="Note"><Textarea rows={2} value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} placeholder="e.g. Charger missing" /></Field>
      </div>
    </Dialog>
  );
}

function StatusDialog({ x, action, onClose }) {
  const opts = [['AVAILABLE', 'Available'], ['IN_REPAIR', 'In repair'], ['RETIRED', 'Retired (sold, scrapped)'], ['LOST', 'Lost or stolen']].filter(([k]) => k !== x.status).map(([value, l]) => ({ value, label: l }));
  const [v, setV] = useState({ status: opts[0].value, note: '' });
  const fe = action.error?.fieldErrors ?? {};
  return (
    <Dialog open onClose={onClose} title="Change status"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={action.isPending} onClick={() => action.mutate({ status: v.status, note: v.note || undefined })}>Save</Button></>}>
      <div className="space-y-4">
        <Field label="Status"><Select value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })} options={opts} /></Field>
        <Field label="Reason" required={['RETIRED', 'LOST'].includes(v.status)} error={fe.note}><Textarea rows={2} value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

function ReportDialog({ x, onClose }) {
  const [v, setV] = useState({ note: '', lost: false });
  const report = useAction((b) => api.post(`/assets/${x.id}/report`, b), { success: 'Reported. The asset team has been told.', invalidate: [['asset', x.id], ['my-assets']], onDone: onClose });
  const fe = report.error?.fieldErrors ?? {};
  return (
    <Dialog open onClose={onClose} title={`Problem with ${x.name}`} description="Tell the people who manage company equipment what is wrong."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={report.isPending} onClick={() => report.mutate(v)}>Send</Button></>}>
      <div className="space-y-4">
        <Field label="What is wrong?" required error={fe.note}><Textarea rows={3} value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} placeholder="e.g. The battery lasts less than an hour" /></Field>
        <Checkbox label="It is lost or was stolen" checked={v.lost} onChange={(e) => setV({ ...v, lost: e.target.checked })} />
      </div>
    </Dialog>
  );
}

// =========================================================================== my assets
export function MyAssets() {
  const { data, isPending } = useQuery({ queryKey: ['my-assets'], queryFn: () => api.get('/assets/mine') });
  const [report, setReport] = useState(null);
  return (
    <>
      <PageHeader title="My assets" description="Company items you have. Look after them and report any problem." />
      {isPending ? <Skeleton className="h-40" /> : !data.current.length ? (
        <Card><EmptyState icon={<Laptop className="size-5" />} title="You have no company items" description="When the company hands you a laptop, phone, ID card or other item, it appears here." /></Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 [&>*]:min-w-0">
          {data.current.map((x) => (
            <Card key={x.id}>
              <CardBody>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0"><p className="font-semibold text-ink-900">{x.name}</p><p className="text-sm text-ink-500">{x.category}{x.brandModel ? ` · ${x.brandModel}` : ''}</p></div>
                  <Badge tone="brand">{x.key}</Badge>
                </div>
                <p className="mt-2 text-xs text-ink-500">With you since {dt(x.assignedAt)}{x.assetTag ? ` · tag ${x.assetTag}` : ''}{x.serialNo ? ` · serial ${x.serialNo}` : ''}{x.dueBackOn ? ` · return by ${dt(x.dueBackOn)}` : ''}</p>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setReport(x)}><AlertTriangle className="size-4" />Report a problem</Button>
                  <Link to={`/assets/${x.id}`} className="inline-flex items-center px-2 text-sm font-medium text-brand-700 hover:underline">Details</Link>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
      {data?.history?.length > 0 && (
        <Card className="mt-4">
          <CardHeader title="Returned" />
          <ul className="divide-y divide-line">{data.history.map((h, i) => <li key={i} className="flex justify-between gap-3 px-5 py-3 text-sm"><span className="min-w-0 truncate">{h.name} <span className="text-ink-400">{h.key}</span></span><span className="shrink-0 text-ink-500">{dt(h.returnedAt)}</span></li>)}</ul>
        </Card>
      )}
      {report && <ReportDialog x={report} onClose={() => setReport(null)} />}
    </>
  );
}
