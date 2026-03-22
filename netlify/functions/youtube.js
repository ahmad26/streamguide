// netlify/functions/youtube.js
// Cost with OAuth:    ~4 units per channel (liveBroadcasts=1, channels=1, playlistItems=1, videos=1)
// Cost without OAuth: ~201 units per channel (search live=100, search upcoming=100, videos=1)

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const API_KEY       = process.env.YOUTUBE_API_KEY;

const cache = {};
const CACHE_TTL = 15 * 60 * 1000;

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

// liveBroadcasts API: 1 unit, returns all live/upcoming for authenticated user
// We filter by channelId after fetching
async function fetchViaLiveBroadcasts(channelId, accessToken) {
  const [liveResp, upResp] = await Promise.all([
    fetch(`https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,status&broadcastStatus=active&broadcastType=all&maxResults=50&key=${API_KEY}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }),
    fetch(`https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,status&broadcastStatus=upcoming&broadcastType=all&maxResults=50&key=${API_KEY}`,
      { headers: { Authorization: `Bearer ${accessToken}` } })
  ]);
  const [liveData, upData] = await Promise.all([liveResp.json(), upResp.json()]);
  if (liveData.error) throw new Error('liveBroadcasts: ' + liveData.error.message);
  if (upData.error) throw new Error('liveBroadcasts upcoming: ' + upData.error.message);
  const allItems = [...(liveData.items||[]), ...(upData.items||[])];
  const channelItems = allItems.filter(i => i.snippet?.channelId === channelId);
  const liveIds = new Set((liveData.items||[]).filter(i=>i.snippet?.channelId===channelId).map(i=>i.id));
  return { videoIds: channelItems.map(i=>i.id).filter(Boolean), liveIds };
}

// playlistItems: 2 units (1 for channels, 1 for playlistItems)
async function fetchUpcomingViaPlaylist(channelId, accessToken) {
  const chResp = await fetch(
    `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${channelId}&key=${API_KEY}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const chData = await chResp.json();
  const uploadsId = chData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsId) return [];
  const plResp = await fetch(
    `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsId}&maxResults=15&key=${API_KEY}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const plData = await plResp.json();
  return (plData.items||[]).map(i=>i.snippet?.resourceId?.videoId).filter(Boolean);
}

// search: 100 units each — fallback when no OAuth
async function fetchViaSearch(channelId) {
  const before = new Date(Date.now() + 7*24*60*60*1000).toISOString();
  const [lr, ur] = await Promise.all([
    fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&eventType=live&type=video&maxResults=5&key=${API_KEY}`),
    fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&eventType=upcoming&type=video&maxResults=10&publishedBefore=${before}&key=${API_KEY}`)
  ]);
  const [ld, ud] = await Promise.all([lr.json(), ur.json()]);
  if (ld.error) throw new Error(ld.error.message);
  if (ud.error) throw new Error(ud.error.message);
  const liveIds = new Set((ld.items||[]).map(i=>i.id.videoId).filter(Boolean));
  const allItems = [...(ld.items||[]), ...(ud.items||[])];
  return { videoIds: allItems.map(i=>i.id.videoId).filter(Boolean), liveIds };
}

async function fetchVideoDetails(ids, accessToken) {
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  const r = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${ids}&key=${API_KEY}`,
    { headers }
  );
  return r.json();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders() };

  const { channelId, bust, prevLiveIds } = event.queryStringParameters || {};
  if (!channelId) return json({ error: 'channelId required' }, 400);

  if (!bust && cache[channelId] && Date.now() - cache[channelId].ts < CACHE_TTL) {
    console.log(`Cache HIT for ${channelId}`);
    return json({ streams: cache[channelId].streams, cached: true });
  }

  try {
    let videoIds = [], liveIds = new Set(), accessToken = null;

    if (REFRESH_TOKEN) {
      try {
        accessToken = await getAccessToken();
        // liveBroadcasts for live (1 unit)
        const liveResult = await fetchViaLiveBroadcasts(channelId, accessToken);
        liveIds = liveResult.liveIds;
        videoIds.push(...liveResult.videoIds);
        // playlistItems for upcoming (2 units)
        const upIds = await fetchUpcomingViaPlaylist(channelId, accessToken);
        videoIds.push(...upIds);
        console.log(`OAuth: ${videoIds.length} candidates for ${channelId} (~4 units)`);
      } catch(e) {
        console.warn(`OAuth failed, using search fallback:`, e.message);
        accessToken = null;
        const r = await fetchViaSearch(channelId);
        videoIds = r.videoIds; liveIds = r.liveIds;
      }
    } else {
      const r = await fetchViaSearch(channelId);
      videoIds = r.videoIds; liveIds = r.liveIds;
      console.log(`No OAuth — search used (~201 units) for ${channelId}`);
    }

    const prevIds = prevLiveIds ? prevLiveIds.split(',').filter(Boolean) : [];
    const allIds = [...new Set([...videoIds, ...prevIds])].filter(Boolean);

    if (!allIds.length) {
      cache[channelId] = { streams: [], ts: Date.now() };
      return json({ streams: [], cached: false });
    }

    const details = await fetchVideoDetails(allIds.join(','), accessToken);
    if (details.error) throw new Error(details.error.message);

    const streams = (details.items||[]).flatMap(v => {
      const lsd = v.liveStreamingDetails;
      if (!lsd) return [];
      const st = lsd.actualStartTime || lsd.scheduledStartTime;
      if (!st) return [];
      const start = new Date(st);
      const liveNow = liveIds.has(v.id) && !lsd.actualEndTime;
      const isUpcoming = !!lsd.scheduledStartTime && !lsd.actualStartTime && new Date(lsd.scheduledStartTime) > new Date();
      if (!liveNow && !isUpcoming) return [];
      const dur = lsd.actualEndTime ? Math.round((new Date(lsd.actualEndTime)-start)/60000) : 9999;
      return [{ title: v.snippet.title, url: `https://youtube.com/watch?v=${v.id}`, start: start.toISOString(), dur, liveNow }];
    });

    cache[channelId] = { streams, ts: Date.now() };
    return json({ streams, cached: false });

  } catch(e) {
    console.error('YouTube proxy error:', e.message);
    return json({ error: e.message }, 500);
  }
};

function corsHeaders() {
  return { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET, OPTIONS' };
}
function json(data, status=200) {
  return { statusCode: status, headers: { 'Content-Type':'application/json', ...corsHeaders() }, body: JSON.stringify(data) };
}
