'use strict';

/**
 * Remote device configuration routes — Stage 1 (CSR) and Stage 2 (CSU/CSW)
 * of the LoRa_FieldOps_APRS_Tracker remote-config protocol. See
 * src/device-config.js for the wire protocol implementation; this layer
 * just validates the request and waits on the device's async reply before
 * responding, so the admin UI can treat each call as a normal request/response.
 */
const express = require('express');
const { requireRole } = require('../auth');
const deviceConfig = require('../device-config');

const router = express.Router({ mergeParams: true });

function respond(res, promise) {
  promise.then(
    result => res.json({ ok: true, data: result }),
    err => {
      const status = { BUSY: 409, TIMEOUT: 504, NO_TRANSPORT: 503 }[err.code] || 400;
      res.status(status).json({ ok: false, error: err.message, code: err.code || null });
    }
  );
}

router.get('/fields', requireRole('admin', 'operator'), (req, res) => {
  res.json({ ok: true, data: deviceConfig.FIELD_CODES });
});

router.post('/read', requireRole('admin', 'operator'), (req, res) => {
  const { callsign, codes } = req.body;
  if (!callsign) return res.status(400).json({ ok: false, error: 'callsign is required' });
  respond(res, deviceConfig.readFields(req.params.raceId, callsign, Array.isArray(codes) ? codes : undefined));
});

router.post('/unlock', requireRole('admin', 'operator'), (req, res) => {
  const { callsign, token } = req.body;
  if (!callsign || !token) return res.status(400).json({ ok: false, error: 'callsign and token are required' });
  respond(res, deviceConfig.unlock(req.params.raceId, callsign, token));
});

router.post('/write', requireRole('admin', 'operator'), (req, res) => {
  const { callsign, fields } = req.body;
  if (!callsign || !fields || typeof fields !== 'object' || !Object.keys(fields).length) {
    return res.status(400).json({ ok: false, error: 'callsign and fields are required' });
  }
  respond(res, deviceConfig.writeFields(req.params.raceId, callsign, fields));
});

module.exports = router;
