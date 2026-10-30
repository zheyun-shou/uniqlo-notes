# UNIQLO FITLOG

A personal closet log for Uniqlo clothes, built as a PWA. Use it to keep track of what you tried on, bought or want, and how each piece fit.

> An unofficial personal project. It is not affiliated with or endorsed by Uniqlo / Fast Retailing.

## Features

- **Product lookup.** Enter the 6-digit product number from the tag or the website, search by English product name, or paste a product link. FITLOG fills in the name, site category, price, material, available colors and sizes, and images for each color. Name search helps when the number on the tag differs from the one online.
- **Notes for each item.** Date, store, color, size, fit (runs small / true to size / runs large), length, rating, verdict (Bought / Want / To try / Maybe / Pass), original price, price paid, likes, dislikes and tags.
- **Reusable phrases.** Whatever you type into likes, dislikes or tags is split at commas and kept as tap-to-insert phrases, so you never type the same note twice.
- **Automatic categories.** Items are sorted into T-shirts & Tops, Shirts, Knitwear, Sweats & Fleece, Outerwear, Down & Padded, Bottoms, Skirts & Dresses, Innerwear, Loungewear and Accessories based on the site category. You can change the category by hand.
- **One search box.** The home page search looks through your closet and uniqlo.com at the same time. Tap an online result to start logging it.
- **Filtering.** Filter by category and verdict, and search across all fields. Several entries for the same product (for example, different sizes) link to each other.
- **Price alerts.** Watch any item, or every "Want" item in one tap, and get an email when its price drops.
- **Image archive.** When you save an entry, the product images are copied into your own Cloudflare R2 bucket, so they still show after Uniqlo removes them.
- **Installable and offline-friendly.** Add it to your phone's home screen. Without a connection it still shows your last synced entries and any images you've already seen.
- **Light and dark themes.** Oxblood on white, or white on oxblood in dark mode, with a toggle in the top bar. The default follows your system setting.
- **Backup.** Export and import your data as JSON.

FITLOG looks products up on the Swedish site (`uniqlo.com/se`) by default. You can point it at another region in `wrangler.jsonc`.

## Architecture

Everything runs in a single Cloudflare Worker. The free plan is enough.

```
public/        Front end (plain HTML/CSS/JS, no build step; bundled into the Worker and served by src/static.js)
src/worker.js  API: auth, entries CRUD, product lookup and search, price alerts
src/uniqlo.js  Fetches and parses Uniqlo product and search pages
src/watch.js   Price checks and alert emails
src/archive.js Copies product images into R2
migrations/    D1 (SQLite) schema
```

- **Product lookups.** Browsers can't fetch uniqlo.com cross-origin, so the Worker requests product pages on the app's behalf and caches the results at the edge for a day. The Worker identifies itself honestly in its User-Agent and does not pretend to be a browser. If Uniqlo refuses those requests, lookups fail and you can enter the details by hand.
- **Storage.** Entries are stored in Cloudflare D1. Each entry keeps a snapshot of the product, so your records survive when a product is delisted.
- **Access.** There is one user, and a single access token (`APP_TOKEN`) protects the whole API.
- **Archived images.** Images in R2 are named by a hash of the original URL, so each image is stored only once. Pages prefer the archived copy and fall back to the original URL if it's unavailable. Archived images are served publicly under `/media/...`, because `<img>` tags can't send a token. They are Uniqlo's public product images anyway.
- **Font and theme.** The UI uses Space Grotesk (SIL Open Font License). The font file lives in `public/fonts/` and is bundled into the Worker, so no external font service is needed.

## Deploy your own

You need Node.js 18+ and a free Cloudflare account.

```bash
npm install
```

```bash
npx wrangler login
```

Create the database, then copy the `database_id` from the output into `wrangler.jsonc`:

```bash
npx wrangler d1 create uniqlo-fitlog
```

Create the tables:

```bash
npm run db:migrate:remote
```

Create the R2 bucket for the image archive. The R2 free tier includes 10 GB, which is plenty for personal use, but Cloudflare asks you to enable R2 and add a payment method in the dashboard first.

```bash
npx wrangler r2 bucket create uniqlo-fitlog-images
```

To skip R2, delete the `r2_buckets` block from `wrangler.jsonc`. Everything else still works; images just won't be archived.

Set an access token. Any long random string works; you'll type it in when you sign in.

```bash
npx wrangler secret put APP_TOKEN
```

```bash
npm run deploy
```

You'll get a URL like `https://uniqlo-fitlog.<your-subdomain>.workers.dev`. Open it on your phone, enter the token, and use "Add to Home Screen".

## Local development

```bash
echo 'APP_TOKEN=dev-token' > .dev.vars
```

```bash
npm run db:migrate:local
```

```bash
npm run dev
```

Open http://localhost:8787 and sign in with `dev-token`.

Run the parser unit tests:

```bash
npm test
```

## When a product can't be found

The Worker requests the product page (`/{region}/{lang}/products/E465185-000/00`) and reads the product data embedded in the page's `window.__PRELOADED_STATE__` → `entity.pdpEntity`. That data includes the name, category breadcrumbs, colors, sizes, prices, material and images for each color. If the embedded data is missing, the Worker falls back to the page's Open Graph tags and JSON-LD.

Some products aren't listed on your home region's site, such as long-length versions sold only in other countries. In that case the Worker also checks the sites listed in `UQ_FALLBACK` (UK, US, Australia, Singapore and Japan by default) and uses the first match. Name, images, colors and sizes come back as usual. A price in a foreign currency is shown for reference only and isn't pre-filled as the original or paid price.

The site's commerce API requires a client ID reserved for Uniqlo's own front end. FITLOG doesn't impersonate that client, so it doesn't use the API.

If a site redesign changes the data format, inspect what Uniqlo returns with the debug endpoint:

```bash
curl -H "Authorization: Bearer <APP_TOKEN>" https://<your-domain>/api/product/465185/raw
```

Then adjust `normalizeApi` in `src/uniqlo.js` to match. For a product that can't be found at all, choose "Enter product details manually" on the add page.

## Image archive

- After you create or edit an entry, the Worker downloads every product image the entry uses into R2 in the background. It only accepts real image files (checking both the Content-Type and the file signature), up to 8 MB each.
- The free Workers plan allows 50 outbound requests per invocation, so the Worker archives at most 30 images per run. To archive anything left over or anything that failed, go to Settings → Image archive and click "Archive remaining images".
- Deleting an entry doesn't delete its archived images, since other entries may use them.

## Price alerts

Tap "Watch price" at the bottom of an item's page. To watch everything marked "Want", filter the home page by "Want" or use the button on the Price Alerts page (the bell in the top bar). You can set an optional target price. Without a target, you get an alert on any drop.

- **Schedule.** A cron trigger (`triggers.crons`) runs every hour and checks the four least recently checked items.
- **Price groups.** Each check looks at two price groups, `/00` and `/01`. On the European sites, "Reduced Price" items are often a separate `/01` page where only some colors are discounted.
- **When you get an email.** You get one when the price falls below the price at your last alert, and reaches your target if you set one. Drops found in the same run are combined into one email. If the price goes back up, the baseline resets, so you're alerted again on the next drop.
- **What can be watched.** Only products found on your home region's site can be watched. Manually entered products and products found on fallback regions can't.

Emails are sent through [Resend](https://resend.com), whose free tier includes 3,000 emails a month. To set it up:

1. Sign up for Resend with the address you want alerts sent to. On the API Keys page, create a key with "Sending access".
2. In the Cloudflare dashboard, go to Workers & Pages → `uniqlo-fitlog` → Settings → Variables and Secrets. Add a **Secret** named `RESEND_API_KEY` whose value is that key. You can also set it from the command line with `npx wrangler secret put RESEND_API_KEY`.
3. On the app's Price Alerts page, enter the same email address and click "Send a test email" to confirm it arrives.

A Resend account without a verified domain can only send from `onboarding@resend.dev`, and only to the address you signed up with. To send to other addresses, verify your own domain in Resend, then add `"ALERT_FROM": "UNIQLO FITLOG <alerts@your-domain>"` to the vars in `wrangler.jsonc`.

## Ideas

- Upload your own try-on photos (also stored in R2)
- Record height, weight and usual sizes, and get suggestions like "for this kind of item, pick size M"
