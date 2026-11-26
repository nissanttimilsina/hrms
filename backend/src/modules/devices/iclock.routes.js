/**
 * Device-facing endpoint for biometric terminals (ADMS / PUSH protocol). Mounted at /iclock, outside /api.
 * Plain-text protocol, no cookies or tokens: devices are identified by serial number (see services/biometric/adms.js).
 */
import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authorise, touch, handshakeOptions, ingestAttlog, ingestUsers, deviceLog } from '../../services/biometric/adms.js';
import { logger } from '../../utils/logger.js';

export function iclockRouter() {
  const r = Router();
  r.use(express.text({ type: () => true, limit: '2mb' }));
  r.use(rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: false, legacyHeaders: false, message: 'Too many requests' }));
  const text = (res, status, body) => res.status(status).type('text/plain').send(body);

  const guard = async (req, res) => {
    const sn = String(req.query.SN ?? req.query.sn ?? '');
    const a = await authorise(sn, req.ip);
    if (!a.device) { text(res, a.status, a.reason); return null; }
    await touch(a.device, req.ip, req.query);
    return a;
  };

  // Handshake / options and data uploads (some firmwares append .aspx)
  r.get(['/cdata', '/cdata.aspx'], async (req, res) => {
    try {
      const a = await guard(req, res); if (!a) return;
      if (req.query.options) await deviceLog(a.device, 'INFO', 'handshake', 'Device connected and requested settings', { pushver: req.query.pushver ?? null });
      return text(res, 200, req.query.options ? handshakeOptions(a.device.serialNumber) : 'OK');
    } catch (err) { logger.error({ err }, 'iclock handshake failed'); return text(res, 500, 'ERROR'); }
  });

  r.post(['/cdata', '/cdata.aspx'], async (req, res) => {
    let a;
    try {
      a = await guard(req, res); if (!a) return;
      const table = String(req.query.table ?? '').toUpperCase();
      const body = typeof req.body === 'string' ? req.body : '';
      if (table === 'ATTLOG') {
        const c = await ingestAttlog(a.device, body, a.tz);
        return text(res, 200, `OK: ${c.received}`);
      }
      if (table === 'OPERLOG' || table === 'USERINFO') {
        await ingestUsers(a.device, body);
        return text(res, 200, `OK: ${body.split(/\r?\n/).filter(Boolean).length}`);
      }
      // ATTPHOTO, BIODATA, FINGERTMP, FACE …: biometric data is deliberately not stored.
      return text(res, 200, `OK: ${body.split(/\r?\n/).filter(Boolean).length}`);
    } catch (err) {
      logger.error({ err }, 'iclock upload failed');
      if (a?.device) await deviceLog(a.device, 'ERROR', 'upload_failed', `Upload could not be processed: ${err.message}`.slice(0, 300));
      return text(res, 500, 'ERROR'); // device keeps the data and retries
    }
  });

  r.get(['/getrequest', '/getrequest.aspx'], async (req, res) => {
    try { const a = await guard(req, res); if (!a) return; return text(res, 200, 'OK'); } catch (err) { logger.error({ err }, 'iclock poll failed'); return text(res, 500, 'ERROR'); }
  });
  r.post(['/devicecmd', '/devicecmd.aspx'], async (req, res) => {
    try { const a = await guard(req, res); if (!a) return; return text(res, 200, 'OK'); } catch (err) { logger.error({ err }, 'iclock devicecmd failed'); return text(res, 500, 'ERROR'); }
  });
  r.use((_req, res) => text(res, 404, 'Not found'));
  return r;
}
