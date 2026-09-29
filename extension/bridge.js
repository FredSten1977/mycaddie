// Relays read-only GraphQL requests between the extension and the page hook.
(() => {
  let seq = 0;
  const pending = new Map();
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.source !== 'mycaddie-page') return;
    if (d.type === 'ready') { chrome.runtime.sendMessage({ type: 'portal-ready' }).catch(() => {}); return; }
    const p = pending.get(d.id);
    if (p) { pending.delete(d.id); p(d); }
  });
  const ask = (msg, timeoutMs = 30000) => new Promise((resolve) => {
    const id = 'b' + (++seq);
    const t = setTimeout(() => { pending.delete(id); resolve({ error: 'timeout' }); }, timeoutMs);
    pending.set(id, (d) => { clearTimeout(t); resolve(d); });
    window.postMessage(Object.assign({ source: 'mycaddie-bridge', id }, msg), location.origin);
  });
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'mc-status') { ask({ type: 'status' }, 5000).then(sendResponse); return true; }
    if (msg && msg.type === 'mc-gql') { ask({ type: 'gql', query: msg.query, variables: msg.variables }).then(sendResponse); return true; }
    return false;
  });
})();
