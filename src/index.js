/**
 * Water Cooler — daily small-talk ammo.
 * Cloudflare Worker: serves /api/*, static files come from ./public.
 *
 * Free-tier design:
 *  - News: Google News RSS (no API key).
 *  - AI: Workers AI binding (10,000 free neurons/day). Optional Claude Haiku fallback
 *    if you ever add an ANTHROPIC_API_KEY secret.
 *  - Cache: KV. Each "pack" (one category or team) is generated once per day and
 *    shared by every user who picks it, so AI cost scales with categories, not users.
 *  - If AI is unavailable or out of quota, packs fall back to template one-liners.
 */

const TZ = 'America/Chicago';
const ROLLOVER_HOUR = 5;            // before 5am Central you still get yesterday's batch
const POINTS_PER_PACK = 4;
const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const KV_TTL = 60 * 60 * 72;        // 3 days
const FALLBACK_TTL = 60 * 20;       // retry AI after 20 minutes if we had to use templates

const GN = 'hl=en-US&gl=US&ceid=US:en';
const gnTop = () => `https://news.google.com/rss?${GN}`;
const gnTopic = (t) => `https://news.google.com/rss/headlines/section/topic/${t}?${GN}`;
const gnSearch = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:2d')}&${GN}`;
// Backup source: Bing News RSS (Google sometimes blocks cloud servers).
const bing = (q) => `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&setlang=en-US&cc=US`;

// Built-in categories. Teams, hobbies and cities are dynamic packs (see packSpec).
const CATEGORIES = {
  top:           { label: 'Big News',    emoji: '🗞️', feeds: [gnTop(), 'https://feeds.npr.org/1001/rss.xml', bing('top news')] },
  politics:      { label: 'Politics',    emoji: '🏛️', feeds: [gnTopic('NATION'), 'https://feeds.npr.org/1014/rss.xml', bing('politics')] },
  tech:          { label: 'Tech',        emoji: '💻', feeds: [gnTopic('TECHNOLOGY'), 'https://feeds.arstechnica.com/arstechnica/index', bing('technology')] },
  business:      { label: 'Money & Biz', emoji: '💼', feeds: [gnTopic('BUSINESS'), 'https://feeds.npr.org/1006/rss.xml', bing('business')] },
  entertainment: { label: 'TV & Movies', emoji: '🎬', feeds: [gnTopic('ENTERTAINMENT'), 'https://feeds.npr.org/1008/rss.xml', bing('entertainment movies tv')] },
  science:       { label: 'Science',     emoji: '🔬', feeds: [gnTopic('SCIENCE'), 'https://feeds.npr.org/1007/rss.xml', bing('science')] },
  sports:        { label: 'Sports',      emoji: '🏆', feeds: [gnTopic('SPORTS'), 'https://www.espn.com/espn/rss/news', bing('sports')] },
  weird:         { label: 'Weird News',  emoji: '🦆', feeds: [gnSearch('odd news'), 'https://rss.upi.com/news/odd_news.rss', bing('odd news')] },
  food:          { label: 'Food',        emoji: '🌮', feeds: [gnSearch('restaurant food trend'), 'https://feeds.npr.org/1053/rss.xml', bing('food restaurants')] },
  gaming:        { label: 'Gaming',      emoji: '🎮', feeds: [gnSearch('video games'), 'https://www.polygon.com/rss/index.xml', bing('video games')] },
};

// Headlines nobody should be joking about at the coffee machine.
const GRIM = /\b(kill(ed|ing)|kills (\d|at least|one|two|three|four|five|several|dozens|hundreds|man|woman|teen|child|boy|girl)|dead|death|dies|died|murder\w*|shoot\w*|shot|stab\w*|rape\w*|sexual|abuse\w*|suicide|overdose|massacre|terror\w*|bomb\w*|hostage|funeral|obituar\w*|crash(es|ed)? kills|victim\w*|fatal\w*|wounded|genocide|war crimes?|child porn\w*|molest\w*|assault\w*)\b/i;

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/api/pack' && request.method === 'GET') return await handlePack(url, env, ctx);
      if (path === '/api/rate' && request.method === 'POST') return await handleRate(request, env);
      if (path === '/api/stats' && request.method === 'GET') return await handleStats(env);
      if (path === '/api/debug') {
        const key = normalizeKey(url.searchParams.get('key') || 'cat:top');
        if (!key) return json({ error: 'Bad pack key' }, 400);
        const report = [];
        const items = await getHeadlines(key, dayKey(), env, report);
        let ai = 'not tried';
        if (url.searchParams.get('ai') === '1' && items.length) {
          try { const r = await callWorkersAI(env, buildUserPrompt(packSpec(key), items)); ai = cleanPoints(r, items).length + ' points'; }
          catch (e) { ai = 'error: ' + (e && e.message || e); }
        }
        return json({ key, sources: report, sample: items.slice(0, 3).map((i) => i.title), ai });
      }
      if (path === '/api/health') {
        return json({
          ok: true,
          day: dayKey(),
          ai: Boolean(env.AI),
          kv: Boolean(env.TALK_KV),
          provider: providerOrder(env),
          model: env.AI_MODEL || DEFAULT_MODEL,
        });
      }
      if (path.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error('api error', err && err.stack ? err.stack : err);
      return json({ error: 'Something broke. The intern has been notified.' }, 500);
    }

    // Anything else: static assets (index.html etc.)
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },

  // Cron (see wrangler.jsonc): ~6am Central. Pre-fetches headlines and warms the
  // packs almost everyone gets, so the first person in each morning isn't kept waiting.
  async scheduled(event, env, ctx) {
    const day = dayKey();
    const warm = (env.PREWARM || 'cat:top,cat:sports')
      .split(',').map((s) => normalizeKey(s)).filter(Boolean);
    const all = Object.keys(CATEGORIES).map((k) => `cat:${k}`);
    const unique = [...new Set([...warm, ...all])];
    await Promise.allSettled(
      unique.map((key) => (warm.includes(key) ? getPack(key, day, env) : getHeadlines(key, day, env)))
    );
  },
};

/* ----------------------------------------------------------------- routes */

async function handlePack(url, env, ctx) {
  const key = normalizeKey(url.searchParams.get('key') || '');
  if (!key) return json({ error: 'Bad pack key' }, 400);
  const day = dayKey();
  const pack = await getPack(key, day, env, ctx);
  return json({ day, key, ...pack }, 200, { 'cache-control': 'private, max-age=300' });
}

async function handleRate(request, env) {
  let body = {};
  try { body = await request.json(); } catch {}
  const verdict = ['nailed', 'survived', 'flopped'].includes(body.verdict) ? body.verdict : null;
  if (!verdict) return json({ error: 'verdict must be nailed | survived | flopped' }, 400);
  const kind = String(normalizeKey(body.pack || '') || 'other').split(':')[0];

  // Aggregate counts only: no user ids, no text, no conversation logs.
  if (env.TALK_KV) {
    const k = `stats:${dayKey()}`;
    const s = (await env.TALK_KV.get(k, 'json')) || { nailed: 0, survived: 0, flopped: 0, byKind: {} };
    s[verdict] += 1;
    s.byKind[kind] = s.byKind[kind] || { nailed: 0, survived: 0, flopped: 0 };
    s.byKind[kind][verdict] += 1;
    try { await env.TALK_KV.put(k, JSON.stringify(s), { expirationTtl: 60 * 60 * 24 * 14 }); } catch {}
    return json({ ok: true, ...summarize(s) });
  }
  return json({ ok: true });
}

async function handleStats(env) {
  if (!env.TALK_KV) return json({ day: dayKey(), total: 0 });
  const s = (await env.TALK_KV.get(`stats:${dayKey()}`, 'json')) || { nailed: 0, survived: 0, flopped: 0 };
  return json({ day: dayKey(), ...summarize(s) }, 200, { 'cache-control': 'public, max-age=60' });
}

function summarize(s) {
  const total = s.nailed + s.survived + s.flopped;
  return {
    total,
    nailed: s.nailed,
    survived: s.survived,
    flopped: s.flopped,
    effective: total ? Math.round(((s.nailed + s.survived) / total) * 100) : null,
  };
}

/* ------------------------------------------------------------------ packs */

// Pack keys: cat:tech | team:chicago bears | topic:3d printing | local:chicago
function normalizeKey(raw) {
  const s = String(raw).toLowerCase().trim().replace(/\s+/g, ' ');
  const m = s.match(/^(cat|team|topic|local):([a-z0-9 .'&+-]{2,40})$/);
  if (!m) return null;
  if (m[1] === 'cat' && !CATEGORIES[m[2]]) return null;
  return `${m[1]}:${m[2].trim()}`;
}

function packSpec(key) {
  const [kind, name] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  const title = name.replace(/\b\w/g, (c) => c.toUpperCase());
  if (kind === 'cat') return { kind, ...CATEGORIES[name], name };
  if (kind === 'team') return { kind, name, label: title, emoji: '🏟️', feeds: [gnSearch(`"${name}"`), bing(`"${name}"`)] };
  if (kind === 'local') return { kind, name, label: `${title} Local`, emoji: '📍', feeds: [gnSearch(`${name} local news`), bing(`${name} news`)] };
  return { kind, name, label: title, emoji: '✨', feeds: [gnSearch(name), bing(name)] };
}

const inflight = new Map();

async function getPack(key, day, env, ctx) {
  const kvKey = `pack:v2:${day}:${key}`;
  if (env.TALK_KV) {
    const cached = await env.TALK_KV.get(kvKey, 'json');
    if (cached) return { ...cached, cached: true };
  }
  // If two people open the app at the same moment, only generate once per isolate.
  if (inflight.has(kvKey)) return inflight.get(kvKey);
  const job = (async () => {
    const spec = packSpec(key);
    const headlines = await getHeadlines(key, day, env);
    let pack = null;
    if (headlines.length) pack = await generateWithAI(spec, headlines, env);
    if (!pack) pack = templatePack(spec, headlines);
    const out = {
      label: spec.label,
      emoji: spec.emoji,
      kind: spec.kind,
      points: pack.points.map((p, i) => ({ ...p, id: hash(`${day}|${key}|${i}|${p.headline}`) })),
      source: pack.source,
      generatedAt: new Date().toISOString(),
    };
    if (env.TALK_KV && out.points.length) {
      const ttl = out.source === 'template' ? FALLBACK_TTL : KV_TTL;
      const put = env.TALK_KV.put(kvKey, JSON.stringify(out), { expirationTtl: ttl }).catch(() => {});
      ctx && ctx.waitUntil ? ctx.waitUntil(put) : await put;
    }
    return out;
  })();
  inflight.set(kvKey, job);
  try { return await job; } finally { inflight.delete(kvKey); }
}

/* -------------------------------------------------------------- headlines */

async function getHeadlines(key, day, env, report) {
  const kvKey = `news:${day}:${key}`;
  if (env.TALK_KV && !report) {
    const cached = await env.TALK_KV.get(kvKey, 'json');
    if (cached && cached.length) return cached;
  }
  const spec = packSpec(key);
  let items = [];
  // Try each source in order until one gives us enough headlines.
  for (const url of spec.feeds) {
    const host = new URL(url).hostname;
    try {
      const res = await fetch(url, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
          accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        },
        redirect: 'follow',
        cf: { cacheTtl: 900 },
      });
      const found = res.ok ? parseRss(await res.text()) : [];
      if (report) report.push({ source: host, status: res.status, headlines: found.length });
      if (found.length > items.length) items = found;
      if (items.length >= 4) break;
    } catch (e) {
      if (report) report.push({ source: host, error: String(e && e.message || e) });
      console.error('feed failed', key, host, e);
    }
  }
  if (env.TALK_KV && items.length) {
    try { await env.TALK_KV.put(kvKey, JSON.stringify(items), { expirationTtl: KV_TTL }); } catch {}
  }
  return items;
}

export function parseRss(xml) {
  // Only look at the top of the feed: newest items are first, and it keeps CPU time tiny.
  const text = xml.slice(0, 60000);
  const out = [];
  const seen = new Set();
  const itemRe = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = itemRe.exec(text)) && out.length < 14) {
    const block = m[2];
    const rawTitle = decode(pick(block, 'title'));
    const source = decode(pick(block, 'source') || pick(block, 'News:Source')) || '';
    const link = decode(pick(block, 'link')) || ((/<link[^>]*href="([^"]+)"/.exec(block) || [])[1] || '');
    const pub = pick(block, 'pubDate') || pick(block, 'updated');
    let title = rawTitle;
    // Google News appends " - Source Name"
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    else title = title.replace(/\s+-\s+[^-]{2,40}$/, '');
    title = title.trim();
    if (!title || title.length < 12) continue;
    if (GRIM.test(title)) continue;
    const sig = title.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ').slice(0, 6).join(' ');
    if (seen.has(sig)) continue;
    seen.add(sig);
    let desc = decode(pick(block, 'description') || pick(block, 'summary')).replace(/\s+/g, ' ').trim();
    if (desc.toLowerCase().startsWith(title.toLowerCase().slice(0, 30))) desc = ''; // Google News just repeats the title
    if (desc.length > 220) desc = desc.slice(0, 219).replace(/\s+\S*$/, '') + '…';
    out.push({ title, source, link, pub, desc });
  }
  return out;
}

function pick(block, tag) {
  const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(block);
  if (!r) return '';
  return r[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}

function decode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/<[^>]+>/g, '')
    .trim();
}

/* --------------------------------------------------------------------- AI */

const SYSTEM_PROMPT = `You write small-talk ammo for office workers who find small talk exhausting.
Voice: a funny, self-aware friend. Warm, a little cynical, never mean. Everything must be safe to say out loud at work.
Rules:
- Skip any headline about deaths, crime, violence, tragedy, disasters, or anything graphic.
- Politics: only neutral, non-partisan observations people of any party could nod along to. No cheerleading, no insults.
- Never invent facts, scores, numbers or quotes that aren't in the headline. If you add context, keep it general and hedge it.
- Lines are spoken by the user in first person, in plain casual English. No hashtags. No emoji inside the lines.
- Return JSON only, matching the requested shape.`;

const POINT_SCHEMA = {
  type: 'object',
  properties: {
    points: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          idx: { type: 'integer' },
          headline: { type: 'string' },
          emoji: { type: 'string' },
          what: { type: 'string' },
          nod: { type: 'string' },
          nods: {
            type: 'object',
            properties: { dry: { type: 'string' }, dad: { type: 'string' }, cynical: { type: 'string' }, observational: { type: 'string' } },
            required: ['dry', 'dad', 'cynical', 'observational'],
          },
          takes: {
            type: 'object',
            properties: {
              dry: { type: 'string' },
              dad: { type: 'string' },
              cynical: { type: 'string' },
              observational: { type: 'string' },
            },
            required: ['dry', 'dad', 'cynical', 'observational'],
          },
          deep: { type: 'string' },
          ask: { type: 'string' },
          spice: { type: 'integer' },
        },
        required: ['idx', 'headline', 'what', 'nod', 'nods', 'takes', 'deep', 'ask', 'spice'],
      },
    },
  },
  required: ['points'],
};

function buildUserPrompt(spec, headlines) {
  const list = headlines
    .slice(0, 12)
    .map((h, i) => `${i + 1}. ${h.title}${h.source ? ` (${h.source})` : ''}${h.desc ? `\n   About: ${h.desc}` : ''}`)
    .join('\n');
  const flavor =
    spec.kind === 'team'
      ? `These are about the ${spec.label}. Assume the user barely follows them and needs to sound like a casual fan.`
      : spec.kind === 'cat' && spec.name === 'sports'
      ? 'Assume the user does not care about sports at all and just needs to survive the conversation.'
      : spec.kind === 'topic'
      ? `The user actually cares about ${spec.label}, so they can be a bit more knowledgeable here.`
      : spec.kind === 'local'
      ? `These are local news for ${spec.label}. Favor light, relatable local stories.`
      : '';
  return `Category: ${spec.label}. ${flavor}
Today's headlines:
${list}

Pick the ${POINTS_PER_PACK} best headlines for casual office chat (fewer if there aren't ${POINTS_PER_PACK} good, safe ones).
For each return:
- idx: the headline number
- headline: the story in 12 words or less, plain English
- emoji: one emoji that fits
- what: 25 words max. What actually happened, in plain neutral words, so someone who missed the news understands it. Only facts from the headline/About text.
- nod: 15 words max. A low-effort neutral line that lets you survive with a nod.
- nods: the same low-effort nod, one per humor style, 15 words max each: dry, dad, cynical, observational
- takes: one line in each humor style, 22 words max each:
    dry (deadpan understatement), dad (a pun or groaner), cynical (eye-roll, still kind), observational (the relatable absurd detail)
- deep: 30 words max. One angle that makes you sound informed. Hedge anything you're unsure of.
- ask: 14 words max. A question that hands the conversation to the other person.
- spice: 1 (totally safe), 2 (mild opinion), or 3 (has a real take)
Return {"points":[...]}`;
}

function providerOrder(env) {
  const order = [];
  const pref = (env.AI_PROVIDER || 'workers-ai').toLowerCase();
  if (pref === 'anthropic' && env.ANTHROPIC_API_KEY) order.push('anthropic');
  if (env.AI) order.push('workers-ai');
  if (pref !== 'anthropic' && env.ANTHROPIC_API_KEY) order.push('anthropic');
  return order;
}

async function generateWithAI(spec, headlines, env) {
  const user = buildUserPrompt(spec, headlines);
  for (const provider of providerOrder(env)) {
    try {
      const raw = provider === 'anthropic' ? await callAnthropic(env, user) : await callWorkersAI(env, user);
      const points = cleanPoints(raw, headlines);
      if (points.length) return { points, source: provider };
    } catch (e) {
      console.error(`${provider} failed for ${spec.label}:`, e && e.message ? e.message : e);
    }
  }
  return null;
}

async function callWorkersAI(env, user) {
  const model = env.AI_MODEL || DEFAULT_MODEL;
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
  let res;
  try {
    res = await env.AI.run(model, {
      messages,
      max_tokens: 2200,
      temperature: 0.8,
      response_format: { type: 'json_schema', json_schema: POINT_SCHEMA },
    });
  } catch (e) {
    // Some models don't support JSON mode; try once more as plain text.
    if (/quota|limit|neuron|429|capacity/i.test(String(e && e.message))) throw e;
    res = await env.AI.run(model, { messages, max_tokens: 2200, temperature: 0.8 });
  }
  return res && (res.response ?? res.result?.response ?? res);
}

async function callAnthropic(env, user) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
      max_tokens: 2200,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}`);
  const data = await r.json();
  return (data.content || []).map((c) => c.text || '').join('');
}

export function cleanPoints(raw, headlines) {
  let obj = raw;
  if (typeof raw === 'string') {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return [];
    try { obj = JSON.parse(raw.slice(start, end + 1)); } catch { return []; }
  }
  const list = Array.isArray(obj) ? obj : obj && Array.isArray(obj.points) ? obj.points : [];
  const clip = (s, n) => {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s;
  };
  const used = new Set();
  const out = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const i = Number(p.idx) - 1;
    const h = headlines[i] || null;
    const takes = p.takes || {};
    const point = {
      headline: clip(p.headline || (h && h.title), 110),
      emoji: clip(p.emoji, 4) || '💬',
      what: clip(p.what || (h && h.desc), 220),
      nod: clip(p.nod, 140),
      nods: {
        dry: clip(p.nods && p.nods.dry, 140),
        dad: clip(p.nods && p.nods.dad, 140),
        cynical: clip(p.nods && p.nods.cynical, 140),
        observational: clip(p.nods && p.nods.observational, 140),
      },
      takes: {
        dry: clip(takes.dry, 180),
        dad: clip(takes.dad, 180),
        cynical: clip(takes.cynical, 180),
        observational: clip(takes.observational, 180),
      },
      deep: clip(p.deep, 240),
      ask: clip(p.ask, 120),
      spice: Math.min(3, Math.max(1, Number(p.spice) || 1)),
      source: h ? h.source : '',
      link: h ? h.link : '',
    };
    if (!point.headline || !point.nod) continue;
    if (GRIM.test(point.headline)) continue;
    const anyTake = point.takes.dry || point.takes.dad || point.takes.cynical || point.takes.observational || point.nod;
    for (const k of Object.keys(point.takes)) if (!point.takes[k]) point.takes[k] = anyTake;
    for (const k of Object.keys(point.nods)) if (!point.nods[k]) point.nods[k] = point.nod;
    if (used.has(point.headline)) continue;
    used.add(point.headline);
    out.push(point);
    if (out.length >= POINTS_PER_PACK) break;
  }
  return out;
}

/* -------------------------------------------- no-AI fallback (still useful) */

export function templatePack(spec, headlines) {
  const pickOne = (arr, seed) => arr[seed % arr.length];
  const points = headlines.slice(0, POINTS_PER_PACK).map((h, i) => {
    const short = h.title.split(' ').slice(0, 10).join(' ') + (h.title.split(' ').length > 10 ? '…' : '');
    const seed = h.title.length + i;
    return {
      headline: h.title,
      emoji: spec.emoji,
      what: h.desc || '',
      nod: pickOne([`Did you see the thing about ${short}? Wild.`, `So… ${short}. Huh.`, `Apparently ${short}. What a week.`], seed),
      nods: {
        dry: `Saw the ${short} thing. Riveting.`,
        dad: `Did you hear about ${short}? Headline of the year.`,
        cynical: `${short}. Sure. Why not.`,
        observational: `Everyone's talking about ${short}, huh?`,
      },
      takes: {
        dry: pickOne([`Saw "${short}". Riveting stuff. Truly.`, `"${short}." Not how I expected today to go, but okay.`], seed),
        dad: pickOne([`"${short}" — I'd make a joke, but I'm still workshopping it.`, `"${short}." Headline writers are really earning their coffee today.`], seed),
        cynical: pickOne([`"${short}." Can't wait to hear about this for three more weeks.`, `"${short}." Sure. Why not. It's that kind of year.`], seed),
        observational: pickOne([`Has anyone actually read past the headline on "${short}"? Because I haven't.`, `"${short}" — feels like everyone's got an opinion on this already.`], seed),
      },
      deep: `Headline from ${h.source || 'the news'}. Skim it before you commit to a hot take.`,
      ask: pickOne(['Have you been following that at all?', 'Did you see that one?', 'What do you make of it?'], seed),
      spice: 1,
      source: h.source,
      link: h.link,
    };
  });
  return { points, source: 'template' };
}

/* ---------------------------------------------------------------- helpers */

export function dayKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  let d = new Date(`${get('year')}-${get('month')}-${get('day')}T00:00:00Z`);
  if (Number(get('hour')) % 24 < ROLLOVER_HOUR) d = new Date(d.getTime() - 86400000);
  return d.toISOString().slice(0, 10);
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
