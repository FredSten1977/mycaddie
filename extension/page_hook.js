// Runs inside portal.trackmangolf.com (page world).
// The portal keeps its TrackMan login only in memory and attaches it to its own
// GraphQL requests. This hook remembers those request headers and uses them for
// My Caddie's read-only queries. Nothing here leaves the page: the headers are
// never posted to the extension, only query results are.
(() => {
  if (window.__myCaddieHook) return;
  window.__myCaddieHook = true;
  const API = 'https://api.trackmangolf.com/graphql';
  let headers = null;

  const keep = (h) => {
    const out = {};
    const set = (k, v) => {
      const lk = String(k).toLowerCase();
      if (lk === 'authorization' || lk.startsWith('x-') || lk.startsWith('tm-') || lk.startsWith('apollographql-')) out[lk] = v;
    };
    if (!h) return out;
    if (h instanceof Headers) h.forEach((v, k) => set(k, v));
    else if (Array.isArray(h)) h.forEach(([k, v]) => set(k, v));
    else Object.entries(h).forEach(([k, v]) => set(k, v));
    return out;
  };
  const remember = (h) => {
    if (h && h.authorization) {
      headers = h;
      window.postMessage({ source: 'mycaddie-page', type: 'ready' }, location.origin);
    }
  };

  const origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input && input.url;
      if (url && url.startsWith(API)) {
        const h = Object.assign({}, input instanceof Request ? keep(input.headers) : {}, keep(init && init.headers));
        remember(h);
      }
    } catch (_) { /* never break the portal */ }
    return origFetch(input, init);
  };
  const origOpen = XMLHttpRequest.prototype.open;
  const origSet = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, url) { this.__mcUrl = url; this.__mcH = {}; return origOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try { if (this.__mcUrl && String(this.__mcUrl).startsWith(API)) { Object.assign(this.__mcH, keep({ [k]: v })); remember(this.__mcH); } } catch (_) {}
    return origSet.apply(this, arguments);
  };

  window.addEventListener('message', async (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.source !== 'mycaddie-bridge') return;
    if (d.type === 'status') {
      window.postMessage({ source: 'mycaddie-page', type: 'status', id: d.id, ready: !!headers }, location.origin);
      return;
    }
    if (d.type !== 'gql') return;
    // Only queries (reads) are ever sent; mutations are refused here as a second guard.
    if (/^\s*mutation\b/i.test(d.query || '')) {
      window.postMessage({ source: 'mycaddie-page', type: 'gql', id: d.id, error: 'mutations are not allowed' }, location.origin);
      return;
    }
    if (!headers) {
      window.postMessage({ source: 'mycaddie-page', type: 'gql', id: d.id, error: 'not_ready' }, location.origin);
      return;
    }
    try {
      const r = await origFetch(API, {
        method: 'POST', credentials: 'include',
        headers: Object.assign({ 'content-type': 'application/json', accept: 'application/json' }, headers),
        body: JSON.stringify({ query: d.query, variables: d.variables || {} }),
      });
      const body = await r.json();
      window.postMessage({ source: 'mycaddie-page', type: 'gql', id: d.id, status: r.status, body }, location.origin);
    } catch (e) {
      window.postMessage({ source: 'mycaddie-page', type: 'gql', id: d.id, error: String(e && e.message || e) }, location.origin);
    }
  });
})();
