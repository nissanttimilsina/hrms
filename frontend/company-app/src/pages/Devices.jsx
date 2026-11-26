import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, CardBody, CardHeader, DataTable, EmptyState, Skeleton, Badge, Select } from '@hrms/shared-ui';
import { api, useAuth, useList, useAction, FormDialog, PageHeader, StatusBadge, dt, fullName } from '../lib.jsx';
import { useOrg } from './People.jsx';

const HEALTH = { ONLINE: ['success', 'Online'], OFFLINE: ['danger', 'Offline'], NEVER_CONNECTED: ['warning', 'Waiting for first connection'], DISABLED: ['neutral', 'Disabled'] };
const RESULT = { APPLIED: 'success', UNMAPPED: 'warning', IGNORED: 'neutral', ERROR: 'danger' };

export function Devices() {
  const a = useAuth();
  const [tab, setTab] = useState('devices');
  const [dlg, setDlg] = useState(null);
  const org = useOrg();
  const { data: devices, isPending } = useQuery({ queryKey: ['devices'], queryFn: () => api.get('/devices'), refetchInterval: 30_000 });
  const { data: setup } = useQuery({ queryKey: ['device-setup'], queryFn: () => api.get('/devices/setup') });
  const manage = a.can('devices:manage');
  const save = useAction(({ id, ...b }) => (id ? api.patch(`/devices/${id}`, b) : api.post('/devices', b)), { success: 'Device saved', invalidate: [['devices']], onDone: () => setDlg(null) });
  const del = useAction((id) => api.del(`/devices/${id}`), { success: 'Device removed', invalidate: [['devices']], onDone: () => setDlg(null) });
  const tabs = [['devices', 'Devices'], ['punches', 'Punch log'], ['unmapped', 'Unmapped users']];
  return (
    <>
      <PageHeader title="Attendance devices" description="Fingerprint and face terminals push punches straight into attendance" actions={manage && <Button onClick={() => setDlg({ t: 'edit', d: { allowedIps: [] } })}>Add device</Button>} />
      <div className="mb-4 flex gap-1 border-b border-line">{tabs.map(([k, l]) => <button key={k} type="button" onClick={() => setTab(k)} className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-ink-500'}`}>{l}</button>)}</div>
      {tab === 'devices' && (isPending ? <Skeleton className="h-48" /> : (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-3 lg:col-span-2">
            {!devices.length && <EmptyState title="No devices yet" description="Register your terminal with its serial number, then point it at the server shown here." />}
            {devices.map((d) => {
              const [tone, label] = HEALTH[d.health];
              return (
                <Card key={d.id}><CardBody>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div><p className="font-semibold">{d.name} <Badge tone={tone}>{label}</Badge></p><p className="text-xs text-ink-500">SN {d.serialNumber}{d.branch ? ` · ${d.branch.name}` : ''}{d.location ? ` · ${d.location}` : ''}</p></div>
                    <div className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => setDlg({ t: 'logs', d })}>Sync log</Button>{manage && <Button size="sm" variant="ghost" onClick={() => setDlg({ t: 'edit', d })}>Edit</Button>}</div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                    <div><p className="text-xs text-ink-500">Last contact</p><p>{d.lastSeenAt ? dt(d.lastSeenAt, true) : '—'}</p></div>
                    <div><p className="text-xs text-ink-500">Last punch</p><p>{d.lastPunchAt ? dt(d.lastPunchAt, true) : '—'}</p></div>
                    <div><p className="text-xs text-ink-500">Punches received</p><p>{d.punchCount}</p></div>
                    <div><p className="text-xs text-ink-500">Users on device</p><p>{d.enrolledUsers || '—'}</p></div>
                  </div>
                  {d.lastError && <p className="mt-3 rounded-md bg-danger-50 p-2 text-xs text-danger-700">{dt(d.lastErrorAt, true)}: {d.lastError}</p>}
                </CardBody></Card>
              );
            })}
          </div>
          {setup && (
            <Card><CardHeader title="Connect a device" description="ZKTeco and compatible terminals with ADMS / Cloud Server" /><CardBody className="space-y-3 text-sm">
              <div className="rounded-md bg-subtle p-3 font-mono text-xs"><p>Server: {setup.serverAddress}</p><p>Port: {setup.httpsPort} (HTTPS) or {setup.httpPort}</p><p>Path: {setup.path}</p></div>
              <ol className="list-decimal space-y-1 pl-4 text-ink-600">{setup.notes.map((n) => <li key={n}>{n}</li>)}</ol>
              <p className="text-xs text-ink-500">Only punch times are stored. Fingerprints and face templates stay on the device.</p>
            </CardBody></Card>
          )}
        </div>
      ))}
      {tab === 'punches' && <Punches devices={devices ?? []} />}
      {tab === 'unmapped' && <Unmapped manage={manage} />}
      {dlg?.t === 'edit' && (
        <FormDialog open onClose={() => setDlg(null)} title={dlg.d.id ? `Edit ${dlg.d.name}` : 'Add device'} initial={{ ...dlg.d, allowedIps: (dlg.d.allowedIps ?? []).join(', ') }}
          fields={[
            { name: 'name', label: 'Name', required: true }, ...(dlg.d.id ? [{ name: 'status', label: 'Status', type: 'select', options: [{ value: 'ACTIVE', label: 'Active' }, { value: 'DISABLED', label: 'Disabled (device keeps its data)' }] }] : [{ name: 'serialNumber', label: 'Serial number', required: true, hint: 'Menu → System Info → Device Info' }]),
            { name: 'branchId', label: 'Branch', type: 'select', options: org.branches, placeholder: 'No branch' }, { name: 'location', label: 'Location' },
            { name: 'model', label: 'Model' }, { name: 'allowedIps', label: 'Allowed IP addresses (optional)', type: 'tags', hint: 'Comma-separated public IPs of the office. Leave empty to accept any.' },
          ]}
          loading={save.isPending} error={save.error}
          onSubmit={(b) => save.mutate({ ...(dlg.d.id && { id: dlg.d.id }), ...b, branchId: b.branchId || null, allowedIps: b.allowedIps ?? [] })} />
      )}
      {dlg?.t === 'logs' && <LogsDialog device={dlg.d} onClose={() => setDlg(null)} onDelete={manage ? () => del.mutate(dlg.d.id) : null} />}
    </>
  );
}

function Punches({ devices }) {
  const [f, setF] = useState({});
  const list = useList('/devices/punches', f);
  return (
    <>
      <div className="mb-3 flex flex-wrap gap-2">
        <div className="w-56"><Select value={f.deviceId ?? ''} placeholder="All devices" options={devices.map((d) => ({ value: d.id, label: d.name }))} onChange={(e) => setF({ ...f, deviceId: e.target.value || undefined })} aria-label="Device" /></div>
        <div className="w-48"><Select value={f.result ?? ''} placeholder="All results" options={Object.keys(RESULT).map((k) => ({ value: k, label: k.toLowerCase() }))} onChange={(e) => setF({ ...f, result: e.target.value || undefined })} aria-label="Result" /></div>
      </div>
      <DataTable loading={list.loading} rows={list.rows} meta={list.meta} onPage={list.page} empty={<EmptyState title="No punches yet" />} columns={[
        { key: 'punchedAt', header: 'Time', render: (r) => dt(r.punchedAt, true) }, { key: 'device', header: 'Device', render: (r) => r.device?.name },
        { key: 'deviceUserId', header: 'Device ID' }, { key: 'employee', header: 'Employee', render: (r) => (r.employee ? fullName(r.employee) : '—') },
        { key: 'result', header: 'Result', render: (r) => <Badge tone={RESULT[r.result]}>{r.result.toLowerCase()}</Badge> }, { key: 'message', header: 'Detail', render: (r) => <span className="text-xs text-ink-500">{r.message}</span> },
      ]} />
    </>
  );
}

function Unmapped({ manage }) {
  const { data, isPending, refetch } = useQuery({ queryKey: ['devices-unmapped'], queryFn: () => api.get('/devices/unmapped') });
  const [map, setMap] = useState(null);
  const save = useAction((b) => api.post('/devices/mappings', b), { success: (r) => `Linked. ${r.applied} earlier punch(es) applied.`, onDone: () => { setMap(null); refetch(); } });
  if (isPending) return <Skeleton className="h-40" />;
  return (
    <>
      <p className="mb-3 text-sm text-ink-600">These device user IDs punched in, or are enrolled on a device, but no employee has that Biometric ID. Link them to apply their punches.</p>
      <DataTable rows={data.map((r) => ({ id: r.deviceUserId, ...r }))} empty={<EmptyState title="Everyone is linked" />} columns={[
        { key: 'deviceUserId', header: 'Device ID' }, { key: 'nameOnDevice', header: 'Name on device', render: (r) => r.nameOnDevice || '—' },
        { key: 'punches', header: 'Waiting punches', align: 'right' }, { key: 'lastPunchAt', header: 'Last punch', render: (r) => (r.lastPunchAt ? dt(r.lastPunchAt, true) : '—') },
        { key: 'x', header: '', render: (r) => manage && <Button size="sm" onClick={() => setMap(r)}>Link to employee</Button> },
      ]} />
      {map && <LinkDialog map={map} save={save} onClose={() => setMap(null)} />}
    </>
  );
}

function LinkDialog({ map, save, onClose }) {
  const [q, setQ] = useState(map.nameOnDevice ?? '');
  const [sel, setSel] = useState('');
  const { data: found, isFetching } = useQuery({ queryKey: ['emp-search', q], queryFn: () => api.get(`/employees?pageSize=20&search=${encodeURIComponent(q)}`), placeholderData: (p) => p });
  const options = (found ?? []).filter((e) => !e.biometricId);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink-900/40 p-4" role="dialog" aria-modal="true" aria-label="Link device user">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-pop">
        <h2 className="font-semibold">Link device ID {map.deviceUserId}</h2>
        {map.nameOnDevice && <p className="text-sm text-ink-500">Name on device: {map.nameOnDevice}</p>}
        <input className="mt-4 h-10 w-full rounded-md border border-line-strong px-3 text-sm" placeholder="Search employees" aria-label="Search employees" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="mt-2 max-h-60 space-y-1 overflow-auto" role="listbox" aria-label="Employees">
          {options.map((e) => <button key={e.id} type="button" role="option" aria-selected={sel === e.id} onClick={() => setSel(e.id)} className={`block w-full rounded-md px-3 py-2 text-left text-sm ${sel === e.id ? 'bg-brand-50 text-brand-700' : 'hover:bg-subtle'}`}>{fullName(e)} <span className="text-ink-400">{e.employeeCode}</span></button>)}
          {!options.length && !isFetching && <p className="p-2 text-sm text-ink-500">No unlinked employees match.</p>}
        </div>
        {save.error && <p className="mt-2 text-sm text-danger-600">{save.error.message}</p>}
        <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!sel} loading={save.isPending} onClick={() => save.mutate({ employeeId: sel, biometricId: map.deviceUserId })}>Link</Button></div>
      </div>
    </div>
  );
}

function LogsDialog({ device, onClose, onDelete }) {
  const list = useList(`/devices/${device.id}/logs`, {});
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink-900/40 p-4" role="dialog" aria-modal="true" aria-label="Device sync log">
      <div className="flex max-h-[90dvh] w-full max-w-3xl flex-col rounded-lg bg-white shadow-pop">
        <div className="flex items-center justify-between border-b border-line p-5"><div><h2 className="font-semibold">{device.name}: sync log</h2><p className="text-xs text-ink-500">Connections, uploads and errors (kept 90 days)</p></div><Button variant="secondary" onClick={onClose}>Close</Button></div>
        <div className="flex-1 overflow-auto p-5">
          <DataTable loading={list.loading} rows={list.rows} meta={list.meta} onPage={list.page} empty={<EmptyState title="No activity yet" />} columns={[
            { key: 'createdAt', header: 'Time', render: (r) => dt(r.createdAt, true) }, { key: 'level', header: 'Level', render: (r) => <Badge tone={{ INFO: 'neutral', WARN: 'warning', ERROR: 'danger' }[r.level]}>{r.level.toLowerCase()}</Badge> },
            { key: 'message', header: 'Message' },
          ]} />
        </div>
        {onDelete && <div className="border-t border-line p-4 text-right">{confirm ? <><span className="mr-2 text-sm">Remove this device? Its punch history stays.</span><Button variant="danger" size="sm" onClick={onDelete}>Remove</Button></> : <Button variant="ghost" size="sm" onClick={() => setConfirm(true)}>Remove device…</Button>}</div>}
      </div>
    </div>
  );
}
