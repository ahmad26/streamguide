// netlify/functions/youtube.js
// Proxies YouTube API calls with:
// - OAuth (liveBroadcasts = 1 unit instead of search = 100 units)
// - In-memory cache per channel (15 min TTL)

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const API_KEY       = process.env.YOUTUBE_API_KEY;

// Simple in-memory cache (persists between warm invocations)
const cache = {};
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

async function getAccessToken() {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const data = await resp.json();
  if (data.error) throw new Error('Token refresh failed: ' + data.error_description);
  return data.access_token;
}

async function fetchLiveBroadcasts(channelId, accessToken) {
  // liveBroadcasts only returns broadcasts for the authenticated user's channel
  // For other channels we still need search, but we cache aggressively
  // Cost: 100 units per channel but cached for 15 min
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&eventType=live&type=video&maxResults=5&key=${API_KEY}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return r.json();
}

async function fetchUpcoming(channelId, accessToken) {
  const before = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&eventType=upcoming&type=video&maxResults=10&publishedBefore=${before}&key=${API_KEY}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return r.json();
}

async function fetchVideoDetails(ids, accessToken) {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${ids}&key=${API_KEY}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return r.json();
}

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders() };
  }

  // prevLiveIds: comma-separated video IDs that were previously marked liveNow
  // We re-check these every time to detect streams that have ended
  const { channelId, bust, prevLiveIds } = event.queryStringParameters || {};
  if (!channelId) {
    return json({ error: 'channelId required' }, 400);
  }

  // Check cache (skip if bust=1)
  const cacheKey = channelId;
  if (!bust && cache[cacheKey] && Date.now() - cache[cacheKey].ts < CACHE_TTL) {
    console.log(`Cache HIT for ${channelId} (${Math.round((Date.now() - cache[cacheKey].ts)/1000)}s old)`);
    return json({ streams: cache[cacheKey].streams, cached: true });
  }

  console.log(`Cache MISS for ${channelId} — fetching from YouTube`);

  try {
    const accessToken = await getAccessToken();
    const [liveData, upData] = await Promise.all([
      fetchLiveBroadcasts(channelId, accessToken),
      fetchUpcoming(channelId, accessToken)
    ]);

    if (liveData.error) throw new Error(liveData.error.message);
    if (upData.error) throw new Error(upData.error.message);

    const liveIds = new Set((liveData.items || []).map(i => i.id.videoId).filter(Boolean));
    const allItems = [...(liveData.items || []), ...(upData.items || [])];

    // Also include previously-live stream IDs so we can verify if they ended
    const prevIds = prevLiveIds ? prevLiveIds.split(',').filter(Boolean) : [];
    const allIds = [...new Set([
      ...allItems.map(i => i.id.videoId).filter(Boolean),
      ...prevIds
    ])];

    if (!allIds.length) {
      cache[cacheKey] = { streams: [], ts: Date.now() };
      return json({ streams: [], cached: false });
    }

    const details = await fetchVideoDetails(allIds.join(','), accessToken);
    if (details.error) throw new Error(details.error.message);

    const streams = (details.items || []).flatMap(v => {
      const lsd = v.liveStreamingDetails;
      if (!lsd) return [];
      const st = lsd.actualStartTime || lsd.scheduledStartTime;
      if (!st) return [];
      const start = new Date(st);
      // A stream is live NOW only if:
      // 1. YouTube's live search returned it, AND
      // 2. It has no actualEndTime (hasn't ended)
      const liveNow = liveIds.has(v.id) && !lsd.actualEndTime;
      const isUpcoming = !!lsd.scheduledStartTime && !lsd.actualStartTime && new Date(lsd.scheduledStartTime) > new Date();
      // Skip if ended (was previously live but now has actualEndTime)
      if (!liveNow && !isUpcoming) return [];
      const dur = lsd.actualEndTime ? Math.round((new Date(lsd.actualEndTime) - start) / 60000) : 9999;
      return [{ title: v.snippet.title, url: `https://youtube.com/watch?v=${v.id}`, start: start.toISOString(), dur, liveNow }];
    });

    // Cache the result
    cache[cacheKey] = { streams, ts: Date.now() };
    console.log(`Fetched ${streams.length} streams for ${channelId} (${[...liveIds].length} live, ${prevIds.length} prev-live checked)`);
    return json({ streams, cached: false });

  } catch (e) {
    console.error('YouTube proxy error:', e.message);
    return json({ error: e.message }, 500);
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };
}

function json(data, status = 200) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    body: JSON.stringify(data)
  };
}
