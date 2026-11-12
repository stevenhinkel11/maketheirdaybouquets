/* Shared shop logic: products, cart, delivery rules.
   The Cloudflare Worker (worker/worker.js) repeats the delivery rules server-side and is the source of truth for prices. */
(function () {
  // Set this to the deployed Worker URL, e.g. "https://mtd-checkout.YOURNAME.workers.dev/checkout"
  const CHECKOUT_API = "https://mtd-checkout.stevenhinkel.workers.dev/checkout";

  const PRODUCTS = [
    {
      id: "luxury-bouquet",
      name: "Luxury Bouquet",
      price: 10000, // cents
      description: "An extravagant arrangement bursting with color and texture. Perfect for celebrations and gifts!",
      image: "assets/img/pink-bowl.jpg",
      image800: "assets/img/800/pink-bowl.jpg",
      alt: "Hot pink and orange roses, cosmos, marigold and gerbera daisies in a white bowl"
    }
  ];

  // Every ZIP code that serves addresses in Santa Cruz County, CA (verified against zip-codes.com; see worker/README.md).
  const ZIPS = {
    "95001": "Aptos", "95003": "Aptos", "95005": "Ben Lomond", "95006": "Boulder Creek", "95007": "Brookdale",
    "95010": "Capitola", "95017": "Davenport", "95018": "Felton", "95019": "Freedom", "95041": "Mount Hermon",
    "95060": "Santa Cruz", "95061": "Santa Cruz", "95062": "Santa Cruz", "95063": "Santa Cruz", "95064": "Santa Cruz",
    "95065": "Santa Cruz", "95066": "Scotts Valley", "95067": "Scotts Valley", "95073": "Soquel",
    "95076": "Watsonville", "95077": "Watsonville"
  };

  const RULES = {
    cutoffHour: 11,          // order before 11:00 AM Pacific for same-day delivery
    maxDaysAhead: 120,
    deliveryDays: [0, 1, 2, 3, 4, 5, 6], // 0 = Sunday ... 6 = Saturday
    closedDates: []          // e.g. ["2026-12-25"]
  };

  const KEY = "mtd_cart_v1";
  const money = c => "$" + (c / 100).toFixed(2);
  const find = id => PRODUCTS.find(p => p.id === id);

  const Cart = {
    get() { try { return (JSON.parse(localStorage.getItem(KEY)) || []).filter(i => find(i.id) && i.qty > 0); } catch (_) { return []; } },
    save(items) { try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (_) {} document.dispatchEvent(new CustomEvent("cart:change")); },
    add(id, n = 1) { const items = this.get(); const it = items.find(i => i.id === id); if (it) it.qty = Math.min(10, it.qty + n); else items.push({ id, qty: Math.min(10, n) }); this.save(items); },
    setQty(id, qty) { let items = this.get(); const it = items.find(i => i.id === id); if (!it) return; it.qty = qty; items = items.filter(i => i.qty > 0); this.save(items); },
    clear() { this.save([]); },
    count() { return this.get().reduce((a, i) => a + i.qty, 0); },
    subtotal() { return this.get().reduce((a, i) => a + find(i.id).price * i.qty, 0); }
  };

  // Current date/time in Pacific time
  function ptNow() {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
    const g = t => parts.find(p => p.type === t).value;
    return { date: `${g("year")}-${g("month")}-${g("day")}`, hour: +g("hour"), minute: +g("minute") };
  }
  const addDays = (ymd, n) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  function earliestDate() { const n = ptNow(); return n.hour < RULES.cutoffHour ? n.date : addDays(n.date, 1); }
  function latestDate() { return addDays(ptNow().date, RULES.maxDaysAhead); }
  function dateProblem(ymd) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || "")) return "Please choose a delivery date.";
    if (ymd < earliestDate()) return "That date is too soon. Same-day delivery needs an order before 11:00 AM Pacific.";
    if (ymd > latestDate()) return "Please choose a date within the next " + RULES.maxDaysAhead + " days.";
    if (RULES.closedDates.includes(ymd)) return "We're not delivering on that date. Please choose another.";
    const dow = new Date(ymd + "T12:00:00Z").getUTCDay();
    if (!RULES.deliveryDays.includes(dow)) return "We don't deliver on that day. Please choose another.";
    return "";
  }
  const zipCity = z => ZIPS[String(z || "").trim()] || "";

  window.MTD = { CHECKOUT_API, PRODUCTS, ZIPS, RULES, Cart, money, find, earliestDate, latestDate, dateProblem, zipCity, ptNow };
})();
