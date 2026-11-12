/* Shared shop logic: products, cart, delivery rules.
   The Cloudflare Worker (worker/worker.js) repeats the delivery rules server-side and is the source of truth for prices. */
(function () {
  // Set this to the deployed Worker URL, e.g. "https://mtd-checkout.YOURNAME.workers.dev/checkout"
  const CHECKOUT_API = "https://mtd-checkout.stevenhinkel.workers.dev/checkout";

  const PRODUCTS = [
    {
      id: "petite-bouquet", name: "Petite Bouquet", price: 5500, // cents
      description: "A sweet, thoughtfully arranged bouquet, hand-wrapped and finished with a ribbon.",
      image: "assets/img/wildflower-deck.jpg", image800: "assets/img/800/wildflower-deck.jpg", alt: "Hand-wrapped bouquet with a ribbon"
    },
    {
      id: "signature-arrangement", name: "Signature Arrangement", price: 10000,
      description: "A full, lush floral arrangement, beautifully designed in a vase or container.",
      image: "assets/img/pink-bowl.jpg", image800: "assets/img/800/pink-bowl.jpg", alt: "Hot pink and orange roses, cosmos, marigold and gerbera daisies in a white bowl"
    },
    {
      id: "deluxe-arrangement", name: "Deluxe Arrangement", price: 15000, priceNote: "starting at",
      description: "Our most abundant, showstopping floral designs, artfully arranged in a vase or container.",
      image: "assets/img/lavender-magenta.jpg", image800: "assets/img/800/lavender-magenta.jpg", alt: "Lavender roses, magenta blooms and white daisies in a glass vase"
    },
    {
      id: "sunset-soiree", name: "Sunset Soirée", price: 15000,
      description: "Exact flowers vary by season.", image: "assets/img/pink-bowl.jpg", image800: "assets/img/800/pink-bowl.jpg", alt: "Pink and orange arrangement in a white bowl"
    },
    {
      id: "harvest-hues-hand-wrapped", name: "Harvest Hues, Hand Wrapped", price: 7500,
      description: "Exact flowers vary by season.", image: "assets/img/7166.jpg", image800: "assets/img/800/7166.jpg", alt: "Hand-wrapped bouquet of peach roses and daisies"
    },
    {
      id: "autumn-jewel", name: "Autumn Jewel", price: 5500,
      description: "Exact flowers vary by season.", image: "assets/img/purple-orange-bouquets.jpg", image800: "assets/img/800/purple-orange-bouquets.jpg", alt: "Purple and orange bouquets"
    },
    {
      id: "lavender-love-vase", name: "Lavender Love, Vase", price: 10000,
      description: "Exact flowers vary by season.", image: "assets/img/lavender-magenta.jpg", image800: "assets/img/800/lavender-magenta.jpg", alt: "Lavender roses and magenta blooms in a glass vase"
    },
    {
      id: "lavender-love-hand-wrapped", name: "Lavender Love, Hand Wrapped", price: 7500,
      description: "Exact flowers vary by season.", image: "assets/img/pink-white-bouquet.jpg", image800: "assets/img/800/pink-white-bouquet.jpg", alt: "Hand-wrapped bouquet of lavender roses and chrysanthemums"
    },
    {
      id: "rustic-romance", name: "Rustic Romance", price: 5500,
      description: "Exact flowers vary by season.", image: "assets/img/wildflower-deck.jpg", image800: "assets/img/800/wildflower-deck.jpg", alt: "Kraft-wrapped wildflower bouquet"
    },
    {
      id: "harvest-hues-vase", name: "Harvest Hues, Vase", price: 10000,
      description: "Exact flowers vary by season.", image: "assets/img/7165.jpg", image800: "assets/img/800/7165.jpg", alt: "Pink gerbera and yellow roses in a bowl"
    },
    { // TEMPORARY hidden $1 product for a live end-to-end test. Not shown on the site.
      id: "test-bouquet", name: "Test Bouquet ($1 test)", price: 100, hidden: true,
      description: "Live checkout test.", image: "assets/img/pink-bowl.jpg", image800: "assets/img/800/pink-bowl.jpg", alt: ""
    }
  ];

  // ZIP codes we deliver to: everywhere between Boulder Creek and Aptos (Santa Cruz County ZIPs, minus Watsonville). See worker/README.md.
  const ZIPS = {
    "95001": "Aptos", "95003": "Aptos", "95005": "Ben Lomond", "95006": "Boulder Creek", "95007": "Brookdale",
    "95010": "Capitola", "95017": "Davenport", "95018": "Felton", "95041": "Mount Hermon",
    "95060": "Santa Cruz", "95061": "Santa Cruz", "95062": "Santa Cruz", "95063": "Santa Cruz", "95064": "Santa Cruz",
    "95065": "Santa Cruz", "95066": "Scotts Valley", "95067": "Scotts Valley", "95073": "Soquel"
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
