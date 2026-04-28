'use strict';
const CHANNELS = ['mqtt', 'aprs', 'race', 'system', 'console'];
const MAX_ENTRIES = 1000;
const store = new Map(CHANNELS.map(c => [c, []]));
let _wsManager = null;
let _seq = 0;

function setWs(ws) { _wsManager = ws; }

function log(channel, level, msg) {
  const ch = CHANNELS.includes(channel) ? channel : 'system';
  const entry = { id: ++_seq, ts: Math.floor(Date.now() / 1000), channel: ch, level, msg };
  const arr = store.get(ch);
  arr.push(entry);
  if (arr.length > MAX_ENTRIES) arr.splice(0, arr.length - MAX_ENTRIES);
  if (_wsManager) {
    try { _wsManager.broadcastToRole(['admin'], { type: 'log_entry', data: entry }); } catch {}
  }
  return entry;
}

function getLogs(channel, limit = 200) {
  if (!channel || channel === 'all') {
    const all = [];
    for (const arr of store.values()) all.push(...arr);
    all.sort((a, b) => a.id - b.id);
    return all.slice(-limit);
  }
  const arr = store.get(channel) || [];
  return arr.slice(-limit);
}

module.exports = { log, getLogs, setWs, CHANNELS };
