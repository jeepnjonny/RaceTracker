'use strict';

/**
 * Remote device configuration over the APRS directed-message CSR/CSU/CSW
 * protocol implemented by KJ7NYE/LoRa_FieldOps_APRS_Tracker (PR #38).
 *
 * Sends commands via the existing APRS-IS / local-TNC transports (same
 * "flood to every available path" approach messages.js uses for chat) and
 * resolves the device's asynchronous "CS ..." reply back to the request
 * that triggered it.
 *
 * Only one command may be in flight at a time, system-wide. This isn't just
 * a simplification: the device replies FROM its real callsign even when we
 * addressed it BY tactical name, so there is no reliable key to correlate a
 * reply back to a specific outstanding request other than "the next CS ...
 * message we see is the answer to the one command we just sent."
 */
const db     = require('./db');
const logger = require('./logger');

const FIELD_CODES = {
  RO: { label: 'Device role',            type: 'enum',  values: { 0: 'Tracker', 1: 'iGate', 2: 'Digipeater' } },
  TC: { label: 'Tactical callsign/name', type: 'string' },
  SY: { label: 'Symbol',                 type: 'string' },
  BP: { label: 'Beacon path',            type: 'string' },
  DM: { label: 'Digi mode',              type: 'enum',  values: { 0: 'Off', 1: 'WIDE1 fill-in', 2: 'WIDE1+WIDE2 infrastructure' } },
  BR: { label: 'Beacon rate (min)',      type: 'int',   min: 1,    max: 1440 },
  GS: { label: 'GPS source',             type: 'enum',  values: { 0: 'Internal GPS', 1: 'Fixed position', 2: 'None' } },
  LA: { label: 'Fixed latitude',         type: 'float', min: -90,  max: 90 },
  LO: { label: 'Fixed longitude',        type: 'float', min: -180, max: 180 },
  EL: { label: 'Fixed elevation (m)',    type: 'float', min: -500, max: 9000 },
};

const COMMAND_TIMEOUT_MS = 20_000; // ack + CS reply round trip

let _pendingCommand = null; // { targetCallsign, resolve, reject, timer }

function _err(message, code) {
  return Object.assign(new Error(message), { code });
}

// Called from aprs-client.js / local-tnc.js whenever a directed message
// addressed to us arrives, before it's logged as an ordinary chat message.
// Returns true if the text was consumed as a device-config reply.
function handleInboundReply(fromCall, text) {
  if (!_pendingCommand || typeof text !== 'string' || !text.startsWith('CS ')) return false;
  const { resolve, timer } = _pendingCommand;
  clearTimeout(timer);
  _pendingCommand = null;
  try {
    resolve({ fromCall, ...parseCsReply(text) });
  } catch (e) {
    logger.log('device-config', 'error', `parseCsReply failed: ${e.message}`);
  }
  return true;
}

function _parseFieldPairs(str) {
  const out = {};
  for (const tok of str.split(/\s+/).filter(Boolean)) {
    const eq = tok.indexOf('=');
    if (eq < 0) continue;
    out[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return out;
}

function parseCsReply(text) {
  const body = text.slice(3).trim(); // strip leading "CS "

  if (body === 'ERR' || body.startsWith('ERR ')) {
    const [, code, detail] = body.split(/\s+/);
    return { type: 'ERR', code: code || null, detail: detail || null, raw: text };
  }
  if (body.startsWith('UNLOCKED')) {
    const secs = parseInt(body.split(/\s+/)[1], 10);
    return { type: 'UNLOCKED', secondsRemaining: Number.isFinite(secs) ? secs : null, raw: text };
  }
  if (body.startsWith('OK')) {
    const fields = _parseFieldPairs(body.slice(2).trim());
    const reboot = fields.REBOOT != null ? parseInt(fields.REBOOT, 10) : null;
    delete fields.REBOOT;
    return { type: 'OK', fields, reboot, raw: text };
  }
  // Full/selective read reply: space-separated CODE=value pairs
  return { type: 'READ', fields: _parseFieldPairs(body), raw: text };
}

// Sends the directed message over every transport that can currently reach
// the node, mirroring messages.js's APRS send path — restricted to TNCs
// registered to this specific race, since a TNC identifies outbound packets
// with that race's tactical callsign (sending via another race's TNC would
// have the device replying to a callsign we're not listening as).
function _sendDirected(raceId, targetCallsign, text) {
  const aprsClient = require('./aprs-client');
  const localTnc   = require('./local-tnc');

  const aprsConnected = aprsClient.isConnected();
  const tncRaceIds    = localTnc.getConnectedRaceIds().filter(id => String(id) === String(raceId));
  if (!aprsConnected && tncRaceIds.length === 0) {
    throw _err('No APRS path available: APRS-IS not connected and no local TNC active for this race', 'NO_TRANSPORT');
  }

  const race = db.prepare('SELECT tactical_callsign FROM races WHERE id=?').get(raceId);
  const ts = Math.floor(Date.now() / 1000);
  const result = db.prepare(`
    INSERT INTO messages (race_id, direction, from_node_id, from_name, to_node_id, text, timestamp, status)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(raceId, 'out', race?.tactical_callsign || null, 'device-config', targetCallsign, text, ts, 'queued');
  const messageId = result.lastInsertRowid;

  if (aprsConnected) aprsClient.sendMessage(targetCallsign, text, messageId);
  for (const rId of tncRaceIds) localTnc.sendMessage(rId, { toCallsign: targetCallsign, text, messageId });
}

function _runCommand(raceId, targetCallsign, commandText) {
  if (_pendingCommand) {
    return Promise.reject(_err('Another device-config command is already in progress — wait for it to finish', 'BUSY'));
  }
  return new Promise((resolve, reject) => {
    try {
      _sendDirected(raceId, targetCallsign, commandText);
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => {
      _pendingCommand = null;
      reject(_err('No response from node', 'TIMEOUT'));
    }, COMMAND_TIMEOUT_MS);
    _pendingCommand = { targetCallsign: targetCallsign.toUpperCase().trim(), resolve, reject, timer };
  });
}

function readFields(raceId, targetCallsign, codes) {
  const cmd = codes && codes.length ? `CSR ${codes.join(',')}` : 'CSR';
  return _runCommand(raceId, targetCallsign, cmd);
}

function unlock(raceId, targetCallsign, token) {
  return _runCommand(raceId, targetCallsign, `CSU ${token}`);
}

function writeFields(raceId, targetCallsign, fields) {
  const pairs = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(',');
  return _runCommand(raceId, targetCallsign, `CSW ${pairs}`);
}

module.exports = { FIELD_CODES, readFields, unlock, writeFields, handleInboundReply, parseCsReply };
