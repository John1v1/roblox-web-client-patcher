// Public Roblox game lookup fallback for this private setup page.
// The browser tries CORS-enabled RoProxy first. If its CSP blocks that request,
// this same-origin route tries the same fixed public endpoints server-side.
// No secrets, accounts, arbitrary URLs, or forwarded cookies.
const USERNAME = /^[A-Za-z0-9_]{3,20}$/;
const USER_API = 'https://users.roproxy.com/v1/users/search';
const MAX_PAGES = 5;

function reply(data, status = 200) {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
}

async function publicJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      ...options,
      headers: { accept: 'application/json', ...(options.headers || {}) },
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) throw new Error('Roblox API HTTP ' + response.status);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/roblox-games') return reply({ error: 'Not found' }, 404);
    if (request.method !== 'GET') return reply({ error: 'GET only' }, 405);
    const requested = (url.searchParams.get('username') || '').trim();
    if (!USERNAME.test(requested)) {
      return reply({ error: 'Enter a Roblox username (3–20 letters, numbers or underscores).' }, 400);
    }
    try {
      let user = null;
      let userCursor = null;
      for (let page = 0; page < 3; page++) {
        const query = new URLSearchParams({ keyword: requested, limit: '50' });
        if (userCursor) query.set('cursor', userCursor);
        const resolution = await publicJson(USER_API + '?' + query);
        user = Array.isArray(resolution.data)
          ? resolution.data.find(item => String(item.name || '').toLowerCase() === requested.toLowerCase())
          : null;
        if (user) break;
        userCursor = resolution.nextPageCursor;
        if (!userCursor) break;
      }
      if (!user || String(user.name || '').toLowerCase() !== requested.toLowerCase() ||
          !Number.isSafeInteger(user.id) || user.id < 1) {
        return reply({ error: 'No exact Roblox username found. You can enter a Place ID manually.' }, 404);
      }
      const games = [];
      const seen = new Set();
      let cursor = null;
      let pages = 0;
      do {
        const query = new URLSearchParams({ accessFilter: 'Public', limit: '50', sortOrder: 'Asc' });
        if (cursor) query.set('cursor', cursor);
        const result = await publicJson('https://games.roproxy.com/v2/users/' + user.id + '/games?' + query);
        if (!Array.isArray(result.data)) throw new Error('Unexpected games response');
        for (const game of result.data) {
          const place = game.rootPlace && game.rootPlace.id;
          if (!Number.isSafeInteger(place) || place < 1 || seen.has(place)) continue;
          seen.add(place);
          games.push({ name: String(game.name || 'Untitled').slice(0, 100),
                       placeId: String(place), universeId: String(game.id || '') });
        }
        pages++;
        cursor = typeof result.nextPageCursor === 'string' && result.nextPageCursor ? result.nextPageCursor : null;
      } while (cursor && pages < MAX_PAGES);
      return reply({ user: { id: String(user.id), name: user.name, displayName: user.displayName || user.name },
                     games, truncated: Boolean(cursor) });
    } catch (_) {
      // Do not echo upstream bodies/user details; manual ID entry remains available.
      return reply({ error: 'Roblox lookup is temporarily unavailable. Enter your public Place ID manually.' }, 502);
    }
  },
};
