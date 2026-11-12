# Checkout function (Cloudflare Worker)

This tiny server function is the only "backend" for the shop. The website (GitHub Pages) sends it the cart and delivery
details; it **re-checks everything** (ZIP code, delivery date, prices), creates a Square payment link, and returns the
Square URL. Square takes the payment, charges sales tax, emails the receipt, and stores the full order.

## What Square records on every order
Items and total, recipient name/phone/address, delivery date, gift message, delivery instructions, and who ordered
(name, phone, email). View them in **Square Dashboard → Orders**, filtered to Delivery.

## One-time setup

### 1. Square (free developer app)
1. Go to https://developer.squareup.com → sign in with the Square account → **Create app** (name it "MTD Website").
2. Open the app → **Credentials**. Keep **Sandbox** selected for testing:
   - copy the **Sandbox Access token**
   - in **Locations**, copy the sandbox **Location ID**
3. Make sure the "Luxury Bouquet" item exists in the Square catalog of the account you're testing with. In the real
   account, set its **tax** (Square Dashboard → Items → Taxes) so Square applies sales tax. The Worker looks the item up
   by name, so the name in Square must match exactly.

### 2. Cloudflare (free account)
1. Create an account at https://dash.cloudflare.com (free plan is fine).
2. Install Node.js, then in this `worker/` folder run:
   ```bash
   npx wrangler login
   npx wrangler secret put SQUARE_ACCESS_TOKEN    # paste the token when asked (never commit it)
   ```
3. Edit `wrangler.toml` and set `SQUARE_LOCATION_ID`.
4. Deploy:
   ```bash
   npx wrangler deploy
   ```
   It prints a URL like `https://mtd-checkout.YOURNAME.workers.dev`.

### 3. Connect the website
In `js/shop.js`, set:
```js
const CHECKOUT_API = "https://mtd-checkout.YOURNAME.workers.dev/checkout";
```
Push to GitHub. Test with Square's sandbox test card (4111 1111 1111 1111, any future date, any CVV/ZIP).

### 4. Go live
1. Square Developer Dashboard → switch to **Production** → copy the Production access token and Location ID.
2. `npx wrangler secret put SQUARE_ACCESS_TOKEN` (paste the production token), set `SQUARE_ENV = "production"` and the
   production `SQUARE_LOCATION_ID` in `wrangler.toml`, then `npx wrangler deploy`.
3. Place one real $100 order yourself and refund it from Square.

## Rules enforced server-side (worker.js)
- **Delivery area:** ZIP must be one of the 21 Santa Cruz County ZIP codes in `ZIPS`. Anything else is rejected.
- **Delivery date:** same-day only if ordered before 11:00 AM Pacific; otherwise earliest is tomorrow; max 120 days
  out; optional closed dates / delivery weekdays in `RULES`.
- **Prices:** come from `PRODUCTS` / the Square catalog, never from the browser.
- Quantity 1–10 per item, honeypot field, CORS limited to the site's domains.

## Updating products
Add the product in **three** places: `PRODUCTS` in `js/shop.js` (what the shop displays), `PRODUCTS` in `worker.js`
(what the server trusts), and as an item in the Square catalog (name must match `squareName`).

## ZIP list source
From zip-codes.com's Santa Cruz County page (21 ZIPs). Notes:
- **95076 (Watsonville)** is mostly Santa Cruz County but also touches Monterey/Santa Clara. Included.
- **95033 (Los Gatos mountains)** partly touches Santa Cruz County. Not included. Add it to both `ZIPS` maps if wanted.
- Some included ZIPs are PO-Box-style (95001, 95007, 95041, 95061, 95063, 95067, 95077); they're harmless to allow.
- Check anything doubtful with the USPS ZIP lookup: https://tools.usps.com/zip-code-lookup.htm

## Tests
`worker/test.mjs` checks the validation rules (ZIPs, dates, cutoff, prices). Run it with Node (`node worker/test.mjs`)
or any JS engine that supports modules.
