/**
 * Make Their Day Bouquets: checkout function (Cloudflare Worker)
 *
 * POST /checkout  → validates the order, creates a Square Payment Link (with delivery details), returns { url }.
 * The browser then sends the customer to Square to pay. Square emails the receipt and records the full order
 * (items, recipient, address, delivery date, gift message, instructions) in the Square Dashboard.
 *
 * Secrets / vars (see README.md): SQUARE_ACCESS_TOKEN (secret), SQUARE_LOCATION_ID, SQUARE_ENV, SITE_URL, ALLOWED_ORIGINS
 * Prices live HERE, never trust prices sent by the browser.
 */

const PRODUCTS = {
  "luxury-bouquet": {
    name: "Luxury Bouquet",
    price: 10000                  // cents. Products live on the website; you do NOT need to create them in Square.
    // Optional: add  squareName: "Item name in Square"  to use an existing Square catalog item instead.
  },
  "test-bouquet": { name: "Test Bouquet ($1 test)", price: 100 }   // TEMPORARY: live end-to-end test, remove afterwards
};

// Every ZIP that serves addresses in Santa Cruz County, CA. Keep in sync with js/shop.js.
const ZIPS = {
  "95001": "Aptos", "95003": "Aptos", "95005": "Ben Lomond", "95006": "Boulder Creek", "95007": "Brookdale",
  "95010": "Capitola", "95017": "Davenport", "95018": "Felton", "95019": "Freedom", "95041": "Mount Hermon",
  "95060": "Santa Cruz", "95061": "Santa Cruz", "95062": "Santa Cruz", "95063": "Santa Cruz", "95064": "Santa Cruz",
  "95065": "Santa Cruz", "95066": "Scotts Valley", "95067": "Scotts Valley", "95073": "Soquel",
  "95076": "Watsonville", "95077": "Watsonville"
};

const RULES = {
  cutoffHour: 11,                       // before 11:00 AM Pacific = same-day delivery allowed
  maxDaysAhead: 120,
  deliveryDays: [0, 1, 2, 3, 4, 5, 6],  // 0 = Sunday
  closedDates: []                       // e.g. ["2026-12-25"]
};

/* ---------- pure helpers (also unit-tested) ---------- */
function ptParts(now) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const g = t => parts.find(p => p.type === t).value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hour: +g("hour") };
}
const addDays = (ymd, n) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function earliestDate(now) { const p = ptParts(now); return p.hour < RULES.cutoffHour ? p.date : addDays(p.date, 1); }
function dateProblem(ymd, now) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || "") || isNaN(new Date(ymd + "T12:00:00Z"))) return "Please choose a valid delivery date.";
  if (ymd < earliestDate(now)) return "That delivery date is too soon. Same-day delivery requires ordering before 11:00 AM Pacific.";
  if (ymd > addDays(ptParts(now).date, RULES.maxDaysAhead)) return "That delivery date is too far ahead.";
  if (RULES.closedDates.includes(ymd)) return "We are not delivering on that date.";
  if (!RULES.deliveryDays.includes(new Date(ymd + "T12:00:00Z").getUTCDay())) return "We do not deliver on that day.";
  return "";
}
const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
const digits = v => String(v || "").replace(/\D/g, "");
function normalizePhone(v) { let d = digits(v); if (d.length === 11 && d[0] === "1") d = d.slice(1); return d.length === 10 ? "+1" + d : ""; }

/** Validates the browser payload. Returns { error } or { order } (a cleaned, trusted object). */
function validateOrder(b, now = new Date()) {
  if (!b || typeof b !== "object") return { error: "Invalid request." };
  if (b.website) return { error: "Invalid request." }; // honeypot
  const items = [];
  for (const it of Array.isArray(b.items) ? b.items : []) {
    const p = PRODUCTS[it && it.id]; const qty = Math.floor(Number(it && it.qty));
    if (!p || !(qty >= 1 && qty <= 10)) return { error: "Your cart contains an item we couldn't recognize. Please refresh and try again." };
    const ex = items.find(x => x.id === it.id); if (ex) ex.qty += qty; else items.push({ id: it.id, qty });
  }
  if (!items.length || items.some(i => i.qty > 10)) return { error: "Your cart is empty or has too many of one item." };

  const r = b.recipient || {}, c = b.customer || {};
  const zip = clean(r.zip, 10).slice(0, 5);
  if (!ZIPS[zip]) return { error: "Sorry, we only deliver within Santa Cruz County, CA. That ZIP code is outside our delivery area." };
  const dp = dateProblem(clean(b.deliveryDate, 10), now); if (dp) return { error: dp };
  const rname = clean(r.name, 80), address1 = clean(r.address1, 120);
  if (!rname) return { error: "Please enter the recipient's name." };
  if (!address1) return { error: "Please enter the delivery address." };
  const rphone = normalizePhone(r.phone); if (!rphone) return { error: "Please enter a valid recipient phone number." };
  const cname = clean(c.name, 80); if (!cname) return { error: "Please enter your name." };
  const cemail = clean(c.email, 120); if (!/^\S+@\S+\.\S+$/.test(cemail)) return { error: "Please enter a valid email address." };
  const cphone = normalizePhone(c.phone); if (!cphone) return { error: "Please enter a valid phone number for you." };

  return { order: {
    items, deliveryDate: clean(b.deliveryDate, 10),
    recipient: { name: rname, phone: rphone, address1, address2: clean(r.address2, 80), zip, city: ZIPS[zip] },
    customer: { name: cname, email: cemail, phone: cphone },
    instructions: clean(b.instructions, 200), giftMessage: clean(b.giftMessage, 250), giftFrom: clean(b.giftFrom, 60)
  } };
}

/* ---------- Square ---------- */
function ptOffset(ymd) { // "-08:00" or "-07:00" for that date in Pacific time
  const s = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "shortOffset" }).formatToParts(new Date(ymd + "T20:00:00Z")).find(p => p.type === "timeZoneName").value;
  const h = parseInt(s.replace("GMT", ""), 10) || -8;
  return (h < 0 ? "-" : "+") + String(Math.abs(h)).padStart(2, "0") + ":00";
}
const squareBase = env => env.SQUARE_ENV === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
async function sq(env, path, body) {
  const r = await fetch(squareBase(env) + path, { method: "POST", headers: { "Authorization": "Bearer " + env.SQUARE_ACCESS_TOKEN, "Square-Version": "2024-10-17", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({})); return { ok: r.ok, j };
}
const variationCache = {};
async function variationIdFor(env, product) {
  if (!product.squareName) return "";           // default: no Square catalog item needed
  if (variationCache[product.squareName]) return variationCache[product.squareName];
  const { ok, j } = await sq(env, "/v2/catalog/search-catalog-items", { text_filter: product.squareName, limit: 5 });
  if (!ok) return "";
  const item = (j.items || []).find(i => i.item_data && i.item_data.name.toLowerCase() === product.squareName.toLowerCase());
  const v = item && item.item_data.variations && item.item_data.variations[0];
  if (v) variationCache[product.squareName] = v.id;
  return v ? v.id : "";
}

/** Finds the sales tax configured in her Square account (Dashboard → Account & Settings → Sales taxes). */
let taxCache = null;
async function salesTaxId(env) {
  if (taxCache) return taxCache;
  const { ok, j } = await sq(env, "/v2/catalog/search", { object_types: ["TAX"] });
  if (!ok) return "";
  const taxes = (j.objects || []).filter(t => t.tax_data && t.tax_data.enabled !== false && !t.is_deleted && (t.tax_data.inclusion_type || "ADDITIVE") === "ADDITIVE");
  const want = (env.SQUARE_TAX_NAME || "").toLowerCase();
  const pick = (want && taxes.find(t => t.tax_data.name.toLowerCase() === want)) || taxes[0];
  if (pick) taxCache = pick.id;
  return pick ? pick.id : "";
}

function buildNote(o) {
  const bits = [];
  if (o.giftMessage) bits.push("CARD MESSAGE: " + o.giftMessage + (o.giftFrom ? " (from " + o.giftFrom + ")" : ""));
  else if (o.giftFrom) bits.push("CARD FROM: " + o.giftFrom);
  if (o.instructions) bits.push("DELIVERY NOTES: " + o.instructions);
  bits.push("ORDERED BY: " + o.customer.name + ", " + o.customer.phone + ", " + o.customer.email);
  return bits.join(" | ").slice(0, 490);
}

async function createPaymentLink(env, o) {
  const lineItems = [];
  for (const it of o.items) {
    const p = PRODUCTS[it.id]; const vid = await variationIdFor(env, p);
    lineItems.push(vid ? { catalog_object_id: vid, quantity: String(it.qty) }
                       : { name: p.name, quantity: String(it.qty), base_price_money: { amount: p.price, currency: "USD" } });
  }
  const useCatalog = lineItems.length > 0 && lineItems.every(l => l.catalog_object_id);
  const order = {
    location_id: env.SQUARE_LOCATION_ID,
    reference_id: ("MTD-" + o.deliveryDate).slice(0, 40),
    line_items: lineItems,
    fulfillments: [{
      type: "DELIVERY", state: "PROPOSED",
      delivery_details: {
        recipient: { display_name: o.recipient.name, phone_number: o.recipient.phone,
          address: { address_line_1: o.recipient.address1, address_line_2: o.recipient.address2 || undefined, locality: o.recipient.city, administrative_district_level_1: "CA", postal_code: o.recipient.zip, country: "US" } },
        schedule_type: "SCHEDULED",
        deliver_at: o.deliveryDate + "T12:00:00" + ptOffset(o.deliveryDate),
        note: buildNote(o)
      }
    }],
    metadata: { delivery_date: o.deliveryDate, recipient: o.recipient.name.slice(0, 120) }
  };
  // Square rejects empty metadata values, so only add the optional ones when they have text.
  if (o.giftMessage) order.metadata.gift_message = o.giftMessage.slice(0, 250);
  if (o.giftFrom) order.metadata.gift_from = o.giftFrom.slice(0, 60);
  if (o.instructions) order.metadata.delivery_notes = o.instructions.slice(0, 200);
  if (useCatalog) order.pricing_options = { auto_apply_taxes: true };
  else {
    // Custom line items don't carry tax by themselves: attach the sales tax already set up in her Square account.
    const taxId = await salesTaxId(env);
    if (taxId) order.taxes = [{ uid: "sales-tax", catalog_object_id: taxId, scope: "ORDER" }];
    else if (env.REQUIRE_TAX !== "false") { console.log("No sales tax found in Square"); const e = new Error("no-tax"); e.detail = "No sales tax found in this Square account. Create one in the Dashboard under Account & Settings → Sales taxes (or Items → Taxes)."; throw e; }
  }
  const { ok, j } = await sq(env, "/v2/online-checkout/payment-links", {
    idempotency_key: crypto.randomUUID(),
    order,
    // Square rejects pre_populated_data.buyer_email together with a fulfillment, and the delivery recipient may be
    // someone else, so we send NO email to Square here: Square's checkout asks the buyer for their own email
    // (for the receipt). The buyer's name/phone/email are recorded in the delivery note instead.
    checkout_options: { redirect_url: (env.SITE_URL || "https://maketheirdaybouquets.com") + "/order-complete.html", ask_for_shipping_address: false, allow_tipping: false }
  });
  if (!ok || !j.payment_link) {
    console.log("Square error", JSON.stringify(j));
    const e = new Error("square"); e.detail = (j.errors || []).map(x => [x.category, x.code, x.field, x.detail].filter(Boolean).join(" · ")).join(" | ") || "no details"; throw e;
  }
  return { url: j.payment_link.url, embedUrl: j.payment_link.long_url || "", usedCatalog: useCatalog };
}

/* ---------- HTTP ---------- */
function cors(env, req) {
  const allowed = (env.ALLOWED_ORIGINS || "https://maketheirdaybouquets.com,https://www.maketheirdaybouquets.com,https://stevenhinkel11.github.io").split(",").map(s => s.trim());
  const origin = req.headers.get("Origin") || "";
  const ok = allowed.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin);
  return { "Access-Control-Allow-Origin": ok ? origin : allowed[0], "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin" };
}
const json = (obj, status, h) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...h } });

export default {
  async fetch(req, env) {
    const h = cors(env, req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    const path = new URL(req.url).pathname;
    if (req.method !== "POST" || path !== "/checkout") return json({ error: "Not found." }, 404, h);
    let body; try { body = await req.json(); } catch (_) { return json({ error: "Invalid request." }, 400, h); }
    const v = validateOrder(body); if (v.error) return json({ error: v.error }, 400, h);
    try { const { url, embedUrl } = await createPaymentLink(env, v.order); return json({ url, embedUrl }, 200, h); }
    catch (e) { return json({ error: "We couldn't start checkout right now. Please try again, or contact us.", detail: env.SQUARE_ENV === "sandbox" ? (e.detail || String(e.message || e)) : undefined }, 502, h); }
  }
};
