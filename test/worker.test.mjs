// Quick offline test: fake KV, fake AI, fake RSS. Run with `npm test`.
import worker, { parseRss, cleanPoints, templatePack, dayKey } from '../src/index.js';
import assert from 'node:assert/strict';

const rss = `<?xml version="1.0"?><rss><channel><title>Top stories</title>
<item><title>Bears rally late to stun Packers at Soldier Field - Chicago Tribune</title><link>https://example.com/a</link><pubDate>Fri, 03 Oct 2026 12:00:00 GMT</pubDate><source url="https://chicagotribune.com">Chicago Tribune</source></item>
<item><title>Man killed in crash on I-90 - WGN</title><link>https://example.com/b</link><source url="x">WGN</source></item>
<item><title>Apple quietly kills the headphone jack on yet another device &amp; fans shrug - The Verge</title><link>https://example.com/c</link><source url="x">The Verge</source></item>
<item><title><![CDATA[Pumpkin spice everything returns earlier than ever - NPR]]></title><link>https://example.com/d</link><source url="x">NPR</source></item>
<item><title>Short - X</title><link>https://example.com/e</link></item>
</channel></rss>`;

const items = parseRss(rss);
assert.equal(items.length, 3, 'grim + too-short headlines filtered');
assert.equal(items[0].title, 'Bears rally late to stun Packers at Soldier Field');
assert.equal(items[0].source, 'Chicago Tribune');
assert.ok(items[1].title.includes('&'), 'entities decoded');
assert.equal(items[2].title, 'Pumpkin spice everything returns earlier than ever');

const aiOut = { points: [
  { idx: 1, headline: 'Bears win a wild one over the Packers', emoji: '🐻', nod: 'Bears actually won. Weird week.', takes: { dry: 'A Bears win. I had to sit down.', dad: 'Un-bear-lievable.', cynical: 'Enjoy it, it will not last.', observational: 'Everyone in the elevator suddenly has a jersey.' }, deep: 'Late rally, divisional rival.', ask: 'Did you catch the ending?', spice: 2 },
  { idx: 2, headline: 'Headphone jack gone again', nod: 'RIP jack', takes: { dry: 'Shocking.' }, deep: 'x', ask: 'y', spice: 9 },
]};
const pts = cleanPoints(JSON.stringify(aiOut), items);
assert.equal(pts.length, 2);
assert.equal(pts[1].spice, 3, 'spice clamped');
assert.equal(pts[1].takes.dad, 'Shocking.', 'missing takes filled');
assert.equal(pts[0].source, 'Chicago Tribune');
assert.equal(cleanPoints('garbage', items).length, 0);

const tp = templatePack({ emoji: '🗞️' }, items);
assert.equal(tp.points.length, 3);
assert.equal(tp.source, 'template');

// rollover: 4am Central -> previous day; 9am -> same day
assert.equal(dayKey(new Date('2026-10-03T09:00:00Z')), '2026-10-02'); // 4am CDT
assert.equal(dayKey(new Date('2026-10-03T14:00:00Z')), '2026-10-03'); // 9am CDT

// end-to-end through fetch() with fakes
const store = new Map();
const kv = {
  async get(k, t) { const v = store.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); },
};
let aiCalls = 0;
const env = {
  TALK_KV: kv,
  AI: { async run(model, input) { aiCalls++; assert.ok(input.messages[1].content.includes('Bears rally')); return { response: aiOut }; } },
};
globalThis.fetch = async (u) => new Response(rss, { status: 200 });
const ctx = { waitUntil: (p) => p };

const r1 = await worker.fetch(new Request('https://x/api/pack?key=team:Chicago%20Bears'), env, ctx);
const j1 = await r1.json();
assert.equal(r1.status, 200);
assert.equal(j1.source, 'workers-ai');
assert.equal(j1.points.length, 2);
assert.ok(j1.points[0].id);
const r2 = await worker.fetch(new Request('https://x/api/pack?key=team:chicago bears'), env, ctx);
const j2 = await r2.json();
assert.equal(j2.cached, true);
assert.equal(aiCalls, 1, 'second request served from KV, no extra AI call');

// AI failure -> template fallback
const env2 = { TALK_KV: kv, AI: { async run() { throw new Error('3036: daily free allocation of neurons exceeded'); } } };
const j3 = await (await worker.fetch(new Request('https://x/api/pack?key=cat:tech'), env2, ctx)).json();
assert.equal(j3.source, 'template');
assert.equal(j3.points.length, 3);

// bad keys rejected
assert.equal((await worker.fetch(new Request('https://x/api/pack?key=cat:nope'), env, ctx)).status, 400);
assert.equal((await worker.fetch(new Request('https://x/api/pack?key=<script>'), env, ctx)).status, 400);

// ratings aggregate without user ids
const rr = await worker.fetch(new Request('https://x/api/rate', { method: 'POST', body: JSON.stringify({ verdict: 'nailed', pack: 'team:chicago bears' }) }), env, ctx);
const rj = await rr.json();
assert.equal(rj.total, 1); assert.equal(rj.effective, 100);
await worker.fetch(new Request('https://x/api/rate', { method: 'POST', body: JSON.stringify({ verdict: 'flopped', pack: 'cat:tech' }) }), env, ctx);
const sj = await (await worker.fetch(new Request('https://x/api/stats'), env, ctx)).json();
assert.equal(sj.total, 2); assert.equal(sj.effective, 50);

// cron warms top + sports and caches headlines for the rest
store.clear(); aiCalls = 0;
await worker.scheduled({}, { ...env, PREWARM: 'cat:top,cat:sports' }, ctx);
assert.equal(aiCalls, 2);
assert.ok([...store.keys()].some((k) => k.startsWith('news:') && k.endsWith('cat:gaming')));

console.log('✅ all worker tests passed');

// Atom feeds and Bing's <News:Source>
const atom = `<feed><entry><title>Studio announces sequel to surprise indie hit</title><link rel="alternate" href="https://example.com/x"/><updated>2026-10-03</updated></entry></feed>`;
const a = parseRss(atom);
assert.equal(a.length, 1); assert.equal(a[0].link, 'https://example.com/x');
const bingXml = `<rss><channel><item><title>Cubs announce new manager search begins</title><link>https://bing.com/x</link><News:Source>Chicago Sun-Times</News:Source></item></channel></rss>`;
assert.equal(parseRss(bingXml)[0].source, 'Chicago Sun-Times');

// Google blocked -> falls through to the next source
store.clear();
let hits = [];
globalThis.fetch = async (u) => { hits.push(new URL(u).hostname); return u.includes('news.google.com') ? new Response('nope', { status: 403 }) : new Response(rss, { status: 200 }); };
const dj = await (await worker.fetch(new Request('https://x/api/debug?key=cat:top'), env, ctx)).json();
assert.equal(dj.sources[0].status, 403);
assert.equal(dj.sources[1].headlines, 3);
assert.deepEqual(hits.slice(0, 2), ['news.google.com', 'feeds.npr.org']);
console.log('✅ fallback source tests passed');

import { editionKey } from '../src/index.js';
assert.equal(editionKey(new Date('2026-10-03T15:00:00Z')), '2026-10-03-am'); // 10am CDT
assert.equal(editionKey(new Date('2026-10-03T19:00:00Z')), '2026-10-03-pm'); // 2pm CDT
assert.equal(editionKey(new Date('2026-10-04T08:00:00Z')), '2026-10-03-pm'); // 3am CDT, still last night
const pv = await (await worker.fetch(new Request('https://x/api/poll?id=hotdog', { method: 'POST', body: JSON.stringify({ choice: 'a' }) }), env, ctx)).json();
assert.deepEqual(pv.votes, { a: 1, b: 0 });
assert.equal((await worker.fetch(new Request('https://x/api/poll?id=../x'), env, ctx)).status, 400);
console.log('✅ edition + poll tests passed');
