// Live updates for every page. On a long-running server this is a Server-Sent Events stream.
// On Vercel the server answers /api/events with 204 (functions can't hold a stream open), so the page
// falls back to polling /api/state every few seconds.
//   live({ onState, onChat })  - onChat only for the admin simulator
function live({ onState, onChat, every = 3000 }) {
  const url = onChat ? "/api/events?chat=1" : "/api/events";
  let polling = false;
  const seenChat = new Set();

  const poll = async () => {
    if (polling) return;
    polling = true;
    for (;;) {
      try {
        const s = await fetch(onChat ? "/api/state?chat=1" : "/api/state").then((r) => r.json());
        if (onChat && s.chat) {
          for (const c of s.chat) if (!seenChat.has(c.id)) { seenChat.add(c.id); onChat(c); }
          delete s.chat;
        }
        onState(s);
      } catch {}
      await new Promise((r) => setTimeout(r, every));
    }
  };

  const es = new EventSource(url);
  es.addEventListener("state", (e) => onState(JSON.parse(e.data)));
  if (onChat) es.addEventListener("chat", (e) => { const c = JSON.parse(e.data); seenChat.add(c.id); onChat(c); });
  es.onerror = () => {
    // A 204 (or any hard failure) closes the stream for good: switch to polling. Brief drops reconnect on their own.
    if (es.readyState === EventSource.CLOSED) poll();
  };
}
