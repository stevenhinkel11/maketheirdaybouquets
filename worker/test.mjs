import { validateOrder, earliestDate, dateProblem, buildNote, normalizePhone } from './worker.js';
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
out(fail ? ('FAILED: ' + fail) : 'ALL PASSED');
