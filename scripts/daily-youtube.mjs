import { pathToFileURL } from 'node:url';

const EXPECTED_HOST = 'axnlojkpcetilimwejxp.supabase.co';
const KEYWORDS = ['preschool', 'kindergarten', 'classroom', 'teacher', 'kids activity', 'children activity', 'school celebration', 'school event', 'craft', 'learning activity', 'toddler'];
const EXCLUDE = ['news', 'full movie', 'gaming'];
export const QUERY = 'preschool classroom activity|kindergarten games|preschool learning activity -news -gaming';

export function indiaDay(now) {
  return new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
}
export function searchQueries() {
  return [QUERY, 'preschool craft|kindergarten classroom games|preschool sensory activity -news -gaming',
    'preschool celebration|kindergarten school event|preschool festival activity -news'];
}

export function configuration(env) {
  for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'YOUTUBE_API_KEY']) {
    if (!env[key]?.trim()) throw new Error(`Missing GitHub secret: ${key}`);
  }
  let url;
  try { url = new URL(env.SUPABASE_URL.trim()); } catch { throw new Error('Invalid SUPABASE_URL'); }
  if (url.protocol !== 'https:' || url.host !== EXPECTED_HOST || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('SUPABASE_URL must point to the existing Marketing Automation project');
  }
  return { base: url.origin, supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY.trim(), youtubeKey: env.YOUTUBE_API_KEY.trim() };
}

export function durationSeconds(value) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value || '');
  return match ? Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0) : NaN;
}

export function buildSignals(searchItems, videos, now = new Date()) {
  const details = new Map(videos.map(video => [video.id, video]));
  const seen = new Set();
  const records = [];
  for (const item of searchItems) {
    const id = item.id?.videoId;
    if (!/^[A-Za-z0-9_-]{11}$/.test(id || '') || seen.has(id)) continue;
    seen.add(id);
    const video = details.get(id);
    if (!video) throw new Error('YouTube statistics response omitted a requested video; no signals saved');
    const s = video.snippet || item.snippet;
    const published = new Date(s?.publishedAt);
    const duration = durationSeconds(video.contentDetails?.duration);
    if (!s?.title || !Number.isFinite(published.getTime()) || published > now || indiaDay(published) !== indiaDay(now) || !(duration > 0 && duration <= 180)) continue;
    const text = `${s.title} ${s.description || ''}`.toLowerCase();
    const topics = KEYWORDS.filter(word => text.includes(word));
    if (!topics.length || EXCLUDE.some(word => text.includes(word))) continue;
    const views = Number(video.statistics?.viewCount);
    if (!Number.isFinite(views) || views < 0) throw new Error('YouTube view statistics missing; refusing fabricated zero counts');
    const likes = Number(video.statistics?.likeCount || 0);
    const comments = Number(video.statistics?.commentCount || 0);
    if (![likes, comments].every(n => Number.isFinite(n) && n >= 0)) throw new Error('Invalid YouTube engagement statistics');
    const hours = Math.max(1, (now - published) / 3600000);
    const velocity = views / hours;
    const engagement = views ? (likes + comments) / views * 100 : 0;
    const relevance = Math.min(100, 50 + topics.length * 10);
    const url = `https://www.youtube.com/watch?v=${id}`;
    records.push({
      signal_id: `YOUTUBE-${id}`, source: 'YouTube Preschool Reels', source_url: url,
      creator: s.channelTitle || '', title: s.title, format: 'SHORT_VIDEO',
      published_at: published.toISOString(), discovered_at: now.toISOString(),
      trend_stage: velocity >= 500 || views >= 100000 ? 'VIRAL' : velocity >= 100 || views >= 25000 ? 'RISING' : 'EMERGING',
      views, engagement_rate: Number(engagement.toFixed(2)),
      velocity_score: Math.min(100, Math.round(Math.log10(velocity + 1) * 30)),
      confidence_score: Math.min(100, Math.round(45 + Math.min(views / 1000, 25) + Math.min(engagement * 5, 30))),
      geographies: ['India'], topics, preschool_relevance_score: relevance,
      qualified: relevance >= 60,
      relevance_reason: `Preschool short video. ${views} views, ${likes} likes, ${comments} comments, ${Math.round(velocity)} views/hour. Heuristic trend score, not an official viral ranking.`,
      raw_payload: { video_id: id, direct_video_url: url, thumbnail_url: s.thumbnails?.high?.url || s.thumbnails?.default?.url || '', description: s.description || '', statistics: video.statistics, content_details: video.contentDetails },
    });
  }
  return records;
}

// Existing references, discovery dates, titles and URLs remain unchanged.
export function metricUpdate(record) {
  return Object.fromEntries(['trend_stage', 'views', 'engagement_rate', 'velocity_score', 'confidence_score', 'preschool_relevance_score', 'qualified', 'relevance_reason', 'raw_payload'].map(key => [key, record[key]]));
}

export function client(config, fetcher = fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  async function request(url, options, label, retry = true) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) });
      } catch {
        if (retry && attempt < 2) { await wait(1000 * 2 ** attempt); continue; }
        throw new Error(`${label}: network failure or timeout`);
      }
      if (!response.ok) {
        if (retry && attempt < 2 && (response.status === 429 || response.status >= 500)) { await wait(1000 * 2 ** attempt); continue; }
        // Never print raw responses, request URLs or headers: they may contain secrets.
        throw new Error(`${label}: HTTP ${response.status}; check service status, credentials and table permissions`);
      }
      if (response.status === 204) return null;
      const text = await response.text();
      try { return text ? JSON.parse(text) : null; } catch { throw new Error(`${label}: invalid JSON response`); }
    }
  }
  return {
    youtube: (endpoint, params) => {
      const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
      url.search = new URLSearchParams({ ...params, key: config.youtubeKey });
      return request(url, {}, `YouTube ${endpoint}`);
    },
    db: (table, { method = 'GET', query = {}, body, prefer } = {}) => {
      if (!['trend_signals', 'automation_runs'].includes(table)) throw new Error('Table outside collector scope');
      const url = new URL(`${config.base}/rest/v1/${table}`);
      url.search = new URLSearchParams(query);
      return request(url, { method, headers: { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, `Supabase ${table} ${method}`, method !== 'POST' || table === 'trend_signals');
    },
  };
}

export async function run(api, now = new Date(), log = console.log) {
  let runId;
  try {
    // Preflight existing schema; never create or migrate tables.
    await api.db('trend_signals', { query: { select: 'signal_id,discovered_at,views,qualified,preschool_relevance_score', limit: '1' } });
    const started = await api.db('automation_runs', { method: 'POST', prefer: 'return=representation', body: { workflow_name: 'VT A0 - GitHub Daily YouTube Collector', owner: 'A0', started_at: now.toISOString(), status: 'RUNNING', processed_count: 0 } });
    runId = started?.[0]?.id;
    if (runId === undefined || runId === null) throw new Error('Automation run ID missing');
    const noMatches = async () => {
      const finished = await api.db('automation_runs', {method:'PATCH', query:{id:`eq.${runId}`}, prefer:'return=representation', body:{status:'SUCCESS',ended_at:new Date().toISOString(),processed_count:0}});
      if (finished?.[0]?.status !== 'SUCCESS') throw new Error('Could not verify empty collection run');
      log('Search completed: no matching preschool videos published today yet. Older videos were not substituted.');
      return {processed:0,newCandidates:0};
    };
    const search = {items: []};
    for (const q of searchQueries(now)) {
      const result = await api.youtube('search', { part: 'snippet', type: 'video', maxResults: '25', order: 'date', publishedAfter: new Date(`${indiaDay(now)}T00:00:00+05:30`).toISOString(), regionCode: 'IN', relevanceLanguage: 'en', videoDuration: 'short', q });
      if (!Array.isArray(result.items)) throw new Error('Invalid YouTube search response');
      search.items.push(...result.items);
    }
    if (!search.items.length) return await noMatches();
    const ids = [...new Set(search.items.map(i => i.id?.videoId).filter(id => /^[A-Za-z0-9_-]{11}$/.test(id || '')))];
    if (!ids.length) throw new Error('No valid YouTube video IDs');
    const videos = {items: []};
    for (let offset = 0; offset < ids.length; offset += 50) {
      const result = await api.youtube('videos', { part: 'snippet,statistics,contentDetails', id: ids.slice(offset, offset + 50).join(',') });
      if (!Array.isArray(result.items)) throw new Error('Invalid YouTube statistics response');
      videos.items.push(...result.items);
    }
    const records = buildSignals(search.items, videos.items, now);
    if (!records.length) return await noMatches();
    const filter = `in.(${records.map(r => r.signal_id).join(',')})`;
    const existing = await api.db('trend_signals', { query: { select: 'signal_id', signal_id: filter } });
    if (!Array.isArray(existing)) throw new Error('Could not verify existing signals');
    const known = new Set(existing.map(r => r.signal_id));
    const fresh = records.filter(r => !known.has(r.signal_id));
    if (fresh.length) await api.db('trend_signals', { method: 'POST', query: { on_conflict: 'signal_id' }, prefer: 'resolution=ignore-duplicates,return=minimal', body: fresh });
    for (const record of records) {
      await api.db('trend_signals', { method: 'PATCH', query: { signal_id: `eq.${record.signal_id}` }, prefer: 'return=minimal', body: metricUpdate(record) });
    }
    const saved = await api.db('trend_signals', { query: { select: 'signal_id,views,velocity_score', signal_id: filter } });
    if (!Array.isArray(saved) || records.some(r => !saved.some(s => s.signal_id === r.signal_id && Number(s.views) === r.views && Number(s.velocity_score) === r.velocity_score))) throw new Error('Saved signal read-back verification failed');
    const finished = await api.db('automation_runs', { method: 'PATCH', query: { id: `eq.${runId}` }, prefer: 'return=representation', body: { status: 'SUCCESS', ended_at: new Date().toISOString(), processed_count: records.length } });
    if (finished?.[0]?.status !== 'SUCCESS') throw new Error('Could not verify SUCCESS run log');
    log(`Verified ${records.length} YouTube signals; ${fresh.length} new candidates, ${known.size} existing. Approvals untouched.`);
    if (!fresh.length) log('No new video IDs today; existing statistics refreshed. New content is not guaranteed each day.');
    return { processed: records.length, newCandidates: fresh.length };
  } catch (error) {
    if (runId !== undefined && runId !== null) {
      try { await api.db('automation_runs', { method: 'PATCH', query: { id: `eq.${runId}` }, body: { status: 'FAILED', ended_at: new Date().toISOString() } }); } catch { log('Could not record failure in Supabase; see failed GitHub run.'); }
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await run(client(configuration(process.env))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
