// Case-file rendering shared by /cart (what phones open) and the dashboard (/).
// Expects elements with ids: caseno, day, textline, subtitle, totals, exhibitsWrap, sections, timelineWrap, nestWrap, ordered, orderedDay.
const $ = (id) => document.getElementById(id);
const usd = (n) => "$" + Math.round(n).toLocaleString("en-US");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const seenStamps = new Map(); // itemId -> stamp: only animate a stamp when the ruling changes
const shown = new Map(); // total id -> last displayed value

function countUp(id, to) {
  const el = $(id); if (!el) return;
  const from = shown.get(id) ?? 0; shown.set(id, to);
  if (from === to) { el.textContent = usd(to); return; }
  const t0 = performance.now(), dur = 900;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = usd(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const initials = (name) => esc((name ?? "?").slice(0, 1));
// Plain words people understand at a glance.
const VERDICT = {
  KEEP: ["BUY", "go ahead"], SWAP: ["BUY", "better pick"], WAIT: ["WAIT", ""], CUT: ["SKIP", "cancel it"],
  STAY: ["STAY", "family plan"], LEAVE: ["GO SOLO", "own plan"], PENDING: ["PENDING", "awaiting trial"],
};
const stampHtml = (r) => {
  const fresh = seenStamps.get(r.itemId) !== r.stamp;
  seenStamps.set(r.itemId, r.stamp);
  const [word, hint] = VERDICT[r.stamp] ?? [r.stamp, ""];
  const small = r.stamp === "WAIT" ? `until day ${r.holdUntilDay}` : hint;
  return `<span class="stamp ${r.stamp} ${fresh ? "fresh" : ""}">${word}${small ? `<small>${small}</small>` : ""}</span>`;
};

// "Show the math": the engine's receipt for a ruling. Open receipts stay open across live re-renders.
const openMath = new Set();
document.addEventListener("toggle", (e) => {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || !d.classList.contains("math")) return;
  d.open ? openMath.add(d.dataset.item) : openMath.delete(d.dataset.item);
}, true);
const signed = (n) => (n < 0 ? `−${usd(-n)}` : usd(n));
function mathHtml(r) {
  if (!r.math?.length) return "";
  const total = r.math.reduce((s, l) => s + l.amount, 0);
  const yearly = r.math[0].label.includes("12 ×");
  const totalLabel = r.stamp === "WAIT" ? `On day ${r.holdUntilDay}` : yearly ? "Per year" : "Today";
  return `<details class="math" data-item="${esc(r.itemId)}" ${openMath.has(r.itemId) ? "open" : ""}>
    <summary>Show the math</summary>
    <table>
      ${r.math.map((l, i) => `<tr><td>${esc(l.label)}</td><td>${i === 0 ? usd(l.amount) : signed(l.amount)}</td></tr>`).join("")}
      <tr class="sum"><td>${totalLabel}</td><td>${usd(total)}</td></tr>
      ${r.stamp === "WAIT" && r.nowCost > 0 ? `<tr class="note"><td>Today: screen repair</td><td>${usd(r.nowCost)}</td></tr>` : ""}
    </table>
    <div class="by">Computed by engine.ts · not the AI</div>
  </details>`;
}

/** Tiny price chart for the price tracker: where the price is now and when it bottoms out. */
function sparkline(track, holdDay) {
  if (!track || track.points.length < 2) return "";
  const pts = track.points, w = 220, h = 44, pad = 4;
  const d0 = pts[0].day, d1 = pts[pts.length - 1].day;
  const lo = Math.min(...pts.map((p) => p.price)), hi = Math.max(...pts.map((p) => p.price));
  const x = (d) => pad + ((d - d0) / Math.max(1, d1 - d0)) * (w - pad * 2);
  const y = (v) => (hi === lo ? h / 2 : pad + ((hi - v) / (hi - lo)) * (h - pad * 2));
  let path = "";
  pts.forEach((p, i) => { path += i === 0 ? `M${x(p.day)},${y(p.price)}` : `H${x(p.day)}V${y(p.price)}`; });
  const low = track.lowest;
  const flat = hi === lo;
  return `<div class="tracker">
    <svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
      <path d="${path}" fill="none" stroke="currentColor" stroke-width="2"/>
      ${holdDay !== undefined ? `<line x1="${x(holdDay)}" x2="${x(holdDay)}" y1="0" y2="${h}" stroke="var(--wait)" stroke-dasharray="3 3"/>` : ""}
      <circle cx="${x(low.day)}" cy="${y(low.price)}" r="4" fill="var(--keep)"/>
    </svg>
    <div class="tracker-text">📈 Price tracker: ${trackerText(track)}</div>
  </div>`;
}

/** "$1,099 now → $787 on day 41 (lowest)" or "Lowest price is today: goes up to $899 on day 30". */
function trackerText(track) {
  const pts = track.points, low = track.lowest;
  // A BUY from an earlier day stays as ruled (engine.ts advanceTrial), so its prices are from that day.
  if (pts[0].day < today) return `priced on day ${pts[0].day} at <b>${usd(track.now)}</b>, when the court ruled`;
  if (low.price < track.now) return `${usd(track.now)} now → <b>${usd(low.price)}</b> on day ${low.day}, the lowest coming up`;
  const up = pts.find((p) => p.price > track.now);
  return up ? `<b>${usd(track.now)}</b> today is the lowest. It goes up to ${usd(up.price)} on day ${up.day}` : `${usd(track.now)}, no price changes coming up`;
}

function shieldHtml(p) {
  if (!p) return "";
  const label = { ADD: "🛡️ Protection: worth it", SKIP: "🛡️ Protection: skip it", OPTIONAL: "🛡️ Protection: optional" }[p.verdict];
  return `<div class="shield ${p.verdict}"><b>${label}.</b> ${esc(p.reason)}</div>`;
}

// itemId -> where to buy it yourself (maker first, then T-Mobile, Best Buy, Amazon) and when prices were checked
let shopLinks = {};
let checked = {};
let today = 0;
// itemId -> the latest appeal / overrule on it
let appeals = {};
const APPEAL_TEXT = { GRANTED: "⚖️ Appeal granted", "PARTLY GRANTED": "⚖️ Appeal partly granted", DENIED: "⚖️ Appeal denied", OVERRULED: "🔨 Overruled", REINSTATED: "⚖️ Ruling reinstated" };
function appealHtml(r, names) {
  const a = appeals[r.itemId];
  if (!a) return "";
  const by = a.by && names[a.by] ? ` by ${esc(names[a.by].split(/\s+/)[0])}` : "";
  return `<div class="appeal-note ${a.outcome.split(" ")[0]}">${APPEAL_TEXT[a.outcome] ?? a.outcome}${a.outcome === "OVERRULED" || a.outcome === "REINSTATED" ? by : ""} · day ${a.day}</div>`;
}
const checkedText = (d) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const shopHtml = (id) => {
  const links = shopLinks[id] ?? [];
  if (!links.length) return "";
  const a = links.map((l) => `<a class="shop-link" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.store)}${l.price ? ` ${usd(l.price)}` : ""} ↗</a>`).join(" ");
  return `<div class="shop">${a}${checked[id] ? `<span class="checked">Prices checked ${checkedText(checked[id])}</span>` : ""}</div>`;
};

// The same price spread over 24 monthly payments, the way most families actually pay for a phone.
function monthly(r) {
  const n = r.stamp === "WAIT" ? r.heldCost : r.nowCost;
  return r.memberId && r.proposed && n > 0 && r.stamp !== "CUT" ? `<em>or ≈${usd(Math.ceil(n / 24))}/mo × 24</em>` : "";
}

// "Can't she just take Dad's phone?": priced against trading that phone in (engine: priceHandMeDowns).
function handMeDownHtml(r, names) {
  const h = r.handMeDown;
  if (!h) return "";
  const giver = names[h.from], kid = names[r.memberId];
  return h.saves > 0
    ? `<div class="tradein">🎁 Hand-me-down option: ${esc(kid)} takes ${esc(giver)}'s ${esc(h.device)} (${h.batteryHealth}% battery) on day ${h.onDay}. Gives up ${usd(h.forgone)} in trade-in, skips a ${usd(h.instead)} phone: <b>${usd(h.saves)} less</b></div>`
    : `<div class="tradein muted">🎁 Checked a hand-me-down from ${esc(giver)}: trading the ${esc(h.device)} in is worth ${usd(-h.saves)} more.</div>`;
}

function rulingCard(r, names) {
  const who = r.memberId ? names[r.memberId] : "Account";
  const item = r.label.includes(" · ") ? r.label.split(" · ").slice(1).join(" · ") : r.label;
  const changed = r.proposed && !r.label.endsWith(r.proposed.label);
  const money = r.stamp === "WAIT"
    ? `<span class="strike">${usd(r.originalCost)}</span> ${usd(r.heldCost)} <em>on day ${r.holdUntilDay}</em>`
    : r.stamp === "CUT" ? `<span class="strike">${usd(r.originalCost)}/yr</span> $0`
    : `<span class="strike">${usd(r.originalCost)}</span> ${usd(r.nowCost)}`;
  return `<article class="ruling">
    ${stampHtml(r)}
    <div class="who-row"><span class="avatar">${initials(who)}</span><span class="who-name">${esc(who)}</span></div>
    ${appealHtml(r, names)}
    <h3>${esc(item)}${changed ? ` <span class="arrow">→</span> <span class="to-inline">${esc(r.proposed.label)}</span>` : ""}</h3>
    <ul>${r.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
    ${r.memberId && r.track ? sparkline(r.track, r.stamp === "WAIT" ? r.holdUntilDay : undefined) : ""}
    ${shieldHtml(r.protection)}
    ${handMeDownHtml(r, names)}
    ${r.tradeIn && r.stamp !== "CUT" ? `<div class="tradein">♻️ With trade-in of the ${esc(r.tradeIn.device)} (−${usd(r.tradeIn.value)}): <b>${usd(r.tradeIn.withTradeIn)}</b> · without: ${usd(r.tradeIn.withoutTradeIn)}</div>` : ""}
    ${r.stamp !== "CUT" && r.stamp !== "WAIT" ? shopHtml(r.itemId) : ""}
    <div class="money">${money}${monthly(r)}${r.savings > 0 ? `<b>you save ${usd(r.savings)}</b>` : ""}</div>
    ${mathHtml(r)}
  </article>`;
}

function section(title, hint, rulings, names) {
  if (!rulings.length) return "";
  return `<h2 class="section-title">${title}<span>${hint}</span></h2><div class="rulings">${rulings.map((r) => rulingCard(r, names)).join("")}</div>`;
}

let lastRendered;
/** Animate the verdict again (stamps + totals) without re-running the trial or texting anyone. */
function replayStamps() {
  if (!lastRendered) return;
  seenStamps.clear(); shown.clear();
  render(lastRendered);
}

function render(s) {
  lastRendered = s;
  const names = Object.fromEntries(s.members.map((m) => [m.id, m.name]));
  today = s.day;
  appeals = Object.fromEntries((s.appeals ?? []).map((a) => [a.itemId, a]));
  shopLinks = Object.fromEntries(s.cart.filter((i) => i.shopUrl).map((i) => [i.id, i.shopLinks ?? [{ store: "Shop", url: i.shopUrl }]]));
  checked = Object.fromEntries(s.cart.filter((i) => i.checked).map((i) => [i.id, i.checked]));
  $("caseno").textContent = `Case No. 26-${(s.household.split(" ")[1] ?? "FAM").slice(0, 3).toUpperCase()} · ${s.household}`;
  $("day").textContent = `Day ${s.day}`;
  $("textline").innerHTML = s.courtNumber ? `Text the court<b>${esc(s.courtNumber)}</b>` : "";
  const t = s.trial;

  if (!t) {
    // Keep the sticker's last value: every poll re-renders, and starting from $0 made it count up again each time.
    seenStamps.clear(); for (const k of ["tNow", "tHeld", "tSaved"]) shown.delete(k);
    const sticker = s.cart.reduce((sum, i) => sum + (i.price ?? 0), 0);
    $("subtitle").textContent = s.cart.length ? `${s.cart.length} item${s.cart.length > 1 ? "s" : ""} entered · awaiting trial` : "Awaiting arguments";
    $("totals").innerHTML = s.cart.length ? `<div class="total wide"><div class="label">Sticker total, as argued</div><div class="value" id="tSticker"></div></div>` : "";
    if (s.cart.length) countUp("tSticker", sticker);
    $("sections").innerHTML = s.cart.length
      ? `<h2 class="section-title">Entered into evidence<span>nobody checks out until the court rules</span></h2><div class="rulings">${s.cart.map((i) => `
          <article class="ruling pending"><span class="stamp PENDING">PENDING<small>awaiting trial</small></span>
            <div class="who-row"><span class="avatar">${initials(names[i.memberId])}</span><span class="who-name">${esc(names[i.memberId])}</span></div>
            <h3>${esc(i.label)}</h3>
            ${shopHtml(i.id)}
            <div class="money">${usd(i.price)}${i.kind === "addon" ? "/yr" : ""}</div></article>`).join("")}</div>`
      : `<div class="empty"><div class="empty-gavel">⚖️</div>The docket is empty.<br>Text the court from your phone: paste a store link for anything, send a photo, or ask <b>"court, what laptop should I get?"</b></div>`;
    $("timelineWrap").innerHTML = "";
    $("ordered").hidden = true;
  } else {
    const buy = t.rulings.filter((r) => r.stamp === "KEEP" || r.stamp === "SWAP");
    const held = t.rulings.filter((r) => r.stamp === "WAIT");
    const cut = t.rulings.filter((r) => r.stamp === "CUT");
    $("subtitle").textContent = `Ruled on day ${t.day} · ${buy.length} to buy now · ${held.length} held · ${cut.length} struck`;
    $("totals").innerHTML = `
      <div class="total"><div class="label">Spend today</div><div class="value"><s>${usd(t.before)}</s><span id="tNow"></span></div>${t.budget !== undefined && t.budget !== null ? `<div class="budget-line ${t.overBudget ? "over" : ""}">💰 Phone budget · plan ${usd(t.planned ?? t.now)} (now + later) · ${t.overBudget ? `${usd((t.planned ?? t.now) - t.budget)} over` : `${usd(t.budget - (t.planned ?? t.now))} left`}</div>` : ""}</div>
      <div class="total"><div class="label">Held for the right moment</div><div class="value" id="tHeld"></div></div>
      <div class="total savings"><div class="label">You save</div><div class="value" id="tSaved"></div></div>`;
    countUp("tNow", t.now); countUp("tHeld", t.held); countUp("tSaved", t.savings);
    $("sections").innerHTML =
      section("✅ Buy", "worth buying today", buy, names) +
      section("⏳ Wait", "cheaper later; we'll text everyone when it's time", held, names) +
      section("✂️ Skip", "paying for things nobody uses", cut, names);

    if (held.length) {
      const end = Math.max(...held.map((h) => h.holdUntilDay)) * 1.08;
      const x = (d) => Math.min(100, ((d - t.day) / (end - t.day)) * 100);
      $("timelineWrap").innerHTML = `<h2 class="section-title">When to buy<span>the court's calendar</span></h2>
        <div class="timeline"><div class="line"></div>
          <div class="tick first" style="left:0%"><div class="dot" style="background:var(--keep)"></div><b>Today</b><br>${[...new Set(buy.map((r) => esc(names[r.memberId])))].join(", ") || "nothing"}</div>
          ${[...new Set(held.map((h) => h.holdUntilDay))].map((d) => `<div class="tick" style="left:${x(d)}%"><div class="dot" style="background:var(--wait)"></div><b>Day ${d}</b>${held.filter((h) => h.holdUntilDay === d).map((h) => `<br>${esc(names[h.memberId])} · ${usd(h.heldCost)}`).join("")}</div>`).join("")}
        </div>`;
    } else $("timelineWrap").innerHTML = "";
    $("ordered").hidden = false;
    $("orderedDay").textContent = `day ${t.day}`;
  }

  const ex = s.exhibits ?? [];
  $("exhibitsWrap").innerHTML = ex.length ? `<h2 class="section-title">Evidence<span>photos the family sent the court</span></h2><div class="exhibits">${ex.map((e, i) => `
    <figure class="exhibit">${e.image ? `<img src="${e.image}" alt="">` : `<div class="noimg">🗂️</div>`}
      <figcaption><b>Exhibit ${String.fromCharCode(65 + i)}</b> · ${esc(names[e.memberId])}<br>${esc(e.finding)}</figcaption></figure>`).join("")}</div>` : "";

  // What the family actually bought, and what it saved.
  const bought = s.purchases ?? [];
  if ($("boughtWrap")) $("boughtWrap").innerHTML = bought.length ? `<h2 class="section-title">🧾 Bought<span>${usd(s.spent)} spent so far</span></h2><div class="rulings">${[...bought].reverse().map((p) => `
    <article class="ruling"><span class="stamp KEEP">PAID<small>day ${p.day}</small></span>
      <div class="who-row"><span class="avatar">${initials(names[p.memberId])}</span><span class="who-name">${esc(names[p.memberId])}</span></div>
      <h3>${esc(p.label)}</h3>
      <div class="money">${p.sticker ? `<span class="strike">${usd(p.sticker)}</span>` : ""} ${usd(p.paid)}${p.sticker && p.sticker > p.paid ? `<b>you save ${usd(p.sticker - p.paid)}</b>` : ""}${p.source === "receipt" ? " <em>from receipt</em>" : ""}</div>
    </article>`).join("")}</div>` : "";

  $("nestWrap").innerHTML = s.nest ? `<h2 class="section-title">Leaving the nest<span>stay on the family plan, or go solo?</span></h2><div class="rulings">
    <article class="ruling">${stampHtml({ itemId: "nest", stamp: s.nest.stamp })}
      <div class="who-row"><span class="avatar">${initials(names[s.nest.memberId])}</span><span class="who-name">${esc(names[s.nest.memberId])}</span></div>
      <h3>Family line ${usd(s.nest.familyLineMonthly)}/mo vs ${esc(s.nest.soloPlan.name)} ${usd(s.nest.soloPlan.monthly)}/mo</h3>
      <ul>${s.nest.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      <div class="money"><b>saves ${usd(s.nest.monthlySavings * 12)}/yr</b></div></article></div>` : "";
}
