'use strict';

jest.mock('../../src/mqtt-client', () => ({
  connectFromSettings: jest.fn(),
  setWs: jest.fn(),
  invalidateRouteCache: jest.fn(),
  getStatus: jest.fn(() => ({ connected: false })),
  auditMissedStations: jest.fn(),
}));

const mockAprs = {
  setMessagingCallsign: jest.fn(),
  connectFromSettings: jest.fn(),
  disconnect: jest.fn(),
  // verified mirrors isConnected by default, matching a healthy login — tests
  // for the unverified case override this explicitly.
  getStatus: jest.fn(() => ({ connected: mockAprs.isConnected(), verified: mockAprs.isConnected() })),
  setWs: jest.fn(),
  notifyRosterChange: jest.fn(),
  refreshFilter: jest.fn(),
  previewFilter: jest.fn(() => ''),
  isConnected: jest.fn(() => false),
  sendMessage: jest.fn(),
};
jest.mock('../../src/aprs-client', () => mockAprs);

const mockTnc = {
  getConnectedRaceIds: jest.fn(() => []),
  sendMessage: jest.fn(),
};
jest.mock('../../src/local-tnc', () => mockTnc);

jest.mock('../../src/websocket', () => ({
  broadcast: jest.fn(),
  broadcastToRole: jest.fn(),
  broadcastToRace: jest.fn(),
  init: jest.fn(),
}));

const request = require('supertest');
const { createApp } = require('../helpers/testApp');
const deviceConfig = require('../../src/device-config');

describe('Device Config API', () => {
  let app, admin, raceId;

  beforeAll(async () => {
    app = createApp();
    admin = request.agent(app);
    await admin.post('/api/auth/login').send({ username: 'admin', password: 'admin' });
    const r = await admin.post('/api/races').send({ name: 'DC Race', date: '2026-09-01' });
    raceId = r.body.data.id;
  });

  beforeEach(() => {
    mockAprs.isConnected.mockReturnValue(false);
    mockAprs.sendMessage.mockClear();
    mockTnc.getConnectedRaceIds.mockReturnValue([]);
    mockTnc.sendMessage.mockClear();
  });

  test('unauthenticated requests are rejected', async () => {
    const res = await request(app).post(`/api/races/${raceId}/device-config/read`).send({ callsign: 'KJ7NYE-9' });
    expect(res.status).toBe(401);
  });

  test('read fails with 503 when no transport is available', async () => {
    const res = await admin.post(`/api/races/${raceId}/device-config/read`).send({ callsign: 'KJ7NYE-9' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('NO_TRANSPORT');
  });

  test('read fails fast (not a 20s timeout) when APRS-IS is connected but unverified', async () => {
    // A bad/unmatched passcode still lets the TCP connection open and receive,
    // but the server silently drops everything we transmit — this must be
    // treated the same as "no transport" rather than attempted and hung.
    mockAprs.isConnected.mockReturnValue(true);
    mockAprs.getStatus.mockReturnValueOnce({ connected: true, verified: false });
    const res = await admin.post(`/api/races/${raceId}/device-config/read`).send({ callsign: 'KJ7NYE-9' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('NO_TRANSPORT');
    expect(res.body.error).toMatch(/unverified/i);
    expect(mockAprs.sendMessage).not.toHaveBeenCalled();
  });

  test('read resolves with parsed fields once the device replies', async () => {
    mockAprs.isConnected.mockReturnValue(true);
    const pending = new Promise((resolve, reject) => {
      admin.post(`/api/races/${raceId}/device-config/read`).send({ callsign: 'KJ7NYE-9' })
        .end((err, r) => err ? reject(err) : resolve(r));
    });
    await new Promise(r => setTimeout(r, 20));
    deviceConfig.handleInboundReply('KJ7NYE-9', 'CS RO=2 TC=BASE1 BR=15');
    const res = await pending;

    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe('READ');
    expect(res.body.data.fields).toEqual({ RO: '2', TC: 'BASE1', BR: '15' });
    expect(mockAprs.sendMessage).toHaveBeenCalledWith('KJ7NYE-9', 'CSR', expect.any(Number));
  });

  test('a second command while one is in flight is rejected as busy', async () => {
    mockAprs.isConnected.mockReturnValue(true);
    const first = new Promise((resolve, reject) => {
      admin.post(`/api/races/${raceId}/device-config/read`).send({ callsign: 'KJ7NYE-9' })
        .end((err, r) => err ? reject(err) : resolve(r));
    });
    await new Promise(r => setTimeout(r, 20));

    const second = await admin.post(`/api/races/${raceId}/device-config/unlock`).send({ callsign: 'KJ7NYE-9', token: 'secret' });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('BUSY');

    deviceConfig.handleInboundReply('KJ7NYE-9', 'CS RO=2');
    await first;
  });

  test('a rejected unlock token is surfaced without any retry', async () => {
    mockAprs.isConnected.mockReturnValue(true);
    const pending = new Promise((resolve, reject) => {
      admin.post(`/api/races/${raceId}/device-config/unlock`).send({ callsign: 'KJ7NYE-9', token: 'wrong' })
        .end((err, r) => err ? reject(err) : resolve(r));
    });
    await new Promise(r => setTimeout(r, 20));
    deviceConfig.handleInboundReply('KJ7NYE-9', 'CS ERR BADTOKEN');
    const res = await pending;

    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe('ERR');
    expect(res.body.data.code).toBe('BADTOKEN');
    expect(mockAprs.sendMessage).toHaveBeenCalledTimes(1); // no auto-retry
  });

  test('a successful write with REBOOT is echoed back to the caller', async () => {
    mockAprs.isConnected.mockReturnValue(true);
    const pending = new Promise((resolve, reject) => {
      admin.post(`/api/races/${raceId}/device-config/write`).send({ callsign: 'KJ7NYE-9', fields: { RO: 2 } })
        .end((err, r) => err ? reject(err) : resolve(r));
    });
    await new Promise(r => setTimeout(r, 20));
    deviceConfig.handleInboundReply('KJ7NYE-9', 'CS OK RO=2 REBOOT=5');
    const res = await pending;

    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe('OK');
    expect(res.body.data.fields).toEqual({ RO: '2' });
    expect(res.body.data.reboot).toBe(5);
    expect(mockAprs.sendMessage).toHaveBeenCalledWith('KJ7NYE-9', 'CSW RO=2', expect.any(Number));
  });

  test('write requires callsign and at least one field', async () => {
    const res = await admin.post(`/api/races/${raceId}/device-config/write`).send({ callsign: 'KJ7NYE-9' });
    expect(res.status).toBe(400);
  });
});
