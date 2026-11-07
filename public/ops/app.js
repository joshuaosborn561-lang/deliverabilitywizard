const state = {
  csrf: "",
  user: null,
  today: null,
  watchdog: null,
  fix: null,
  fixFilter: "all",
  openClient: "",
  openColumn: "",
  placementRows: [],
  placementSort: { key: "createdAt", direction: "desc" },
  placementLoading: null,
  placementPollSince: 0,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.csrf && (options.method || "GET") !== "GET") {
    headers["X-CSRF-Token"] = state.csrf;
  }
  const response = await fetch(`/ops/api${path}`, {
    credentials: "same-origin",
    ...options,
    headers,
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== "/login") showLogin();
  if (!response.ok) throw new Error(body.error || body.message || `HTTP ${response.status}`);
  return body;
}

function showLogin(message = "") {
  $("#app-view").classList.add("hidden");
  $("#login-view").classList.remove("hidden");
  $("#login-error").textContent = message;
}

function showApp() {
  $("#login-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add("hidden"), 3500);
}

function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function daysUntilLabel(days) {
  if (days === 0) return "today";
  if (days === 1) return "1 day";
  return `${days} days`;
}

function formatCt(value) {
  if (!value) return "Not yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not yet";
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return `${time} CT`;
}

function comma(value) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return Number(value).toLocaleString("en-US");
}

function setBadge(id, count) {
  const badge = $(id);
  badge.textContent = String(count);
  badge.classList.toggle("zero", !count);
}

function renderRollover(rollover) {
  const el = $("#ab-rollover");
  if (!rollover || !Number.isFinite(rollover.daysUntil)) {
    el.textContent = "";
    return;
  }
  el.textContent = `A/B rollover · Pod ${rollover.onWeekCohort} sending · ${daysUntilLabel(rollover.daysUntil)}`;
}

function summaryCard(label, value, note, tone) {
  const card = make("article", `summary-card${tone ? ` ${tone}` : ""}`);
  card.append(make("span", "", label), make("strong", "", String(value)));
  if (note) card.append(make("small", "", note));
  return card;
}

async function loadToday() {
  const data = await api("/today");
  state.today = data;
  $("#sweep-state").textContent = data.hourlySweep || "on";
  $("#canon-check").textContent = data.canonCheck || "every 15 min";
  $("#alerts-label").textContent = data.alertsLabel || "Slack";
  renderRollover(data.restRollover);
  setBadge("#today-badge", data.checksFailing || 0);
  const green = `${data.clientsAllGreen} / ${data.clientsTotal}`;
  $("#today-cards").replaceChildren(
    summaryCard("LAST SWEEP", formatCt(data.lastSweepAt), `next ${formatCt(data.nextSweepAt)} · hourly`),
    summaryCard("CHECKS PASSING", comma(data.checksPassing), "", "good"),
    summaryCard("CHECKS FAILING", comma(data.checksFailing), "", data.checksFailing ? "bad" : ""),
    summaryCard("CLIENTS ALL-GREEN", green, ""),
  );
  const head = $("#today-head");
  head.replaceChildren(
    make("th", "", "Client"),
    ...data.columns.map((column) => {
      const th = make("th");
      th.append(make("span", "", column.label), make("small", "", column.hint));
      return th;
    }),
  );
  const body = $("#today-body");
  const rows = [];
  for (const client of data.rows || []) {
    const tr = document.createElement("tr");
    tr.append(make("td", "client-name", client.clientName));
    for (const column of data.columns) {
      const cell = client.cells[column.id];
      const td = document.createElement("td");
      if (cell.idle) {
        td.append(make("span", "mark idle", "—"));
      } else if (cell.ok && cell.pending) {
        const mark = make("span", "mark idle", "…");
        mark.title = `${cell.pending} placement test(s) still running`;
        td.append(mark);
      } else if (cell.ok && cell.info) {
        const mark = make("span", "mark ok", "✓ i");
        mark.title = `${cell.info} informational note(s), e.g. idle generics`;
        td.append(mark);
      } else if (cell.ok) {
        td.append(make("span", "mark ok", "✓"));
      } else {
        const button = make("button", "mark bad", "✕");
        button.type = "button";
        button.addEventListener("click", () => {
          const same = state.openClient === client.clientId && state.openColumn === column.id;
          state.openClient = same ? "" : client.clientId;
          state.openColumn = same ? "" : column.id;
          renderTodayBody();
        });
        td.append(button);
      }
      tr.append(td);
    }
    rows.push(tr);
    if (state.openClient === client.clientId) {
      const column = data.columns.find((item) => item.id === state.openColumn);
      const cell = column ? client.cells[column.id] : null;
      if (column && cell && !cell.ok) {
        const extra = document.createElement("tr");
        extra.className = "fail-row";
        const td = document.createElement("td");
        td.colSpan = data.columns.length + 1;
        const box = make("div", "fail-box");
        box.append(make("h3", "", `${client.clientName} · ${column.label} — ${cell.failures.length} failing`));
        for (const failure of cell.failures) {
          const line = make("div", "fail-line");
          line.append(make("span", "", failure.text));
          const button = make("button", "", failure.actionLabel);
          button.type = "button";
          button.addEventListener("click", () => runFailureAction(failure, client.clientName));
          line.append(button);
          box.append(line);
        }
        td.append(box);
        extra.append(td);
        rows.push(extra);
      }
    }
  }
  body.replaceChildren(...rows);
  $("#today-empty").classList.toggle("hidden", (data.rows || []).length > 0);
}

function renderTodayBody() {
  if (state.today) {
    const saved = state.today;
    state.today = saved;
    loadTodayFromCache();
  }
}

function loadTodayFromCache() {
  const data = state.today;
  if (!data) return;
  const body = $("#today-body");
  const rows = [];
  for (const client of data.rows || []) {
    const tr = document.createElement("tr");
    tr.append(make("td", "client-name", client.clientName));
    for (const column of data.columns) {
      const cell = client.cells[column.id];
      const td = document.createElement("td");
      if (cell.idle) td.append(make("span", "mark idle", "—"));
      else if (cell.ok && cell.pending) {
        const mark = make("span", "mark idle", "…");
        mark.title = `${cell.pending} placement test(s) still running`;
        td.append(mark);
      } else if (cell.ok && cell.info) {
        const mark = make("span", "mark ok", "✓ i");
        mark.title = `${cell.info} informational note(s), e.g. idle generics`;
        td.append(mark);
      } else if (cell.ok) td.append(make("span", "mark ok", "✓"));
      else {
        const button = make("button", "mark bad", "✕");
        button.type = "button";
        button.addEventListener("click", () => {
          const same = state.openClient === client.clientId && state.openColumn === column.id;
          state.openClient = same ? "" : client.clientId;
          state.openColumn = same ? "" : column.id;
          loadTodayFromCache();
        });
        td.append(button);
      }
      tr.append(td);
    }
    rows.push(tr);
    if (state.openClient === client.clientId) {
      const column = data.columns.find((item) => item.id === state.openColumn);
      const cell = column ? client.cells[column.id] : null;
      if (column && cell && !cell.ok) {
        const extra = document.createElement("tr");
        extra.className = "fail-row";
        const td = document.createElement("td");
        td.colSpan = data.columns.length + 1;
        const box = make("div", "fail-box");
        box.append(make("h3", "", `${client.clientName} · ${column.label} — ${cell.failures.length} failing`));
        for (const failure of cell.failures) {
          const line = make("div", "fail-line");
          line.append(make("span", "", failure.text));
          const button = make("button", "", failure.actionLabel);
          button.type = "button";
          button.addEventListener("click", () => runFailureAction(failure, client.clientName));
          line.append(button);
          box.append(line);
        }
        td.append(box);
        extra.append(td);
        rows.push(extra);
      }
    }
  }
  body.replaceChildren(...rows);
}

function runFailureAction(failure, clientName) {
  if (failure.actionId === "refresh-placement") {
    loadPlacement(true)
      .then(() => loadToday())
      .catch((error) => toast(error.message));
    return;
  }
  state.fixFilter = "all";
  switchPanel("fix");
  toast(`Fix queue · ${clientName}`);
}

const WATCH_LABEL = {
  healthy: "Healthy",
  behind: "Behind pace",
  topup: "Top up",
  josh: "Bring to Josh",
  unread: "No reading",
};

async function loadWatchdog() {
  const data = await api("/watchdog");
  state.watchdog = data;
  setBadge("#watchdog-badge", (data.needTopUp || 0) + (data.bringToJosh || 0));
  $("#watchdog-cards").replaceChildren(
    summaryCard("SENDS TODAY (ALL)", comma(data.sendsToday), ""),
    summaryCard("ON PACE", `${data.onPace} / ${data.tracked}`, data.paceLabel, "good"),
    summaryCard("NEED TOP-UP", comma(data.needTopUp), `under ${comma(data.topUpBelow)} leads`, data.needTopUp ? "warn" : ""),
    summaryCard("BRING TO JOSH", comma(data.bringToJosh), `under ${comma(data.joshBelow)} leads`, data.bringToJosh ? "bad" : ""),
  );
  const grid = $("#watchdog-grid");
  grid.replaceChildren(
    ...(data.clients || []).map((client) => {
      const card = make("article", `watch-card ${client.status}`);
      const header = document.createElement("header");
      header.append(make("h3", "", client.clientName), make("span", `pill ${client.status}`, WATCH_LABEL[client.status] || client.status));
      const ratio = client.target > 0 && client.sendsToday != null
        ? Math.max(0, Math.min(100, (client.sendsToday / client.target) * 100))
        : 0;
      const barTone = client.sendsToday != null && client.target > 0 && client.sendsToday < client.target
        ? "behind"
        : client.status;
      card.append(header);
      card.append(make("p", "muted", "Sends today"));
      const meter = make("div", `meter ${barTone}`);
      const fill = document.createElement("span");
      fill.style.width = `${ratio}%`;
      meter.append(fill);
      card.append(meter);
      card.append(make("strong", "", `${comma(client.sendsToday)} / ${comma(client.target)}`));
      card.append(make("p", "muted", "Leads left"));
      const leads = make("p", "leads", comma(client.leadsLeft));
      if (client.status === "josh") leads.style.color = "var(--red)";
      if (client.status === "topup") leads.style.color = "var(--amber)";
      card.append(leads);
      if (client.status === "topup") {
        card.append(make("div", "note", `Under ${comma(data.topUpBelow)} — needs top-up`));
      }
      if (client.status === "josh") {
        card.append(make("div", "note josh", "Market used up — bring to Josh"));
      }
      return card;
    }),
  );
  $("#watchdog-stamp").textContent = stampText(data.updatedAt, data.source);
  $("#watchdog-empty").classList.toggle("hidden", (data.clients || []).length > 0);
}

function stampText(updatedAt, extra) {
  if (!updatedAt) return "No hourly reading yet";
  return `Updated ${formatCt(updatedAt)}${extra ? ` · ${extra}` : ""}`;
}

async function loadCalling() {
  const data = await api("/calling");
  state.calling = data;
  const failing = (data.clients || []).filter((client) => !client.ok).length;
  setBadge("#calling-badge", failing);
  const gabe = data.gabeDialsTarget
    ? `${comma(data.gabeDialsYesterday)} / ${comma(data.gabeDialsTarget)}`
    : comma(data.gabeDialsYesterday);
  $("#calling-cards").replaceChildren(
    summaryCard("QUEUES FULL", `${data.queuesFull} / ${data.queuesTracked}`, `target ${data.queueTarget}`, data.queuesFull ? "bad" : ""),
    summaryCard("VOICEMAILS YDAY", comma(data.voicemailsYesterday), `${comma(data.emailsYesterday)} emails`, ""),
    summaryCard("ROUTER / DNC", comma(data.routerOrDncErrors), data.edgeLogs === "unchecked" ? "edge logs unchecked" : "", data.routerOrDncErrors || data.edgeLogs === "unchecked" ? "warn" : ""),
    summaryCard("GABE DIALS", gabe, data.gabeDialsTarget ? "yesterday" : "target unset", ""),
  );
  $("#calling-stamp").textContent = stampText(data.updatedAt, "hourly");
  $("#calling-grid").replaceChildren(...(data.clients || []).map(callingCard));
  renderChecklist(data.checklist || {}, data.actionsEnabled === true);
  $("#calling-empty").classList.toggle("hidden", (data.clients || []).length > 0);
}

function callingCard(client) {
  const card = make("article", `watch-card ${client.ok ? "healthy" : client.bringToJosh ? "josh" : "amber"}`);
  const header = document.createElement("header");
  header.append(make("h3", "", client.clientName), make("span", `pill ${client.ok ? "healthy" : "josh"}`, client.ok ? "Clear" : "Needs work"));
  card.append(header);
  card.append(make("p", "muted", `Queue ${comma(client.queueContacts)} / ${comma(client.queueTarget)} · ${client.queues} queue${client.queues === 1 ? "" : "s"}`));
  card.append(make("p", "", `Missing email: ${comma(client.missingEmail)}`));
  card.append(make("p", "", client.buildNextList ? "Build next list" : "No queue at 3×"));
  card.append(make("p", "", `Yesterday ${comma(client.voicemailsYesterday)} voicemails · ${comma(client.emailsYesterday)} emails`));
  if (client.mismatchReason) card.append(make("div", "note", client.mismatchReason));
  if (client.bringToJosh) card.append(make("div", "note josh", "Bring to Josh"));
  const actions = make("div", "fix-actions");
  actions.append(actionButton("Remove", "remove", client.clientName));
  actions.append(actionButton("Send now", "send-now", client.clientName));
  card.append(actions);
  return card;
}

function actionButton(label, action, clientName) {
  const button = make("button", "", label);
  button.type = "button";
  button.addEventListener("click", async () => {
    try {
      await api("/calling/action", {
        method: "POST",
        body: JSON.stringify({ action, clientName, confirm: true }),
      });
      toast(`${label} stayed off`);
    } catch (error) {
      toast(error.message);
    }
  });
  return button;
}

function renderChecklist(checklist, actionsEnabled) {
  const box = $("#calling-checklist");
  box.replaceChildren(make("h3", "", "Manual checklist"));
  const rows = [
    ["onScript", "Caller is on script"],
    ["opener", "Caller used the opener"],
    ["caydenFriday", "Cayden's Friday calls"],
  ];
  for (const [key, label] of rows) {
    const line = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(checklist[key]);
    input.addEventListener("change", async () => {
      try {
        const saved = await api("/calling/checklist", {
          method: "POST",
          body: JSON.stringify({ [key]: input.checked }),
        });
        if (state.calling) state.calling.checklist = saved.checklist;
      } catch (error) {
        input.checked = !input.checked;
        toast(error.message);
      }
    });
    line.append(input, document.createTextNode(label));
    box.append(line);
  }
  const numbers = (state.calling?.numbers || []).map((row) =>
    `${row.label} ····${row.last4} · ${row.daysSinceRotation == null ? "rotation unknown" : `${row.daysSinceRotation}d since rotation`}${row.spamLikely ? " · spam-likely" : row.spamLikely === false ? "" : " · spam-likely unchecked"}`,
  );
  if (numbers.length) {
    const list = make("ul", "lane-list");
    for (const line of numbers) list.append(make("li", "", line));
    box.append(make("p", "muted", "Allo numbers"), list);
    box.append(actionButton("Rotate", "rotate", ""));
  }
  const suppression = state.calling?.suppression;
  if (suppression) {
    box.append(make("p", "", `DNC removed from calls: ${comma(suppression.dnc)} · still queued ${comma(suppression.dncStillQueued)}`));
    box.append(make("p", "", `Unsubscribes removed from both: ${comma(suppression.unsub)} · still queued ${comma(suppression.unsubStillQueued)} · still emailed ${comma(suppression.unsubStillEmailed)}`));
  }
  const tagging = state.calling?.tagging;
  if (tagging) {
    box.append(make("p", "", `Voicemail left tagged ${comma(tagging.voicemailTagged)} of ${comma(tagging.voicemailCalls)}`));
  }
  if (!actionsEnabled) box.append(make("p", "muted", "Remove, Send now, and Rotate stay off."));
}

async function loadLinkedin() {
  const data = await api("/linkedin");
  state.linkedin = data;
  setBadge("#linkedin-badge", (data.broken || 0) + (data.unchecked || 0));
  $("#linkedin-cards").replaceChildren(
    summaryCard("ON TARGET", comma(data.onTarget), data.targetLabel || "30–35", "good"),
    summaryCard("LOW", comma(data.low), "amber", data.low ? "warn" : ""),
    summaryCard("BROKEN", comma(data.broken), "tag Josh", data.broken ? "bad" : ""),
    summaryCard("REPLIES TODAY", data.repliesToday == null ? "—" : comma(data.repliesToday), "count only", ""),
  );
  $("#linkedin-stamp").textContent = stampText(data.updatedAt, "hourly");
  $("#linkedin-grid").replaceChildren(...(data.clients || []).map(linkedinCard));
  $("#linkedin-empty").classList.toggle("hidden", (data.clients || []).length > 0);
}

function linkedinCard(client) {
  const card = make("article", `watch-card ${client.tone || "unchecked"}`);
  const header = document.createElement("header");
  const label = client.tone === "green" ? "On target" : client.tone === "red" ? "Broken, tag Josh" : client.tone === "amber" ? "Low" : "Can't check";
  header.append(make("h3", "", client.clientName), make("span", `pill ${client.tone === "red" ? "josh" : client.tone === "amber" ? "topup" : ""}`, label));
  card.append(header);
  card.append(make("strong", "", client.sentToday == null ? "—" : `${comma(client.sentToday)} today`));
  if (client.reason) card.append(make("div", client.tone === "red" ? "note josh" : "note", client.reason));
  const trend = (client.trend || []).map((value) => comma(value)).join(" · ");
  if (trend) card.append(make("p", "muted", `3-day ${trend}`));
  if ((client.lanes || []).length) {
    const list = make("ul", "lane-list");
    for (const lane of client.lanes) {
      list.append(make("li", "", `${lane.label} · ${lane.sentToday == null ? "—" : comma(lane.sentToday)}${lane.reason ? ` · ${lane.reason}` : ""}`));
    }
    card.append(list);
  }
  return card;
}

function renderFix() {
  const data = state.fix;
  if (!data) return;
  const filters = [
    ["all", "All"],
    ["approval", "Approvals"],
    ["copy", "Copy"],
    ["isolation", "Isolation"],
    ["audit", "Audit"],
  ];
  $("#fix-filters").replaceChildren(
    ...filters.map(([id, label]) => {
      const button = make("button", state.fixFilter === id ? "active" : "", `${label} ${data.counts[id] ?? 0}`);
      button.type = "button";
      button.addEventListener("click", () => {
        state.fixFilter = id;
        renderFix();
      });
      return button;
    }),
  );
  const items = (data.items || []).filter((item) => state.fixFilter === "all" || item.filter === state.fixFilter);
  $("#fix-list").replaceChildren(
    ...items.map((item) => {
      const card = make("article", "fix-card");
      const copy = make("div");
      copy.append(make("div", "fix-kind", item.filter.toUpperCase()));
      copy.append(make("h3", "", item.title));
      copy.append(make("p", "", item.subtitle || item.clientName || ""));
      const actions = make("div", "fix-actions");
      if (item.spamAssassin) {
        const bad = item.spamAssassin.score !== 0;
        const score = make(
          "span",
          `sa${bad ? " bad" : ""}`,
          bad
            ? `SpamAssassin ${item.spamAssassin.score} must be 0`
            : `SpamAssassin ${item.spamAssassin.score.toFixed(1)}`,
        );
        actions.append(score);
      }
      const approve = make("button", "approve", item.approveLabel);
      approve.type = "button";
      approve.disabled = Boolean(item.approveDisabled);
      approve.addEventListener("click", () => decideFix(item, "approve"));
      const reject = make("button", "reject", item.rejectLabel || "Reject");
      reject.type = "button";
      reject.addEventListener("click", () => decideFix(item, "reject"));
      actions.append(approve, reject);
      card.append(make("div", "fix-mark", item.filter === "isolation" ? "↻" : "✎"), copy, actions);
      return card;
    }),
  );
  $("#fix-empty").classList.toggle("hidden", items.length > 0);
}

async function loadFix() {
  state.fix = await api("/fix-queue");
  setBadge("#fix-badge", state.fix.counts?.all || 0);
  renderFix();
}

async function decideFix(item, decision) {
  try {
    if (item.filter === "audit" && decision === "approve") {
      switchPanel("today");
      toast(item.subtitle || item.title);
      return;
    }
    if (item.filter === "audit" && decision === "reject") {
      await api(`/fix-queue/${encodeURIComponent(item.id)}/reject`, {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
      });
      toast("Noted. The sweep finding stays until it clears.");
      await loadFix();
      return;
    }
    if (item.filter === "approval") {
      const id = item.id.replace(/^approval:/, "");
      await api(`/approvals/${encodeURIComponent(id)}/${decision === "approve" ? "approve" : "deny"}`, {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
      });
    } else {
      const id = item.id.replace(/^(copy|isolation):/, "");
      await api(`/isolation/actions/${encodeURIComponent(id)}/${decision === "approve" ? "approve" : "deny"}`, {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
      });
    }
    toast(decision === "approve" ? "Approved" : "Rejected");
    await loadFix();
    await loadToday();
  } catch (error) {
    toast(error.message);
  }
}

function switchPanel(name) {
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.panel === name));
  $$(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === `${name}-panel`));
  const title = { today: "Today", watchdog: "Watchdog", fix: "Fix queue", calling: "Calling", linkedin: "LinkedIn" };
  $("#panel-title").textContent = title[name] || name;
  if (name === "watchdog" && !state.watchdog) loadWatchdog().catch((error) => toast(error.message));
  if (name === "calling" && !state.calling) loadCalling().catch((error) => toast(error.message));
  if (name === "linkedin" && !state.linkedin) loadLinkedin().catch((error) => toast(error.message));
  if (name === "fix") loadFix().catch((error) => toast(error.message));
}

function openChat() {
  $("#chat-drawer").classList.add("open");
  $("#chat-drawer").setAttribute("aria-hidden", "false");
  $("#chat-input").focus();
}

function closeChat() {
  $("#chat-drawer").classList.remove("open");
  $("#chat-drawer").setAttribute("aria-hidden", "true");
}

async function loadPlacement(force = false, pass = 0) {
  if (pass === 0) {
    if (state.placementLoading) return state.placementLoading;
    state.placementPollSince = Date.now();
    const run = loadPlacementPass(force, 0).finally(() => {
      state.placementLoading = null;
    });
    state.placementLoading = run;
    return run;
  }
  return loadPlacementPass(force, pass);
}

async function loadPlacementPass(force = false, pass = 0) {
  const banner = $("#placement-errors");
  banner.textContent = "";
  banner.className = "error";
  const data = await api(`/placements${force ? "?force=1" : ""}`);
  state.placementRows = data.rows || [];
  const stamp = formatCt(data.generatedAt);
  $("#placement-updated").textContent = `${data.stale ? "Last snapshot" : "Updated"} ${stamp} · ${state.placementRows.length} tests`;
  const errors = Array.isArray(data.errors) ? data.errors.filter(Boolean) : [];
  if (data.rateLimited && state.placementRows.length) {
    banner.textContent = "SmartDelivery rate-limited this pass. The remaining tests update in a minute.";
    banner.className = "muted";
  } else if (data.pending) {
    banner.textContent = "Still loading placement tests. This page will keep updating.";
    banner.className = "muted";
  } else if (data.stale && state.placementRows.length) {
    banner.textContent = errors[0] || "Showing the last saved snapshot — SmartDelivery did not refresh this pass.";
    banner.className = "muted";
  } else if (errors.length) {
    banner.textContent = errors.join(" ");
    banner.className = "error";
  }
  if (pass < 20 && data.rateLimited) {
    await new Promise((resolve) => setTimeout(resolve, 65_000));
    return loadPlacement(true, pass + 1);
  }
  const keepGoing = data.pending || (data.complete === false && !data.stale);
  if (keepGoing && Date.now() - state.placementPollSince < 4 * 60 * 1000) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    return loadPlacement(true, pass + 1);
  }
}

function linkify(text) {
  const fragment = document.createDocumentFragment();
  const parts = String(text || "").split(/(https:\/\/cursor\.com\/agents\/[^\s)]+)/g);
  for (const part of parts) {
    if (/^https:\/\/cursor\.com\/agents\//.test(part)) {
      const a = document.createElement("a");
      a.href = part;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = part;
      fragment.append(a);
    } else if (part) {
      fragment.append(document.createTextNode(part));
    }
  }
  return fragment;
}

function addMessage(role, text) {
  const messages = $("#messages");
  const bubble = make("div", `message ${role}`);
  bubble.append(linkify(text));
  bubble.append(make("small", "", role === "assistant" ? "Wizard" : state.user.username));
  messages.append(bubble);
  messages.scrollTop = messages.scrollHeight;
  return bubble;
}

function setBubbleText(bubble, text) {
  const small = bubble.querySelector("small");
  bubble.textContent = "";
  bubble.append(linkify(text));
  if (small) bubble.append(small);
  else bubble.append(make("small", "", "Wizard"));
  $("#messages").scrollTop = $("#messages").scrollHeight;
}

async function sendChat(message) {
  addMessage("user", message);
  const bubble = addMessage("assistant", "Thinking…");
  try {
    const data = await api("/chat", {
      method: "POST",
      body: JSON.stringify({ message }),
    });
    setBubbleText(bubble, data.message || "");
    if (data.data?.pending && data.data.agentId && data.data.runId) {
      pollCursor(bubble, data.data.agentId, data.data.runId);
    }
  } catch (error) {
    setBubbleText(bubble, error.message);
  }
}

async function pollCursor(bubble, agentId, runId) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      const data = await api(`/cursor-run/${agentId}/${runId}`);
      if (data.message) setBubbleText(bubble, data.message);
      if (!data.data?.pending) return;
    } catch (error) {
      setBubbleText(bubble, error.message);
      return;
    }
  }
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#login-error").textContent = "";
  try {
    const response = await api("/login", {
      method: "POST",
      body: JSON.stringify({
        username: $("#username").value,
        accessKey: $("#access-key").value,
      }),
    });
    state.user = response.user;
    state.csrf = response.csrf;
    $("#access-key").value = "";
    showApp();
    await Promise.all([loadToday(), loadWatchdog(), loadFix(), loadCalling(), loadLinkedin()]);
    addMessage("assistant", "Signed in. The grid is the last hourly sweep.");
  } catch (error) {
    $("#login-error").textContent = error.message;
  }
});

$("#logout").addEventListener("click", async () => {
  await api("/logout", { method: "POST", body: "{}" }).catch(() => {});
  state.user = null;
  state.csrf = "";
  closeChat();
  showLogin();
});

$("#open-chat").addEventListener("click", openChat);
$("#close-chat").addEventListener("click", closeChat);
$("#chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#chat-input");
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  await sendChat(message);
});

$$(".nav-item").forEach((button) => button.addEventListener("click", () => switchPanel(button.dataset.panel)));

(async function boot() {
  try {
    const config = await api("/config");
    if (!config.configured) {
      showLogin(config.error || "Operations UI is not configured");
      $("#login-form button").disabled = true;
      return;
    }
    const session = await api("/session");
    state.user = session.user;
    state.csrf = session.csrf;
    showApp();
    await Promise.all([loadToday(), loadWatchdog(), loadFix(), loadCalling(), loadLinkedin()]);
  } catch {
    showLogin();
  }
})();
