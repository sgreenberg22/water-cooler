# 💧 Water Cooler

Your daily small-talk survival kit. Every morning it grabs the headlines, turns them into
talking points in your sense of humor, and gives you a big red EJECT button for when someone
corners you by the elevator.

Runs entirely on Cloudflare's **free** plan. No paid AI.

---

## What's in here

| File | What it does |
| --- | --- |
| `public/index.html` | The whole app people see. Themes, mascot, cards, setup, stats. |
| `src/index.js` | The Worker: fetches news, asks Workers AI for jokes, caches everything. |
| `wrangler.jsonc` | Cloudflare settings: AI, cache (KV), the 6am timer, which model to use. |
| `test/worker.test.mjs` | Offline tests for the Worker (`npm test`). |

Open `public/index.html` straight from your computer and it runs in **preview mode** with
sample talking points, so you can play with the design without deploying anything.

---

## Put it online (one time, about 10 minutes)

This app has a backend (AI, cache, morning timer), so it can't be drag-and-dropped like a plain
website. Instead, Cloudflare watches your GitHub repo and redeploys every time it changes.

### 1. Make an empty GitHub repo
1. Go to github.com → **New repository**.
2. Name it `water-cooler`. Private is fine. **Don't** add a README or license.
3. Tell Claude: *"Push Water Cooler to sgreenberg22/water-cooler."* Claude commits and pushes the code.

### 2. Connect Cloudflare to the repo
1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a repository**.
2. Connect GitHub if it asks, then pick `water-cooler`.
3. Project name: `water-cooler` (it must match the `name` in `wrangler.jsonc`).
4. Leave the build command empty. Deploy command: `npx wrangler deploy`.
5. Click **Deploy**. When it finishes you'll get a link like `water-cooler.<you>.workers.dev`.

That's it. From now on, **every push to GitHub redeploys automatically** (about a minute).

### If the first deploy complains about KV
Wrangler normally creates the cache storage for you. If the build log mentions a KV namespace:
1. Dashboard → **Storage & Databases** → **KV** → **Create** → name it `water-cooler-cache`.
2. Copy its ID and tell Claude: *"Add KV id `<paste>` to Water Cooler."* Claude adds it and pushes.

### Optional: your own domain
Worker → **Settings** → **Domains & Routes** → **Add** → Custom domain (any domain you already have on Cloudflare).

---

## How it stays free

- **News:** Google News RSS feeds. No key, no limit worth worrying about.
- **AI:** Cloudflare Workers AI. 10,000 free "neurons" a day, reset at midnight UTC (7pm Central).
  The default model (Llama 3.3 70B) uses roughly 225 neurons per pack, so about **40+ packs a day free**.
- **Packs are shared.** A pack is one topic for one day (Tech, Big News, Chicago Bears…).
  It's generated once and every user who picks that topic gets the same cached copy. Cost grows
  with the number of *topics*, not the number of *people*.
- **On the free plan you can't be charged.** If the daily AI allowance runs out, the app switches
  those packs to "backup mode" (headline-based one-liners) and tries the AI again 20 minutes later.
- **KV cache:** ~20–40 writes a day against a 1,000/day free limit.
- **The 6am timer** pre-fetches every category's headlines and pre-builds Big News + Sports, so the
  first person in each morning isn't kept waiting.

### Want cheaper or better AI?
Change `AI_MODEL` in `wrangler.jsonc`:
- `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (default): funniest, ~40 packs/day free.
- `@cf/meta/llama-3.1-8b-instruct-fp8-fast`: ~6x cheaper (~250 packs/day free), flatter jokes.

### Optional: Claude Haiku as a backup brain
Needs an Anthropic API account (separate from a claude.ai subscription). Cloudflare dashboard →
your Worker → **Settings** → **Variables and Secrets** → add a **Secret** named `ANTHROPIC_API_KEY`.
With the key set, Haiku 4.5 takes over whenever Workers AI is out of quota. To make Haiku the
main brain instead, set `AI_PROVIDER` to `"anthropic"` in `wrangler.jsonc`.
Rough cost: ~$0.006 per pack, so 25 packs/day ≈ $4/month.

---

## Privacy
- Profiles, streaks, XP and ratings live in the user's own browser (localStorage).
- The server only stores daily totals of 🎯 / 😐 / 💀 ratings. No names, no IDs, no conversation text.

## Features
- One-time setup: teams, interests, humor style, hobbies, office city, how long you need to survive.
- 3–6 talking points a day, mixed from your interests plus "normal office" news and sports.
- Two modes: **Nod & survive** (one safe line) or **Have an opinion** (a take in your humor style).
- **Go deeper** on any card: one fact to sound informed and a question to hand the conversation back.
- Weather banter sticky note (Open-Meteo, no key).
- 🚨 **Eject**: an instant line for when you're caught off guard.
- Streaks, XP, ranks (Hallway Ghost → Small Talk Sommelier), personal and global hit rate.
- Six themes: Night Shift, Morning Commute, Break Room, Bubblegum, Arcade, Cubicle Beige.
- Gulp, the water cooler mascot. Tap him.

## Local development
```bash
npm install
npm test            # offline tests with fake AI + KV
npx wrangler dev    # local server (Workers AI calls need `npx wrangler login`)
```

## Ideas for later
- Real leaderboard (Cloudflare D1, also free) once there are friends to compete with.
- "Share this point" card image for group chats.
