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
  if (low.price < track.now) return `${usd(track.now)} now → <b>${usd(low.price)}</b> on day ${low.day}, the lowest coming up`;
  const up = pts.find((p) => p.price > track.now);
  return up ? `<b>${usd(track.now)}</b> today is the lowest. It goes up to ${usd(up.price)} on day ${up.day}` : `${usd(track.now)}, no price changes coming up`;
}

function shieldHtml(p) {
  if (!p) return "";
  const label = { ADD: "🛡️ Protection: worth it", SKIP: "🛡️ Protection: skip it", OPTIONAL: "🛡️ Protection: optional" }[p.verdict];
  return `<div class="shield ${p.verdict}"><b>${label}.</b> ${esc(p.reason)}</div>`;
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
    <h3>${esc(item)}${changed ? ` <span class="arrow">→</span> <span class="to-inline">${esc(r.proposed.label)}</span>` : ""}</h3>
    <ul>${r.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
    ${r.witness ? `<blockquote class="witness"><div class="witness-label">Witness statement · ${esc(names[r.memberId])}'s current phone</div>“${esc(r.witness)}”</blockquote>` : ""}
    ${r.memberId && r.track ? sparkline(r.track, r.stamp === "WAIT" ? r.holdUntilDay : undefined) : ""}
    ${shieldHtml(r.protection)}
    <div class="money">${money}${r.savings > 0 ? `<b>you save ${usd(r.savings)}</b>` : ""}</div>
  </article>`;
}

function section(title, hint, rulings, names) {
  if (!rulings.length) return "";
  return `<h2 class="section-title">${title}<span>${hint}</span></h2><div class="rulings">${rulings.map((r) => rulingCard(r, names)).join("")}</div>`;
}

function render(s) {
  const names = Object.fromEntries(s.members.map((m) => [m.id, m.name]));
  $("caseno").textContent = `Case No. 26-${(s.household.split(" ")[1] ?? "FAM").slice(0, 3).toUpperCase()} · ${s.household}`;
  $("day").textContent = `Day ${s.day}`;
  $("textline").innerHTML = s.courtNumber ? `Text the court<b>${esc(s.courtNumber)}</b>` : "";
  const t = s.trial;

  if (!t) {
    seenStamps.clear(); shown.clear();
    const sticker = s.cart.reduce((sum, i) => sum + (i.price ?? 0), 0);
    $("subtitle").textContent = s.cart.length ? `${s.cart.length} item${s.cart.length > 1 ? "s" : ""} entered · awaiting trial` : "Awaiting arguments";
    $("totals").innerHTML = s.cart.length ? `<div class="total wide"><div class="label">Sticker total, as argued</div><div class="value" id="tSticker"></div></div>` : "";
    if (s.cart.length) countUp("tSticker", sticker);
    $("sections").innerHTML = s.cart.length
      ? `<h2 class="section-title">Entered into evidence<span>nobody checks out until the court rules</span></h2><div class="rulings">${s.cart.map((i) => `
          <article class="ruling pending"><span class="stamp PENDING">PENDING<small>awaiting trial</small></span>
            <div class="who-row"><span class="avatar">${initials(names[i.memberId])}</span><span class="who-name">${esc(names[i.memberId])}</span></div>
            <h3>${esc(i.label)}</h3>
            <div class="money">${usd(i.price)}${i.kind === "addon" ? "/yr" : ""}</div></article>`).join("")}</div>`
      : `<div class="empty"><div class="empty-gavel">⚖️</div>The docket is empty.<br>Text the court from your phone: paste a store link, send a photo, or ask <b>"court, what phone should I get?"</b></div>`;
    $("timelineWrap").innerHTML = "";
    $("ordered").hidden = true;
  } else {
    const buy = t.rulings.filter((r) => r.stamp === "KEEP" || r.stamp === "SWAP");
    const held = t.rulings.filter((r) => r.stamp === "WAIT");
    const cut = t.rulings.filter((r) => r.stamp === "CUT");
    $("subtitle").textContent = `Ruled on day ${t.day} · ${buy.length} to buy now · ${held.length} held · ${cut.length} struck`;
    $("totals").innerHTML = `
      <div class="total"><div class="label">Spend today</div><div class="value"><s>${usd(t.before)}</s><span id="tNow"></span></div>${t.budget !== undefined && t.budget !== null ? `<div class="budget-line ${t.overBudget ? "over" : ""}">💰 Budget ${usd(t.budget)} · ${t.overBudget ? `${usd(t.now - t.budget)} over` : `${usd(t.budget - t.now)} left`}</div>` : ""}</div>
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
          <div class="tick first" style="left:0%"><div class="dot" style="background:var(--keep)"></div><b>Today</b><br>${buy.map((r) => esc(names[r.memberId])).join(", ") || "nothing"}</div>
          ${held.map((h) => `<div class="tick" style="left:${x(h.holdUntilDay)}%"><div class="dot" style="background:var(--wait)"></div><b>Day ${h.holdUntilDay}</b><br>${esc(names[h.memberId])} · ${usd(h.heldCost)}</div>`).join("")}
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
