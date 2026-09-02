import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSignals, client, configuration, durationSeconds, metricUpdate, run, searchQueries } from '../scripts/daily-youtube.mjs';

const now = new Date('2026-09-01T01:00:00Z');
const first = 'abcdefghijk';
const second = 'ABCDEFGHIJK';
const search = id => ({ id: { videoId: id } });
const video = (id, views = 5000) => ({ id, snippet: { title: 'Preschool classroom craft', description: 'teacher activity', channelTitle: 'School', publishedAt: '2026-08-31T20:00:00Z' }, statistics: { viewCount: String(views), likeCount: '50', commentCount: '10' }, contentDetails: { duration: 'PT45S' } });

test('relevant zero-view learning videos qualify with balanced activity and celebration searches', () => {
  const v = video(first,0);
  v.snippet.title = 'Preschool alphabet learning game';
  assert.equal(buildSignals([search(first)],[v],now)[0].qualified,true);
  assert.equal(searchQueries(now).length,3);
  assert.match(searchQueries(now)[2],/preschool celebration/);
  assert.doesNotMatch(searchQueries(new Date('2026-09-06T01:00:00Z'))[2],/teachers day/);
});

test('multiple searches deduplicate IDs and video detail requests are batched at fifty', async () => {
  const ids = Array.from({length:75},(_,i)=>String(i).padStart(11,'0'));
  const {api} = mockApi();
  let searches = 0;
  const batches = [];
  api.youtube = async (endpoint,params) => {
    if(endpoint === 'search') return {items:ids.slice(searches++ *25,searches*25).map(search)};
    const batch = params.id.split(','); batches.push(batch.length);
    return {items:batch.map(id=>video(id,0))};
  };
  assert.equal((await run(api,now,()=>{})).processed,75);
  assert.deepEqual(batches,[50,25]);
});

test('statistics join by video ID, deduplicate, preserve source title', () => {
  const records = buildSignals([search(first), search(second), search(first)], [video(second, 9000), video(first, 5000)], now);
  assert.equal(records.length, 2);
  assert.equal(records[0].views, 5000);
  assert.equal(records[1].views, 9000);
  assert.equal(records[0].title, 'Preschool classroom craft');
  assert.equal(records[0].source_url, `https://www.youtube.com/watch?v=${first}`);
});
test('missing statistics fails without pretending zero', () => {
  assert.throws(() => buildSignals([search(first)], [], now), /omitted/);
  const v = video(first); v.statistics = {};
  assert.throws(() => buildSignals([search(first)], [v], now), /missing/);
});
test('exclude irrelevant, old, future and long content', () => {
  for (const modify of [v => { v.snippet.title = 'Gaming news'; }, v => { v.snippet.publishedAt = '2026-01-01'; }, v => { v.snippet.publishedAt = '2026-09-02'; }, v => { v.contentDetails.duration = 'PT4M'; }]) {
    const v = video(first); modify(v);
    assert.equal(buildSignals([search(first)], [v], now).length, 0);
  }
  assert.equal(durationSeconds('PT3M'), 180);
});
test('updates cannot overwrite references, titles, approvals or discovery date', () => {
  const patch = metricUpdate(buildSignals([search(first)], [video(first)], now)[0]);
  for (const field of ['signal_id', 'source_url', 'title', 'discovered_at', 'decision', 'status']) assert.equal(field in patch, false);
});
test('configuration refuses absent secrets and wrong project', () => {
  assert.throws(() => configuration({}), /Missing/);
  assert.throws(() => configuration({ SUPABASE_URL: 'https://wrong.supabase.co', YOUTUBE_API_KEY: 'x', SUPABASE_SERVICE_ROLE_KEY: 'y' }), /existing Marketing/);
});
test('request failure sanitizes responses and retries transient GET errors', async () => {
  let calls = 0;
  const api = client({ base: 'https://example.invalid', supabaseKey: 'SECRET', youtubeKey: 'SECRET' }, async () => {
    calls++;
    return new Response('SECRET', { status: 503 });
  }, async () => {});
  await assert.rejects(api.youtube('search', {}), error => !error.message.includes('SECRET') && error.message.includes('503'));
  assert.equal(calls, 3);
  assert.throws(() => api.db('approvals'), /outside collector scope/);
});

function mockApi({ existing = false, failVerification = false, empty = false } = {}) {
  const rows = new Map();
  if (existing) rows.set(`YOUTUBE-${first}`, { signal_id: `YOUTUBE-${first}`, title: 'Original title', source_url: 'https://www.youtube.com/shorts/abcdefghijk', discovered_at: '2026-08-31T00:00:00Z' });
  const writes = [];
  const api = {
    youtube: async endpoint => endpoint === 'search' ? { items: empty ? [] : [search(first)] } : { items: [video(first)] },
    db: async (table, options = {}) => {
      const method = options.method || 'GET';
      if (method !== 'GET') writes.push({ table, ...options });
      if (table === 'automation_runs') return method === 'POST' ? [{ id: 42 }] : [{ id: 42, ...options.body }];
      assert.equal(table, 'trend_signals');
      if (method === 'POST') for (const row of options.body) if (!rows.has(row.signal_id)) rows.set(row.signal_id, { ...row });
      if (method === 'PATCH') Object.assign(rows.get(options.query.signal_id.slice(3)), options.body);
      if (method === 'GET') {
        if (options.query.limit) return [];
        if (failVerification && options.query.select.includes('views')) return [];
        return [...rows.values()];
      }
      return null;
    },
  };
  return { api, rows, writes };
}
test('fresh run verifies writes and second run does not insert duplicates', async () => {
  const { api, rows, writes } = mockApi();
  assert.deepEqual(await run(api, now, () => {}), { processed: 1, newCandidates: 1 });
  assert.deepEqual(await run(api, now, () => {}), { processed: 1, newCandidates: 0 });
  assert.equal(rows.size, 1);
  assert.equal(writes.filter(w => w.table === 'trend_signals' && w.method === 'POST').length, 1);
});
test('existing rows preserve original links and discovery date', async () => {
  const { api, rows } = mockApi({ existing: true });
  await run(api, now, () => {});
  const row = rows.get(`YOUTUBE-${first}`);
  assert.equal(row.title, 'Original title');
  assert.equal(row.discovered_at, '2026-08-31T00:00:00Z');
  assert.equal(row.views, 5000);
});
test('verification failure records FAILED, never SUCCESS', async () => {
  const { api, writes } = mockApi({ failVerification: true });
  await assert.rejects(run(api, now, () => {}), /verification failed/);
  assert.equal(writes.at(-1).body.status, 'FAILED');
  assert.equal(writes.some(w => w.body?.status === 'SUCCESS'), false);
});
test('successful empty searches record zero matches without inserting older content', async () => {
  const { api, writes } = mockApi({ empty: true });
  assert.deepEqual(await run(api, now, () => {}),{processed:0,newCandidates:0});
  assert.equal(writes.some(w => w.table === 'trend_signals'), false);
  assert.equal(writes.at(-1).body.status, 'SUCCESS');
});

test('yesterday uploads are excluded even when discovered today', () => {
  const v=video(first); v.snippet.publishedAt='2026-08-31T18:29:59Z';
  assert.deepEqual(buildSignals([search(first)],[v],now),[]);
  v.snippet.publishedAt='2026-08-31T18:30:00Z';
  assert.equal(buildSignals([search(first)],[v],now).length,1);
});
