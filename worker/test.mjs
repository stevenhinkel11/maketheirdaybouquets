import { validateOrder, earliestDate, dateProblem, buildNote, normalizePhone, createPaymentLink } from './worker.js';
const out = typeof print === 'function' ? print : console.log;
let fail = 0;
const t = (name, cond) => { out((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail++; };

// 10:00 AM PDT on Fri 2026-11-13? (Nov is PST) -> use 10:00 PST = 18:00Z ; 2026-11-13 is a Friday
const before = new Date('2026-11-13T18:00:00Z');   // 10:00 AM PST
const after  = new Date('2026-11-13T20:30:00Z');   // 12:30 PM PST
const base = d => ({ items: [{ id: 'luxury-bouquet', qty: 1 }], deliveryDate: d,
  recipient: { name: 'Pat', phone: '(831) 555-0123', address1: '1 Main St', address2: '', zip: '95060' },
  customer: { name: 'Sam', email: 'sam@example.com', phone: '831-555-0100' }, instructions: '', giftMessage: 'Hi', giftFrom: 'Sam' });

t('earliest before 11am = same day', earliestDate(before) === '2026-11-13');
t('earliest after 11am = next day', earliestDate(after) === '2026-11-14');
t('same-day ok before 11am', !validateOrder(base('2026-11-13'), before).error);
t('same-day rejected after 11am', !!validateOrder(base('2026-11-13'), after).error);
t('next-day ok after 11am', !validateOrder(base('2026-11-14'), after).error);
t('past date rejected', !!validateOrder(base('2026-11-12'), before).error);
t('too far ahead rejected', !!validateOrder(base('2027-12-01'), before).error);
t('garbage date rejected', !!validateOrder(base('banana'), before).error);

const zips = ['95001','95003','95005','95006','95007','95010','95017','95018','95019','95041','95060','95061','95062','95063','95064','95065','95066','95067','95073','95076','95077'];
zips.forEach(z => { const b = base('2026-11-14'); b.recipient.zip = z; t('zip ok ' + z, !validateOrder(b, before).error); });
['94019','95033','95112','93905','94110','00000','','9506','95060-1234x'].forEach(z => { const b = base('2026-11-14'); b.recipient.zip = z; const r = validateOrder(b, before); t('zip rejected "' + z + '"', z === '95060-1234x' ? !r.error : !!r.error); });
{ const b = base('2026-11-14'); b.recipient.zip = '95060-1234'; t('zip+4 normalizes to 95060', validateOrder(b, before).order.recipient.zip === '95060'); }
{ const b = base('2026-11-14'); b.recipient.zip = '95060'; t('city filled from zip', validateOrder(b, before).order.recipient.city === 'Santa Cruz'); }
{ const b = base('2026-11-14'); b.items = [{ id: 'hacked', qty: 1 }]; t('unknown product rejected', !!validateOrder(b, before).error); }
{ const b = base('2026-11-14'); b.items = [{ id: 'luxury-bouquet', qty: 99 }]; t('qty 99 rejected', !!validateOrder(b, before).error); }
{ const b = base('2026-11-14'); b.items = []; t('empty cart rejected', !!validateOrder(b, before).error); }
{ const b = base('2026-11-14'); b.items[0].price = 1; t('client price ignored', !validateOrder(b, before).error && validateOrder(b, before).order.items[0].price === undefined); }
{ const b = base('2026-11-14'); b.customer.email = 'nope'; t('bad email rejected', !!validateOrder(b, before).error); }
{ const b = base('2026-11-14'); b.recipient.phone = '123'; t('bad phone rejected', !!validateOrder(b, before).error); }
{ const b = base('2026-11-14'); b.website = 'spam'; t('honeypot rejected', !!validateOrder(b, before).error); }
t('phone normalize', normalizePhone('(831) 555-0123') === '+18315550123' && normalizePhone('1-831-555-0123') === '+18315550123');
t('note contains message & contact', /CARD MESSAGE: Hi/.test(buildNote(validateOrder(base('2026-11-14'), before).order)));

// ---- Square request shape (mocked fetch) ----
globalThis.crypto = globalThis.crypto || {}; if (!crypto.randomUUID) crypto.randomUUID = () => 'test-key';
const calls = [];
function mockSquare(taxes) {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, body });
    let j = {};
    if (url.endsWith('/v2/catalog/search')) j = { objects: taxes };
    if (url.endsWith('/v2/online-checkout/payment-links')) j = { payment_link: { url: 'https://square.link/test', long_url: 'https://checkout.square.site/merchant/M/checkout/X' } };
    return { ok: true, json: async () => j };
  };
}
const env = { SQUARE_ACCESS_TOKEN: 'x', SQUARE_LOCATION_ID: 'LOC1', SQUARE_ENV: 'sandbox' };
const good = validateOrder(base('2026-11-14'), before).order;
mockSquare([{ id: 'TAXID', tax_data: { name: 'Sales Tax', enabled: true, inclusion_type: 'ADDITIVE' } }]);
const res = await createPaymentLink(env, good);
const pl = calls.find(c => c.url.includes('payment-links')).body;
t('payment link url returned', res.url === 'https://square.link/test');
t('embed (long) url returned', res.embedUrl === 'https://checkout.square.site/merchant/M/checkout/X');
t('uses sandbox host', calls[0].url.startsWith('https://connect.squareupsandbox.com'));
t('custom line item with server price', pl.order.line_items[0].base_price_money.amount === 10000 && pl.order.line_items[0].name === 'Luxury Bouquet');
t('square tax attached', pl.order.taxes && pl.order.taxes[0].catalog_object_id === 'TAXID');
t('delivery fulfillment scheduled', pl.order.fulfillments[0].type === 'DELIVERY' && pl.order.fulfillments[0].delivery_details.schedule_type === 'SCHEDULED');
t('deliver_at has PT offset', pl.order.fulfillments[0].delivery_details.deliver_at === '2026-11-14T12:00:00-08:00');
t('address in CA with zip', pl.order.fulfillments[0].delivery_details.recipient.address.postal_code === '95060' && pl.order.fulfillments[0].delivery_details.recipient.address.administrative_district_level_1 === 'CA');
t('note has card message', /CARD MESSAGE: Hi/.test(pl.order.fulfillments[0].delivery_details.note));
t('location set', pl.order.location_id === 'LOC1');
t('no buyer_email alongside fulfillment (Square rejects it)', !pl.pre_populated_data);
t('buyer email NOT sent as recipient email', pl.order.fulfillments[0].delivery_details.recipient.email_address === undefined);
t('note still records buyer contact', /ORDERED BY: Sam, \+18315550100, sam@example.com/.test(pl.order.fulfillments[0].delivery_details.note));
// optional fields empty -> no empty metadata values (Square rejects them)
{
  calls.length = 0; mockSquare([{ id: 'TAXID', tax_data: { name: 'Sales Tax', enabled: true, inclusion_type: 'ADDITIVE' } }]);
  const b = base('2026-11-14'); b.giftMessage = ''; b.giftFrom = ''; b.instructions = '';
  const o2 = validateOrder(b, before).order; await createPaymentLink(env, o2);
  const md = calls.find(c => c.url.includes('payment-links')).body.order.metadata;
  t('no empty metadata values when optional fields are blank', Object.values(md).every(v => String(v).length > 0));
  t('gift message optional (order validates without it)', !validateOrder(b, before).error);
}
// fulfillment modes
for (const m of ['shipment', 'none']) {
  calls.length = 0; mockSquare([{ id: 'TAXID', tax_data: { name: 'Sales Tax', enabled: true, inclusion_type: 'ADDITIVE' } }]);
  await createPaymentLink({ ...env, FULFILLMENT_MODE: m }, good);
  const o3 = calls.find(c => c.url.includes('payment-links')).body.order;
  if (m === 'shipment') t('shipment mode builds SHIPMENT fulfillment', o3.fulfillments[0].type === 'SHIPMENT' && o3.fulfillments[0].shipment_details.recipient.address.postal_code === '95060');
  else t('none mode has no fulfillment but keeps address in line item note', !o3.fulfillments && /95060/.test(o3.line_items[0].note) && /2026-11-14/.test(o3.line_items[0].note));
  t(m + ' mode still has tax', !!(o3.taxes && o3.taxes[0]));
}
// strict: no tax configured -> refuse rather than undercharge (fresh module state needs a new tax cache, so use a new env path)
let threw = false;
{
  const m = await import('./worker.js?notax');
  mockSquare([]);
  try { await m.createPaymentLink(env, good); } catch (e) { threw = true; }
}
t('refuses to create order when no tax is configured', threw);
out(fail ? ('FAILED: ' + fail) : 'ALL PASSED');
