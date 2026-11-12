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
  // Prices in cents. Products live on the website; you do NOT need to create them in Square.
  // Optional: add  squareName: "Item name in Square"  to use an existing Square catalog item instead.
  "petite-bouquet":       { name: "Petite Bouquet",       price: 5500 },
  "signature-arrangement": { name: "Signature Arrangement", price: 10000 },
  "deluxe-arrangement":   { name: "Deluxe Arrangement",   price: 15000 },   // listed as "$150+" on the site
  "sunset-soiree": { name: "Sunset Soirée", price: 15000 },
  "harvest-hues-hand-wrapped": { name: "Harvest Hues, Hand Wrapped", price: 7500 },
  "autumn-jewel": { name: "Autumn Jewel", price: 5500 },
  "lavender-love-vase": { name: "Lavender Love, Vase", price: 10000 },
  "lavender-love-hand-wrapped": { name: "Lavender Love, Hand Wrapped", price: 7500 },
  "rustic-romance": { name: "Rustic Romance", price: 5500 },
  "harvest-hues-vase": { name: "Harvest Hues, Vase", price: 10000 },
  "test-bouquet": { name: "Test Bouquet ($1 test)", price: 100 }   // TEMPORARY: live end-to-end test, remove afterwards
};

// ZIP codes we deliver to: everywhere between Boulder Creek and Aptos (Santa Cruz County ZIPs, minus Watsonville). Keep in sync with js/shop.js.
const ZIPS = {
  "95001": "Aptos", "95003": "Aptos", "95005": "Ben Lomond", "95006": "Boulder Creek", "95007": "Brookdale",
  "95010": "Capitola", "95017": "Davenport", "95018": "Felton", "95041": "Mount Hermon",
  "95060": "Santa Cruz", "95061": "Santa Cruz", "95062": "Santa Cruz", "95063": "Santa Cruz", "95064": "Santa Cruz",
  "95065": "Santa Cruz", "95066": "Scotts Valley", "95067": "Scotts Valley", "95073": "Soquel"
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
  if (!ZIPS[zip]) return { error: "Sorry, we deliver anywhere between Boulder Creek and Aptos, and that ZIP code is outside that area. For deliveries elsewhere, please email maketheirdaybouquets@gmail.com." };
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
                       : { name: p.name + " (deliver " + shortDate(o.deliveryDate) + " to " + o.recipient.address1.replace(/[()]/g, " ") + ", " + o.recipient.city + ")", quantity: String(it.qty), base_price_money: { amount: p.price, currency: "USD" } });
  }
  const useCatalog = lineItems.length > 0 && lineItems.every(l => l.catalog_object_id);
  const addr = { address_line_1: o.recipient.address1, address_line_2: o.recipient.address2 || undefined, locality: o.recipient.city, administrative_district_level_1: "CA", postal_code: o.recipient.zip, country: "US" };
  const deliverAt = o.deliveryDate + "T12:00:00" + ptOffset(o.deliveryDate);
  const recip = { display_name: o.recipient.name, phone_number: o.recipient.phone, address: addr };
  // Square payment links reject a DELIVERY fulfillment at payment time, so the default is "shipment" (shows as a proper
  // shipment in Square, with Ship-to address and due date). FULFILLMENT_MODE can be set to "none" as a fallback.
  const mode = (env.FULFILLMENT_MODE || "shipment").toLowerCase();
  const order = {
    location_id: env.SQUARE_LOCATION_ID,
    reference_id: ("MTD-" + o.deliveryDate).slice(0, 40),
    line_items: lineItems,
    metadata: {}
  };
  if (mode === "delivery") {
    order.fulfillments = [{ type: "DELIVERY", state: "PROPOSED", delivery_details: { recipient: recip, schedule_type: "SCHEDULED", deliver_at: deliverAt, note: buildNote(o) } }];
  } else if (mode === "shipment") {
    order.fulfillments = [{ type: "SHIPMENT", state: "PROPOSED", shipment_details: { recipient: recip, shipping_note: buildNote(o), expected_shipped_at: deliverAt } }];
  } else { // "none": keep everything in the line item note + metadata
    const where = [o.recipient.name, o.recipient.phone, o.recipient.address1, o.recipient.address2, o.recipient.city + ", CA " + o.recipient.zip].filter(Boolean).join(", ");
    for (const li of lineItems) li.note = ("DELIVER " + o.deliveryDate + " TO " + where + " | " + buildNote(o)).slice(0, 490);
  }
  // Structured order details (max 10 keys). The new-order email is built from these. Square rejects empty values.
  const md = {
    delivery_date: o.deliveryDate, recipient_name: o.recipient.name, recipient_phone: o.recipient.phone,
    address: [o.recipient.address1, o.recipient.address2, o.recipient.city + ", CA " + o.recipient.zip].filter(Boolean).join(", "),
    gift_message: o.giftMessage, gift_from: o.giftFrom, delivery_notes: o.instructions,
    buyer_name: o.customer.name, buyer_phone: o.customer.phone, buyer_email: o.customer.email
  };
  for (const [k, v] of Object.entries(md)) if (v) order.metadata[k] = String(v).slice(0, 250);
  if (useCatalog) order.pricing_options = { auto_apply_taxes: true };
  else {
    // Custom line items don't carry tax by themselves: attach the sales tax already set up in her Square account.
    const taxId = await salesTaxId(env);
    if (taxId) order.taxes = [{ uid: "sales-tax", catalog_object_id: taxId, scope: "ORDER" }];
    else if (env.REQUIRE_TAX !== "false") { console.log("No sales tax found in Square"); const e = new Error("no-tax"); e.detail = "No sales tax found in this Square account. Create one in the Dashboard under Account & Settings → Sales taxes (or Items → Taxes)."; throw e; }
  }
  const linkBody = {
    idempotency_key: crypto.randomUUID(),
    order,
    checkout_options: { redirect_url: (env.SITE_URL || "https://maketheirdaybouquets.com") + "/order-complete.html", ask_for_shipping_address: false, allow_tipping: false }
  };
  // Pre-fill the buyer's email so Square doesn't ask for it again. Square once rejected buyer_email together with a
  // fulfillment, so if it reports CONFLICTING_PARAMETERS we retry without it (the buyer then types it on Square's page).
  let res = await sq(env, "/v2/online-checkout/payment-links", { ...linkBody, pre_populated_data: { buyer_email: o.customer.email } });
  if (!res.ok && JSON.stringify(res.j).includes("CONFLICTING_PARAMETERS")) {
    console.log("buyer_email conflicts with fulfillment; retrying without it");
    res = await sq(env, "/v2/online-checkout/payment-links", { ...linkBody, idempotency_key: crypto.randomUUID() });
  }
  const { ok, j } = res;
  if (!ok || !j.payment_link) {
    console.log("Square error", JSON.stringify(j));
    const e = new Error("square"); e.detail = (j.errors || []).map(x => [x.category, x.code, x.field, x.detail].filter(Boolean).join(" · ")).join(" | ") || "no details"; throw e;
  }
  return { url: j.payment_link.url, embedUrl: j.payment_link.long_url || "", usedCatalog: useCatalog };
}

/* ---------- New-order email (Square webhook → Resend) ---------- */
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const usd = c => "$" + ((Number(c) || 0) / 100).toFixed(2);
const prettyDate = ymd => /^\d{4}-\d{2}-\d{2}$/.test(ymd || "") ? new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date(ymd + "T12:00:00Z")) : (ymd || "(no date)");
const shortDate = ymd => /^\d{4}-\d{2}-\d{2}$/.test(ymd || "") ? new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(ymd + "T12:00:00Z")) : "";

/** Builds the owner's new-order email from a Square order (+ optional payment). Pure, so it is unit-tested. */
function buildEmail(order, payment) {
  const m = order.metadata || {};
  const items = (order.line_items || []).map(li => ({ name: (li.name || "Item").replace(/ \(deliver [^)]*\)$/, ""), qty: li.quantity || "1", total: li.total_money && li.total_money.amount }));
  const subtotal = (order.line_items || []).reduce((a, li) => a + ((li.gross_sales_money && li.gross_sales_money.amount) || 0), 0);
  const tax = order.total_tax_money && order.total_tax_money.amount, total = order.total_money && order.total_money.amount;
  const city = (m.address || "").split(",").slice(-2, -1)[0] ? (m.address.split(",").slice(-2, -1)[0] || "").trim() : "";
  const maps = m.address ? "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(m.address) : "";
  const payer = payment && payment.buyer_email_address;
  const receipt = payment && payment.receipt_url;
  const card = payment && payment.card_details && payment.card_details.card ? (payment.card_details.card.card_brand || "Card") + " ending " + payment.card_details.card.last_4 : "";
  const subject = "New order · deliver " + (shortDate(m.delivery_date) || "date?") + (city ? " · " + city : "") + (m.recipient_name ? " · " + m.recipient_name : "");

  const row = (k, v, raw) => v ? `<tr><td style="padding:6px 14px 6px 0;color:#7a7468;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0;color:#2b2a26">${raw ? v : esc(v)}</td></tr>` : "";
  const h = t => `<h2 style="font:600 13px Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#b9700f;margin:26px 0 6px">${esc(t)}</h2>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#f6f0e6;padding:22px 12px;font:15px/1.5 Arial,sans-serif;color:#2b2a26">
<div style="max-width:560px;margin:auto;background:#fff;border-radius:8px;padding:26px 28px">
<div style="font:italic 26px Georgia,serif;margin-bottom:2px">New order</div>
<div style="color:#7a7468;margin-bottom:6px">Paid through the website${card ? " &middot; " + esc(card) : ""}</div>
${h("Deliver")}
<table style="border-collapse:collapse;width:100%">
${row("Date", prettyDate(m.delivery_date))}
${row("To", m.recipient_name)}
${row("Phone", m.recipient_phone ? `<a href="tel:${esc(m.recipient_phone)}" style="color:#2b2a26">${esc(m.recipient_phone)}</a>` : "", true)}
${row("Address", m.address ? `${esc(m.address)}${maps ? ` &nbsp;<a href="${esc(maps)}" style="color:#b9700f">Map</a>` : ""}` : "", true)}
${row("Delivery notes", m.delivery_notes)}
</table>
${m.gift_message || m.gift_from ? h("Card message") + `<div style="background:#fdf3e1;border-left:4px solid #d98a1f;padding:12px 14px;border-radius:4px">${m.gift_message ? esc(m.gift_message) : ""}${m.gift_from ? `<div style="margin-top:6px;color:#7a7468">From: ${esc(m.gift_from)}</div>` : ""}</div>` : ""}
${h("Order")}
<table style="border-collapse:collapse;width:100%">
${items.map(i => `<tr><td style="padding:5px 0">${esc(i.name)} × ${esc(i.qty)}</td><td style="padding:5px 0;text-align:right">${usd(i.total)}</td></tr>`).join("")}
${subtotal ? `<tr><td style="padding:5px 0;color:#7a7468">Subtotal</td><td style="padding:5px 0;text-align:right;color:#7a7468">${usd(subtotal)}</td></tr>` : ""}
${tax ? `<tr><td style="padding:5px 0;color:#7a7468">Tax</td><td style="padding:5px 0;text-align:right;color:#7a7468">${usd(tax)}</td></tr>` : ""}
<tr><td style="padding:8px 0;border-top:1px solid #e3dccf;font-weight:bold">Total paid</td><td style="padding:8px 0;border-top:1px solid #e3dccf;text-align:right;font-weight:bold">${usd(total)}</td></tr>
</table>
${h("Ordered by")}
<table style="border-collapse:collapse;width:100%">
${row("Name", m.buyer_name)}
${row("Phone", m.buyer_phone ? `<a href="tel:${esc(m.buyer_phone)}" style="color:#2b2a26">${esc(m.buyer_phone)}</a>` : "", true)}
${row("Email", m.buyer_email ? `<a href="mailto:${esc(m.buyer_email)}" style="color:#2b2a26">${esc(m.buyer_email)}</a>` : "", true)}
${payer && payer !== m.buyer_email ? row("Receipt email (typed at payment)", payer) : ""}
</table>
${receipt ? `<p style="margin-top:22px"><a href="${esc(receipt)}" style="color:#b9700f">View the Square receipt</a></p>` : ""}
<p style="color:#9a948a;font-size:12px;margin-top:22px">Order ${esc(order.id || "")}</p>
</div></body></html>`;

  const text = ["NEW ORDER (paid through the website)", "",
    "DELIVER", "Date: " + prettyDate(m.delivery_date), "To: " + (m.recipient_name || ""), "Phone: " + (m.recipient_phone || ""), "Address: " + (m.address || ""),
    m.delivery_notes ? "Delivery notes: " + m.delivery_notes : "",
    m.gift_message || m.gift_from ? "\nCARD MESSAGE\n" + (m.gift_message || "") + (m.gift_from ? "\nFrom: " + m.gift_from : "") : "",
    "", "ORDER", ...items.map(i => i.name + " x " + i.qty + "  " + usd(i.total)), tax ? "Tax: " + usd(tax) : "", "Total paid: " + usd(total),
    "", "ORDERED BY", "Name: " + (m.buyer_name || ""), "Phone: " + (m.buyer_phone || ""), "Email: " + (m.buyer_email || ""),
    receipt ? "\nReceipt: " + receipt : ""].filter(l => l !== "").join("\n");
  return { subject, html, text };
}


/** The customer-facing confirmation email (branded, no internal details). */
function buildCustomerEmail(order, payment) {
  const m = order.metadata || {};
  const first = (m.buyer_name || "").trim().split(/\s+/)[0] || "there";
  const items = (order.line_items || []).map(li => ({ name: (li.name || "Item").replace(/ \(deliver [^)]*\)$/, ""), qty: li.quantity || "1", total: li.total_money && li.total_money.amount }));
  const subtotal = (order.line_items || []).reduce((a, li) => a + ((li.gross_sales_money && li.gross_sales_money.amount) || 0), 0);
  const tax = order.total_tax_money && order.total_tax_money.amount, total = order.total_money && order.total_money.amount;
  const subject = "Your order is confirmed · delivery " + (shortDate(m.delivery_date) || "");
  const row = (k, v) => v ? `<tr><td style="padding:6px 14px 6px 0;color:#7a7468;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0">${esc(v)}</td></tr>` : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#f6f0e6;padding:22px 12px;font:16px/1.6 Arial,sans-serif;color:#2b2a26">
<div style="max-width:560px;margin:auto;background:#fff;border-radius:8px;overflow:hidden">
<div style="background:#f6f0e6;text-align:center;padding:26px 20px 20px;border-bottom:3px solid #d98a1f">
<a href="https://maketheirdaybouquets.com" style="text-decoration:none"><img src="https://maketheirdaybouquets.com/assets/img/logo.jpg" width="84" height="84" alt="Make Their Day Bouquets" style="display:block;margin:0 auto 10px;border-radius:42px;border:0"><span style="font:italic 24px Georgia,serif;color:#2b2a26">Make Their Day Bouquets</span></a>
</div>
<div style="padding:28px 30px 26px">
<div style="font:italic 30px Georgia,serif;margin-bottom:4px">Thank you, ${esc(first)}!</div>
<p style="margin:0 0 18px;color:#4a4740">Your order is confirmed and we're getting your flowers ready. Here's everything we have:</p>
<div style="font:600 12px Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#b9700f;margin:20px 0 6px">Delivery</div>
<table style="border-collapse:collapse;width:100%">
${row("Date", prettyDate(m.delivery_date))}${row("To", m.recipient_name)}${row("Address", m.address)}${row("Delivery notes", m.delivery_notes)}
</table>
${m.gift_message || m.gift_from ? `<div style="font:600 12px Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#b9700f;margin:22px 0 6px">Your card message</div><div style="background:#fdf3e1;border-left:4px solid #d98a1f;padding:12px 14px;border-radius:4px">${m.gift_message ? esc(m.gift_message) : ""}${m.gift_from ? `<div style="margin-top:6px;color:#7a7468">From: ${esc(m.gift_from)}</div>` : ""}</div>` : ""}
<div style="font:600 12px Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#b9700f;margin:22px 0 6px">Your order</div>
<table style="border-collapse:collapse;width:100%">
${items.map(i => `<tr><td style="padding:5px 0">${esc(i.name)} × ${esc(i.qty)}</td><td style="padding:5px 0;text-align:right">${usd(i.total)}</td></tr>`).join("")}
${subtotal ? `<tr><td style="padding:5px 0;color:#7a7468">Subtotal</td><td style="padding:5px 0;text-align:right;color:#7a7468">${usd(subtotal)}</td></tr>` : ""}
<tr><td style="padding:5px 0;color:#7a7468">Delivery</td><td style="padding:5px 0;text-align:right;color:#7a7468">Free</td></tr>
${tax ? `<tr><td style="padding:5px 0;color:#7a7468">Tax</td><td style="padding:5px 0;text-align:right;color:#7a7468">${usd(tax)}</td></tr>` : ""}
<tr><td style="padding:8px 0;border-top:1px solid #e3dccf;font-weight:bold">Total paid</td><td style="padding:8px 0;border-top:1px solid #e3dccf;text-align:right;font-weight:bold">${usd(total)}</td></tr>
</table>
<p style="margin:24px 0 0;color:#4a4740">Square will send you a separate receipt for your payment. Need to change something? Just reply to this email and we'll help.</p>
<p style="margin:18px 0 0;font:italic 20px Georgia,serif">With love,<br>Make Their Day Bouquets</p>
</div>
<div style="background:#f6f0e6;text-align:center;padding:16px 20px;font-size:12px;color:#7a7468">Santa Cruz County, CA &middot; <a href="https://maketheirdaybouquets.com" style="color:#b9700f;text-decoration:none">maketheirdaybouquets.com</a> &middot; <a href="https://www.instagram.com/maketheirdaybouquets/" style="color:#b9700f;text-decoration:none">@maketheirdaybouquets</a></div>
</div></body></html>`;
  const text = ["Thank you, " + first + "!", "", "Your order is confirmed and we're getting your flowers ready.", "",
    "DELIVERY", "Date: " + prettyDate(m.delivery_date), "To: " + (m.recipient_name || ""), "Address: " + (m.address || ""), m.delivery_notes ? "Delivery notes: " + m.delivery_notes : "",
    m.gift_message || m.gift_from ? "\nYOUR CARD MESSAGE\n" + (m.gift_message || "") + (m.gift_from ? "\nFrom: " + m.gift_from : "") : "",
    "", "YOUR ORDER", ...items.map(i => i.name + " x " + i.qty + "  " + usd(i.total)), "Delivery: Free", tax ? "Tax: " + usd(tax) : "", "Total paid: " + usd(total),
    "", "Square will send you a separate receipt. Need to change something? Just reply to this email.", "", "With love,", "Make Their Day Bouquets"].filter(l => l !== "").join("\n");
  return { subject, html, text };
}

/** Square signs webhooks: base64(HMAC-SHA256(key, notificationUrl + rawBody)). */
async function verifySquareSignature(rawBody, header, url, key) {
  if (!header || !key) return false;
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(url + rawBody)));
  let b64 = ""; for (const b of sig) b64 += String.fromCharCode(b);
  b64 = btoa(b64);
  if (b64.length !== header.length) return false;
  let diff = 0; for (let i = 0; i < b64.length; i++) diff |= b64.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

const sqGet = async (env, path) => { const r = await fetch(squareBase(env) + path, { headers: { "Authorization": "Bearer " + env.SQUARE_ACCESS_TOKEN, "Square-Version": "2024-10-17" } }); return { ok: r.ok, j: await r.json().catch(() => ({})) }; };
const emailed = new Set();

async function handleWebhook(req, env) {
  const raw = await req.text();
  const url = env.WEBHOOK_URL || req.url;
  if (!(await verifySquareSignature(raw, req.headers.get("x-square-hmacsha256-signature"), url, env.SQUARE_WEBHOOK_SIGNATURE_KEY))) return new Response("bad signature", { status: 401 });
  let ev; try { ev = JSON.parse(raw); } catch (_) { return new Response("bad json", { status: 400 }); }
  const p = ev && ev.data && ev.data.object && ev.data.object.payment;
  // Only completed, non-refunded payments
  if (!String(ev.type || "").startsWith("payment.") || !p || p.status !== "COMPLETED" || !p.order_id) return new Response("ignored", { status: 200 });
  // Refunds also trigger payment.updated (sometimes before refunded_money is filled in), so skip anything with a refund attached.
  if ((p.refund_ids && p.refund_ids.length) || (p.refunded_money && p.refunded_money.amount > 0)) return new Response("ignored: refund", { status: 200 });
  // Late or replayed events (older than 2 hours) must never produce a "new order" email.
  if (p.created_at && Date.now() - Date.parse(p.created_at) > 2 * 60 * 60 * 1000) return new Response("ignored: old payment", { status: 200 });
  // Claim this payment BEFORE any async work, so notifications that arrive at the same moment can't all send an email.
  if (emailed.has(p.id)) return new Response("duplicate", { status: 200 });
  emailed.add(p.id);
  // Durable claim (survives restarts and works across Cloudflare instances). Written BEFORE sending; removed if sending fails.
  const kvKey = "sent:" + p.id;
  if (env.ORDERS_KV) {
    if (await env.ORDERS_KV.get(kvKey)) return new Response("duplicate", { status: 200 });
    await env.ORDERS_KV.put(kvKey, String(Date.now()), { expirationTtl: 60 * 60 * 24 * 14 });
  }
  const release = () => { emailed.delete(p.id); if (env.ORDERS_KV) return env.ORDERS_KV.delete(kvKey); };
  const { ok, j } = await sqGet(env, "/v2/orders/" + encodeURIComponent(p.order_id));
  if (!ok || !j.order) { await release(); console.log("order fetch failed", JSON.stringify(j)); return new Response("order fetch failed", { status: 500 }); }
  if (!(j.order.metadata && j.order.metadata.delivery_date)) return new Response("not a website order", { status: 200 });
  const { subject, html, text } = buildEmail(j.order, p);
  if (!env.RESEND_API_KEY || !env.NOTIFY_TO) { await release(); console.log("email not configured"); return new Response("email not configured", { status: 500 }); }
  // Square sends payment.updated several times per payment (and Cloudflare may run several instances at once), so every
  // email carries an idempotency key tied to the payment: Resend ignores repeats of the same key.
  const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Authorization": "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json", "Idempotency-Key": "owner-" + p.id },
    body: JSON.stringify({ from: env.NOTIFY_FROM || "Make Their Day Orders <onboarding@resend.dev>", to: env.NOTIFY_TO.split(",").map(s => s.trim()), subject, html, text, reply_to: (j.order.metadata.buyer_email || undefined) }) });
  if (!r.ok) { await release(); console.log("resend failed", r.status, await r.text()); return new Response("email failed", { status: 500 }); }

  // Customer confirmation (needs a verified sending domain: set CUSTOMER_FROM, e.g. "Make Their Day Bouquets <orders@maketheirdaybouquets.com>").
  // A failure here never blocks the owner email, which has already been sent.
  const buyer = j.order.metadata.buyer_email;
  if (env.CUSTOMER_FROM && buyer) {
    try {
      const c = buildCustomerEmail(j.order, p);
      const cr = await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Authorization": "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json", "Idempotency-Key": "customer-" + p.id },
        body: JSON.stringify({ from: env.CUSTOMER_FROM, to: [buyer], subject: c.subject, html: c.html, text: c.text, reply_to: env.NOTIFY_TO.split(",")[0].trim() }) });
      if (!cr.ok) console.log("customer email failed", cr.status, await cr.text());
    } catch (e) { console.log("customer email error", String(e)); }
  }
  return new Response("sent", { status: 200 });
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
    if (req.method === "POST" && path === "/webhook") return handleWebhook(req, env);
    if (req.method !== "POST" || path !== "/checkout") return json({ error: "Not found." }, 404, h);
    let body; try { body = await req.json(); } catch (_) { return json({ error: "Invalid request." }, 400, h); }
    const v = validateOrder(body); if (v.error) return json({ error: v.error }, 400, h);
    try { const { url, embedUrl } = await createPaymentLink(env, v.order); return json({ url, embedUrl }, 200, h); }
    catch (e) { return json({ error: "We couldn't start checkout right now. Please try again, or contact us.", detail: env.SQUARE_ENV === "sandbox" ? (e.detail || String(e.message || e)) : undefined }, 502, h); }
  }
};
