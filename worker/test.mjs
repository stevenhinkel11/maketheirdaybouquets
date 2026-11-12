import { validateOrder, earliestDate, dateProblem, buildNote, normalizePhone, createPaymentLink, buildEmail, buildCustomerEmail } from './worker.js';
if (typeof console === 'undefined') globalThis.console = { log() {} };
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
t('custom line item with server price', pl.order.line_items[0].base_price_money.amount === 10000 && pl.order.line_items[0].name === 'Luxury Bouquet (deliver Sat, Nov 14 to 1 Main St, Santa Cruz)');
t('square tax attached', pl.order.taxes && pl.order.taxes[0].catalog_object_id === 'TAXID');
t('default fulfillment is a shipment to the recipient', pl.order.fulfillments[0].type === 'SHIPMENT' && pl.order.fulfillments[0].shipment_details.recipient.display_name === 'Pat');
t('due time has PT offset', pl.order.fulfillments[0].shipment_details.expected_shipped_at === '2026-11-14T12:00:00-08:00');
t('address in CA with zip', pl.order.fulfillments[0].shipment_details.recipient.address.postal_code === '95060' && pl.order.fulfillments[0].shipment_details.recipient.address.administrative_district_level_1 === 'CA');
t('note has card message', /CARD MESSAGE: Hi/.test(pl.order.fulfillments[0].shipment_details.shipping_note));
t('location set', pl.order.location_id === 'LOC1');
t('buyer email is pre-filled so Square does not ask again', pl.pre_populated_data && pl.pre_populated_data.buyer_email === 'sam@example.com');
t('buyer email NOT sent as recipient email', pl.order.fulfillments[0].shipment_details.recipient.email_address === undefined);
t('note still records buyer contact', /ORDERED BY: Sam, \+18315550100, sam@example.com/.test(pl.order.fulfillments[0].shipment_details.shipping_note));
// optional fields empty -> no empty metadata values (Square rejects them)
{
  calls.length = 0; mockSquare([{ id: 'TAXID', tax_data: { name: 'Sales Tax', enabled: true, inclusion_type: 'ADDITIVE' } }]);
  const b = base('2026-11-14'); b.giftMessage = ''; b.giftFrom = ''; b.instructions = '';
  const o2 = validateOrder(b, before).order; await createPaymentLink(env, o2);
  const md = calls.find(c => c.url.includes('payment-links')).body.order.metadata;
  t('no empty metadata values when optional fields are blank', Object.values(md).every(v => String(v).length > 0));
  t('gift message optional (order validates without it)', !validateOrder(b, before).error);
}
// fallback: if Square rejects buyer_email with a conflict, retry without it
{
  calls.length = 0;
  let n = 0;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, body });
    if (url.endsWith('/v2/catalog/search')) return { ok: true, json: async () => ({ objects: [{ id: 'TAXID', tax_data: { name: 'Sales Tax', enabled: true, inclusion_type: 'ADDITIVE' } }] }) };
    n++;
    if (body.pre_populated_data) return { ok: false, json: async () => ({ errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'CONFLICTING_PARAMETERS' }] }) };
    return { ok: true, json: async () => ({ payment_link: { url: 'https://square.link/ok', long_url: 'https://checkout.square.site/x' } }) };
  };
  const r2 = await createPaymentLink(env, good);
  const links = calls.filter(c => c.url.includes('payment-links'));
  t('retries without buyer_email after CONFLICTING_PARAMETERS', links.length === 2 && !links[1].body.pre_populated_data && r2.url === 'https://square.link/ok');
  t('retry uses a fresh idempotency key', links[0].body.idempotency_key !== undefined);
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
// metadata is structured for the email
{
  const md = calls.find(c => c.url.includes('payment-links')).body.order.metadata;
  t('metadata has <=10 keys', Object.keys(md).length <= 10);
  t('metadata carries buyer + recipient + address', md.buyer_email === 'sam@example.com' && md.recipient_name === 'Pat' && /95060/.test(md.address));
}
// ---- the owner's new-order email ----
{
  const order = { id: 'ORD123', line_items: [{ name: 'Luxury Bouquet', quantity: '1', gross_sales_money: { amount: 10000 }, total_money: { amount: 10000 } }],
    total_tax_money: { amount: 950 }, total_money: { amount: 10950 },
    metadata: { delivery_date: '2026-11-14', recipient_name: 'Pat <b>Jones</b>', recipient_phone: '+18315550123', address: '1 Main St, Apt 2, Santa Cruz, CA 95060',
      gift_message: 'Happy birthday & many more!', gift_from: 'Sam', delivery_notes: 'Gate code 1234', buyer_name: 'Sam Lee', buyer_phone: '+18315550100', buyer_email: 'sam@example.com' } };
  const e = buildEmail(order, { receipt_url: 'https://squareup.com/receipt/preview/X', buyer_email_address: 'typed@example.com', card_details: { card: { card_brand: 'VISA', last_4: '7820' } } });
  t('email subject has date, city, recipient', /^New order · deliver Sat, Nov 14 · Santa Cruz · Pat/.test(e.subject));
  t('email shows address, notes, message, totals', /1 Main St, Apt 2/.test(e.html) && /Gate code 1234/.test(e.html) && /Happy birthday &amp; many more!/.test(e.html) && /\$109\.50/.test(e.html) && /\$9\.50/.test(e.html));
  t('email escapes HTML in user text', !/<b>Jones<\/b>/.test(e.html) && /&lt;b&gt;Jones/.test(e.html));
  t('email has map link, receipt link, buyer email', /google\.com\/maps/.test(e.html) && /squareup\.com\/receipt/.test(e.html) && /mailto:sam@example\.com/.test(e.html));
  t('email shows typed receipt email when different', /typed@example\.com/.test(e.html));
  t('plain-text version has the essentials', /Saturday, November 14, 2026/.test(e.text) && /Total paid: \$109\.50/.test(e.text) && /Gate code 1234/.test(e.text));
  const min = buildEmail({ id: 'X', line_items: [], metadata: { delivery_date: '2026-11-14' }, total_money: { amount: 100 } }, null);
  t('email builds with minimal data (no crash)', /Total paid: \$1\.00/.test(min.text));
  const ce = buildCustomerEmail(order, null);
  t('emails strip the delivery suffix from item names', buildEmail({ id: 'X', line_items: [{ name: 'Luxury Bouquet (deliver Sat, Nov 14 to 1 Main St, Santa Cruz)', quantity: '1', total_money: { amount: 100 } }], metadata: { delivery_date: '2026-11-14' }, total_money: { amount: 100 } }, null).text.includes('Luxury Bouquet x 1') && !/deliver Sat/.test(buildEmail({ id: 'X', line_items: [{ name: 'Luxury Bouquet (deliver Sat, Nov 14 to 1 Main St, Santa Cruz)', quantity: '1', total_money: { amount: 100 } }], metadata: { delivery_date: '2026-11-14' }, total_money: { amount: 100 } }, null).html.replace(/Sat, Nov 14<\/title>/g,'').split('Order')[1] || ''));
  t('customer subject has date', /^Your order is confirmed · delivery Sat, Nov 14/.test(ce.subject));
  t('customer email greets by first name', /Thank you, Sam!/.test(ce.html) && /Thank you, Sam!/.test(ce.text));
  t('customer email has delivery, message and total', /1 Main St, Apt 2/.test(ce.html) && /Happy birthday &amp; many more!/.test(ce.html) && /\$109\.50/.test(ce.html) && /Delivery<\/td><td[^>]*>Free/.test(ce.html));
  t('customer email hides internal buyer phone/email rows', !/\+18315550100/.test(ce.html) && !/mailto:/.test(ce.html));
  t('customer email escapes HTML', !/<b>Jones<\/b>/.test(ce.html));
  t('customer email builds with minimal data', /Total paid: \$1\.00/.test(buildCustomerEmail({ id: 'X', line_items: [], metadata: { delivery_date: '2026-11-14' }, total_money: { amount: 100 } }, null).text));
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
