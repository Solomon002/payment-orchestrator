import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockGateway, signWebhook, type MockGateway } from './gateway';

const SECRET = 's'.repeat(40);
const CONTROL = 'c'.repeat(40);
let gw: MockGateway;

function make() {
  gw = createMockGateway({
    name: 'mockpay-test',
    secret: SECRET,
    controlKey: CONTROL,
    webhookUrl: 'http://127.0.0.1:9/never', // nothing listens; deliveries just fail
    publicUrl: 'http://localhost:0',
    feeBps: 150,
    feeCapKobo: 200_000,
    webhookRetries: 0,
  });
  gw.control.latencyMs = 0;
  return gw;
}

const charge = { reference: 'ref_1', amountKobo: 100_000, email: 'a@b.co', method: 'card' };

describe('mock gateway', () => {
  afterEach(() => gw?.close());

  it('requires the secret key for the charge API', async () => {
    const { app } = make();
    expect((await request(app).post('/charges').send(charge)).status).toBe(401);
  });

  it('creates a pending charge and is idempotent on reference', async () => {
    const { app } = make();
    const a = await request(app).post('/charges').set('authorization', `Bearer ${SECRET}`).send(charge);
    const b = await request(app).post('/charges').set('authorization', `Bearer ${SECRET}`).send(charge);
    expect(a.status).toBe(200);
    expect(a.body.status).toBe('pending');
    expect(b.body.gatewayReference).toBe(a.body.gatewayReference);
  });

  it('simulates a per-method outage', async () => {
    const { app } = make();
    await request(app).put('/control').set('x-control-key', CONTROL).send({ methodOutages: { bank_transfer: true } });
    const bank = await request(app).post('/charges').set('authorization', `Bearer ${SECRET}`).send({ ...charge, method: 'bank_transfer' });
    const card = await request(app).post('/charges').set('authorization', `Bearer ${SECRET}`).send({ ...charge, reference: 'ref_2' });
    expect(bank.status).toBe(503);
    expect(card.status).toBe(200);
  });

  it('simulates a single-bank outage with a distinct error code', async () => {
    const { app } = make();
    await request(app).put('/control').set('x-control-key', CONTROL).send({ bankOutages: ['058'] });
    const gtb = await request(app).post('/charges').set('authorization', `Bearer ${SECRET}`).send({ ...charge, method: 'bank_transfer', bankCode: '058' });
    const zenith = await request(app).post('/charges').set('authorization', `Bearer ${SECRET}`).send({ ...charge, method: 'bank_transfer', reference: 'ref_3', bankCode: '057' });
    const gtbCard = await request(app).post('/charges').set('authorization', `Bearer ${SECRET}`).send({ ...charge, reference: 'ref_4', bankCode: '058' });
    expect(gtbCard.status).toBe(200); // cards from the same bank still work
    expect(gtb.status).toBe(503);
    expect(gtb.body.error).toBe('bank_unavailable');
    expect(zenith.status).toBe(200);
  });

  it('rejects invalid control updates', async () => {
    const { app } = make();
    const res = await request(app).put('/control').set('x-control-key', CONTROL).send({ failureRate: 500 });
    expect(res.status).toBe(400);
  });

  it('signs webhooks with HMAC-SHA512 of the raw body', () => {
    const sig = signWebhook('secret', '{"a":1}');
    expect(sig).toMatch(/^[0-9a-f]{128}$/);
    expect(signWebhook('secret', '{"a":1}')).toBe(sig);
    expect(signWebhook('secret', '{"a":2}')).not.toBe(sig);
  });
});
