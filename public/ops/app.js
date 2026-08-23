const state = {
  csrf: "",
  user: null,
  dashboard: null,
  placementRows: [],
  placementSort: { key: "createdAt", direction: "desc" },
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
  $("#user-name").textContent = state.user.username;
  $("#user-role").textContent = state.user.role;
  $("#user-initial").textContent = state.user.username[0].toUpperCase();
  $$(".owner-only").forEach((element) => {
    element.classList.toggle("hidden", state.user.role !== "owner");
  });
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add("hidden"), 3500);
}

async function withLoadingButton(button, loadingText, task) {
  if (button.disabled) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = loadingText;
  try {
    await task();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function formatDate(value) {
  if (!value) return "Not yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function age(value) {
  if (!value) return "never";
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return "unknown";
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

async function loadDashboard(force = false) {
  const data = await api(`/dashboard${force ? "?force=1" : ""}`);
  state.dashboard = data;
  const count = (value) => (value == null ? "—" : value);
  const cards = [
    ["Sending mailboxes", count(data.fleet.sendingMailboxes), data.fleet.activeCampaigns == null ? "Live Smartlead count unavailable" : `Across ${data.fleet.activeCampaigns} active campaigns`],
    ["In recovery", data.fleet.mailboxesInRecovery, `${data.policy.recoveryHoldDays}-day recovery hold`],
    ["Resting (off-week)", data.pool.restingInboxes || 0, data.policy.clientRest ? "Per-client A/B · generics on send clock" : "Sender rest is off"],
    ["Total mailboxes", count(data.fleet.totalMailboxes), "All Smartlead accounts"],
    ["Available generics", data.pool.byStatus.available || 0, `${data.pool.total} total pool records`],
    ["Warming generics", data.pool.byStatus.warming || 0, `${data.policy.warmupDays}-day pool / ${data.policy.freshInboxWarmupDays}-day fresh`],
    ["Disconnected", count(data.fleet.disconnectedMailboxes), "SMTP or IMAP failed"],
  ];
  const kpis = $("#kpis");
  kpis.replaceChildren(
    ...cards.map(([label, value, note]) => {
      const card = make("article", "kpi");
      card.append(make("span", "", label), make("strong", "", String(value)), make("small", "", note));
      return card;
    }),
  );

  const policies = [
    ["Campaign floor", `${data.policy.campaignSenderFloor} staffable`],
    ["Mailbox cap", `${data.policy.mailboxDailyCap}/day`],
    ["Inbox threshold", `${data.policy.inboxThreshold}% same-ESP`],
    ["Bounce pull / warn", `${data.policy.bounceThreshold}% pull · ${data.policy.bounceWarnThreshold}% warn`],
    ["Fresh / pool warmup", `${data.policy.freshInboxWarmupDays}d fresh · ${data.policy.warmupDays}d pool`],
    ["Client rest", data.policy.clientRest ? "Per-client A/B · 2 on / 2 off" : "Off"],
    ["Generic sit / ESP mix", `${data.policy.genericSendRestDays}d send · ${data.policy.espMixMinPercent}% each ESP`],
    ["Hold rebuild", data.policy.restBaselineRebuiltAt ? `Done ${String(data.policy.restBaselineRebuiltAt).slice(0, 10)}` : data.policy.restBaselineRebuild ? "Pending first health" : "Off"],
    ["Recovery hold", `${data.policy.recoveryHoldDays} days`],
  ];
  $("#policy-grid").replaceChildren(
    ...policies.map(([label, value]) => {
      const item = make("div", "policy-item");
      item.append(make("span", "", label), make("strong", "", value));
      return item;
    }),
  );

  const runNames = {
    scan: "Placement scan",
    monitor: "Result monitor",
    remediation: "Remediation",
    reconnect: "Reconnect",
    warmupGate: "Warmup gate",
    health: "Campaign health / rest",
  };
  $("#last-runs").replaceChildren(
    ...Object.entries(data.lastRuns).map(([key, value]) => {
      const item = make("div", "run-item");
      item.append(make("span", "", runNames[key] || key), make("strong", "", age(value)));
      item.title = formatDate(value);
      return item;
    }),
  );

  if (state.user.role === "owner") {
    $("#approval-badge").textContent = String(data.pendingApprovals || 0);
  }
  $("#isolation-badge").textContent = String(data.pendingIsolation || 0);
  if (data.fleetError) toast(`Live fleet count unavailable: ${data.fleetError}`);
  if (data.campaignSetupPrompt) {
    $("#setup-prompt").textContent = data.campaignSetupPrompt;
  }
  renderAudit(data.recentAudit || []);
}

function switchPanel(name) {
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.panel === name));
  $$(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === `${name}-panel`));
  const title = { overview: "Overview", placement: "Placement results", isolation: "Isolation", chat: "Assistant", approvals: "Approvals", audit: "Audit log" };
  $("#panel-title").textContent = title[name] || name;
  if (name === "approvals") loadApprovals().catch((error) => toast(error.message));
  if (name === "isolation") loadIsolation().catch((error) => toast(error.message));
  if (name === "audit") loadAudit().catch((error) => toast(error.message));
  if (name === "placement" && !state.placementRows.length) {
    loadPlacement().catch((error) => toast(error.message));
  }
}

function percent(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toFixed(1)}%`
    : "—";
}

function scoreClass(value, inverse = false) {
  if (typeof value !== "number") return "score-unknown";
  if (inverse) {
    if (value <= 10) return "score-good";
    if (value <= 30) return "score-warn";
    return "score-bad";
  }
  if (value >= 80) return "score-good";
  if (value >= 50) return "score-warn";
  return "score-bad";
}

function placementValue(row, key) {
  const value = row[key];
  if (value == null || value === "") return null;
  if (key === "createdAt") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "number") return value;
  return String(value).toLowerCase();
}

function renderPlacement() {
  const query = $("#placement-search").value.trim().toLowerCase();
  const { key, direction } = state.placementSort;
  const directionFactor = direction === "asc" ? 1 : -1;
  const rows = state.placementRows
    .filter((row) =>
      `${row.name} ${row.campaignName || ""} ${row.campaignId || ""} ${row.status} ${row.id}`
        .toLowerCase()
        .includes(query),
    )
    .sort((a, b) => {
      const left = placementValue(a, key);
      const right = placementValue(b, key);
      if (left === right) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      return (left < right ? -1 : 1) * directionFactor;
    });

  const body = $("#placement-body");
  body.replaceChildren(
    ...rows.map((row) => {
      const tr = document.createElement("tr");
      const test = document.createElement("td");
      test.append(make("strong", "", row.name));
      test.append(make("small", "", `#${row.id}${row.runNumber != null ? ` · run ${row.runNumber}` : ""}`));
      const campaign = document.createElement("td");
      campaign.append(make("span", "", row.campaignName || (row.campaignId ? `Campaign #${row.campaignId}` : "—")));
      const status = document.createElement("td");
      status.append(make("span", `status ${String(row.status).toLowerCase() === "completed" ? "success" : "pending"}`, row.status));
      const inbox = make("td", scoreClass(row.inboxPercent), percent(row.inboxPercent));
      const google = make("td", scoreClass(row.googleInboxPercent), percent(row.googleInboxPercent));
      const microsoft = make("td", scoreClass(row.microsoftInboxPercent), percent(row.microsoftInboxPercent));
      const spam = make("td", scoreClass(row.spamPercent, true), percent(row.spamPercent));
      const seeds = make("td", "", String(row.totalSeeds || "—"));
      const date = make("td", "", formatDate(row.createdAt));
      tr.append(test, campaign, status, inbox, google, microsoft, spam, seeds, date);
      return tr;
    }),
  );
  $("#placement-empty").classList.toggle("hidden", rows.length > 0);
  $$("[data-sort]").forEach((button) => {
    const active = button.dataset.sort === key;
    button.classList.toggle("active", active);
    button.dataset.direction = active ? direction : "";
  });
}

async function loadPlacement(force = false) {
  $("#placement-errors").textContent = "";
  const data = await api(`/placements${force ? "?force=1" : ""}`);
  state.placementRows = data.rows || [];
  $("#placement-updated").textContent = `Updated ${formatDate(data.generatedAt)} · ${state.placementRows.length} tests`;
  $("#placement-errors").textContent = data.errors?.length
    ? `${data.errors.length} provider report(s) could not be loaded`
    : "";
  renderPlacement();
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

function addMessage(role, text, confirmation) {
  const messages = $("#messages");
  const bubble = make("div", `message ${role}`);
  bubble.append(linkify(text));
  bubble.append(make("small", "", role === "assistant" ? "Deliverability Ops" : state.user.username));
  messages.append(bubble);
  if (confirmation?.type === "rotate") {
    const card = make("div", "confirm-card");
    card.append(make("strong", "", "Confirm one-mailbox rotation"));
    const description = make("p", "muted", `Revalidates all safety rules, then rotates ${confirmation.email}.`);
    const button = make("button", "", "Confirm rotation");
    button.addEventListener("click", () => executeRotation(confirmation.email, button));
    card.append(description, button);
    messages.append(card);
  }
  messages.scrollTop = messages.scrollHeight;
  return bubble;
}

function setBubbleText(bubble, text) {
  const small = bubble.querySelector("small");
  bubble.textContent = "";
  bubble.append(linkify(text));
  if (small) bubble.append(small);
  else bubble.append(make("small", "", "Deliverability Ops"));
  $("#messages").scrollTop = $("#messages").scrollHeight;
}

async function pollCursorRun(agentId, runId, bubble) {
  const started = Date.now();
  const maxMs = 10 * 60 * 1000;
  while (Date.now() - started < maxMs) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    try {
      const response = await api(`/cursor-run/${encodeURIComponent(agentId)}/${encodeURIComponent(runId)}`);
      if (response.data?.pending) {
        setBubbleText(
          bubble,
          `Still working in Cursor Grok 4.5 High Fast…\n${response.data.agentUrl || ""}`,
        );
        continue;
      }
      setBubbleText(bubble, response.message || "Done.");
      return;
    } catch (error) {
      setBubbleText(
        bubble,
        `Couldn't read the Cursor answer yet (${error.message}). Keep this tab open — retrying…`,
      );
    }
  }
  setBubbleText(
    bubble,
    "Cursor is still running. Open the agent link above (or refresh later) — the answer may take a few more minutes.",
  );
}

async function sendChat(message) {
  switchPanel("chat");
  addMessage("user", message);
  const looksFreeform =
    !/^(help|commands|status|check |audit |reconnect|rotate |approvals)/i.test(
      message.trim(),
    );
  const loading = addMessage(
    "assistant",
    looksFreeform
      ? "Starting Cursor Grok 4.5 High Fast…"
      : "Working…",
  );
  try {
    const response = await api("/chat", {
      method: "POST",
      body: JSON.stringify({ message }),
    });
    if (response.confirmation) {
      loading.remove();
      addMessage("assistant", response.message, response.confirmation);
      return;
    }
    if (response.data?.pending && response.data.agentId && response.data.runId) {
      setBubbleText(
        loading,
        [response.message || "Cursor is working…", "", "Waiting for the answer…"].join(
          "\n",
        ),
      );
      await pollCursorRun(response.data.agentId, response.data.runId, loading);
      return;
    }
    setBubbleText(loading, response.message || "Done.");
    if (response.data?.refreshDashboard) await loadDashboard();
    if (response.data?.refreshApprovals) await loadApprovals();
    if (
      response.data &&
      !response.data.refreshDashboard &&
      !response.data.refreshApprovals &&
      !response.data.pending &&
      !response.data.agentUrl
    ) {
      const summary = summarizeData(response.data);
      if (summary) addMessage("assistant", summary);
    }
  } catch (error) {
    setBubbleText(loading, `Operation failed safely: ${error.message}`);
  }
}

function summarizeData(data) {
  if (data.monitor || data.dns || (data.campaigns && !Array.isArray(data.campaigns))) {
    const lines = [];
    if (data.monitor) {
      lines.push(
        `Placement: ${data.monitor.testsChecked || 0} tests checked, ${data.monitor.blacklistAlerts || 0} blacklist alert(s), ${data.monitor.lowDeliverabilityAlerts || 0} weak-placement alert(s).`,
      );
      if (data.monitor.errors?.length) lines.push(`Placement problems: ${data.monitor.errors.slice(0, 3).join("; ")}`);
    }
    if (data.dns) lines.push(`DNS: ${data.dns.checked || 0} checked, ${data.dns.critical?.length || 0} critical.`);
    if (data.campaigns) {
      lines.push(
        `Campaigns: ${data.campaigns.campaigns?.length || 0} active, ${data.campaigns.understaffed?.length || 0} understaffed, ${data.campaigns.untested?.length || 0} untested.`,
      );
    }
    return lines.join("\n");
  }
  if (data.checked !== undefined && data.critical) {
    return `DNS: ${data.checked} domains checked, ${data.clean} clean, ${data.critical.length} critical.`;
  }
  if (data.campaigns && Array.isArray(data.campaigns)) {
    return `Campaign audit: ${data.campaigns.length} active, ${data.understaffed.length} understaffed, ${data.untested.length} untested.`;
  }
  if (data.scanned !== undefined && data.disconnected !== undefined) {
    return `Reconnect: ${data.scanned} checked, ${data.disconnected} disconnected, ${data.reconnected} reconnected, ${data.failed} failed.`;
  }
  return "";
}

async function executeRotation(email, button) {
  if (!window.confirm(`Rotate ${email}? This removes it from active campaigns and holds it for recovery.`)) return;
  button.disabled = true;
  button.textContent = "Rotating…";
  try {
    const response = await api("/rotate", {
      method: "POST",
      body: JSON.stringify({ email, confirm: "ROTATE" }),
    });
    addMessage(
      "assistant",
      `Rotation completed. ${email} is warming until ${response.result.preview.holdUntil}; ${response.result.preview.replacement.email} is covering its campaigns.`,
    );
    button.closest(".confirm-card").remove();
    await loadDashboard();
  } catch (error) {
    addMessage("assistant", `Rotation did not complete: ${error.message}`);
    button.disabled = false;
    button.textContent = "Confirm rotation";
  }
}

function isolationKindLabel(kind) {
  if (kind === "buy_domains") return "Buy replacements";
  if (kind === "buy_canary_fleet") return "Buy canary fleet";
  if (kind === "retire_domain") return "Retire domain";
  if (kind === "swap_copy") return "Switch the word";
  return kind;
}

function isolationApproveLabel(kind) {
  if (kind === "swap_copy") return "Switch the word";
  if (kind === "buy_domains") return "Buy replacements";
  if (kind === "buy_canary_fleet") return "Buy canary fleet";
  return "Retire this domain";
}

function canDecideIsolation(action) {
  if (action.status !== "pending") return false;
  if (action.kind === "swap_copy") return true;
  return state.user.role === "owner";
}

async function loadIsolation() {
  const data = await api("/isolation");
  const actions = $("#isolation-actions");
  const domains = $("#isolation-domains");
  const runs = $("#isolation-runs");
  if (!data.actions.length) {
    actions.replaceChildren(make("p", "muted", "Nothing waiting on a human."));
  } else {
    actions.replaceChildren(
      ...data.actions.map((action) => {
        const card = make("div", "stack-card");
        const header = make("header");
        header.append(
          make("strong", "", action.title || isolationKindLabel(action.kind)),
          make("span", `status ${action.status}`, action.status),
        );
        card.append(header);
        if (action.proof) card.append(make("pre", "setup-prompt", action.proof));
        card.append(make("p", "muted", formatDate(action.requestedAt)));
        if (canDecideIsolation(action)) {
          const row = make("div", "approval-actions");
          const approve = make(
            "button",
            "approve",
            isolationApproveLabel(action.kind),
          );
          const deny = make("button", "deny", "Not now");
          approve.addEventListener("click", () => decideIsolation(action.id, "approve"));
          deny.addEventListener("click", () => decideIsolation(action.id, "deny"));
          row.append(approve, deny);
          card.append(row);
        } else if (action.status === "pending" && state.user.role !== "owner") {
          card.append(make("p", "muted", "Josh has to approve this one."));
        }
        return card;
      }),
    );
  }

  if (!data.domains.length) {
    domains.replaceChildren(make("p", "muted", "No known-good domain readings yet."));
  } else {
    domains.replaceChildren(
      ...data.domains.map((row) => {
        const card = make("div", "stack-card");
        const header = make("header");
        header.append(make("strong", "", row.domain), make("span", `status ${row.status}`, row.status));
        card.append(header);
        card.append(
          make(
            "p",
            "",
            row.fleet
              ? `${row.consecutiveFails} fail cycle${row.consecutiveFails === 1 ? "" : "s"} in a row. Fleet domain — several inboxes must fail.`
              : `${row.consecutiveFails} fail cycle${row.consecutiveFails === 1 ? "" : "s"} in a row.`,
          ),
        );
        if (row.lastReason) card.append(make("p", "muted", row.lastReason));
        const last = row.readings?.[row.readings.length - 1];
        if (last?.failingEmails?.length) {
          card.append(make("p", "", `Failed: ${last.failingEmails.join(", ")}`));
        }
        return card;
      }),
    );
  }

  if (!data.runs.length) {
    runs.replaceChildren(make("p", "muted", "No campaign copy-or-inboxes checks yet."));
  } else {
    runs.replaceChildren(
      ...data.runs.map((run) => {
        const card = make("div", "stack-card");
        const header = make("header");
        header.append(
          make("strong", "", run.campaignName || `Campaign ${run.campaignId}`),
          make("span", `status ${run.verdict}`, run.verdict),
        );
        card.append(header, make("p", "", run.reason || ""));
        if (run.notes) card.append(make("pre", "setup-prompt", run.notes));
        return card;
      }),
    );
  }
}

async function decideIsolation(id, decision) {
  const label = decision === "approve" ? "Do this" : "Leave it";
  if (!window.confirm(`${label}?`)) return;
  const result = await api(`/isolation/actions/${encodeURIComponent(id)}/${decision}`, {
    method: "POST",
    body: JSON.stringify({ confirm: true }),
  });
  toast(result.message || `Request ${decision}d`);
  await Promise.all([loadIsolation(), loadDashboard()]);
}

async function loadApprovals() {
  if (state.user.role !== "owner") return;
  const { approvals } = await api("/approvals");
  const list = $("#approvals-list");
  const ordered = [...approvals].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  if (!ordered.length) {
    list.replaceChildren(make("p", "muted", "No spend requests."));
    return;
  }
  list.replaceChildren(
    ...ordered.map((approval) => {
      const card = make("div", "stack-card");
      const header = make("header");
      header.append(make("strong", "", approval.kind), make("span", `status ${approval.status}`, approval.status));
      card.append(header, make("p", "", approval.description), make("p", "muted", formatDate(approval.requestedAt)));
      if (approval.status === "pending") {
        const actions = make("div", "approval-actions");
        const approve = make("button", "approve", "Approve");
        const deny = make("button", "deny", "Deny");
        approve.addEventListener("click", () => decideApproval(approval.id, "approve"));
        deny.addEventListener("click", () => decideApproval(approval.id, "deny"));
        actions.append(approve, deny);
        card.append(actions);
      }
      return card;
    }),
  );
}

async function decideApproval(id, decision) {
  if (!window.confirm(`${decision === "approve" ? "Approve" : "Deny"} this spend request?`)) return;
  await api(`/approvals/${encodeURIComponent(id)}/${decision}`, {
    method: "POST",
    body: JSON.stringify({ confirm: true }),
  });
  toast(`Spend request ${decision}d`);
  await Promise.all([loadApprovals(), loadDashboard()]);
}

function renderAudit(records) {
  const list = $("#audit-list");
  if (!records.length) {
    list.replaceChildren(make("p", "muted", "No console operations yet."));
    return;
  }
  list.replaceChildren(
    ...records.map((record) => {
      const card = make("div", "stack-card");
      const header = make("header");
      header.append(
        make("strong", "", `${record.actor} · ${record.action}`),
        make("span", `status ${record.outcome}`, record.outcome),
      );
      card.append(header, make("p", "muted", `${formatDate(record.at)}${record.target ? ` · ${record.target}` : ""}`));
      if (record.detail) card.append(make("p", "", record.detail));
      return card;
    }),
  );
}

async function loadAudit() {
  const { audit } = await api("/audit");
  renderAudit(audit);
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
    await loadDashboard();
    addMessage("assistant", "Signed in. Ask “help” to see allowlisted operations.");
  } catch (error) {
    $("#login-error").textContent = error.message;
  }
});

$("#logout").addEventListener("click", async () => {
  await api("/logout", { method: "POST", body: "{}" }).catch(() => {});
  state.user = null;
  state.csrf = "";
  showLogin();
});

$("#chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#chat-input");
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  await sendChat(message);
});

$("#chat-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("#chat-form").requestSubmit();
  }
});

$$(".nav-item").forEach((button) => button.addEventListener("click", () => switchPanel(button.dataset.panel)));
$$("[data-command]").forEach((button) => button.addEventListener("click", () => sendChat(button.dataset.command)));
$("#copy-setup-prompt").addEventListener("click", async () => {
  const text = $("#setup-prompt").textContent || "";
  if (!text) {
    toast("Load the dashboard first.");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast("Campaign setup prompt copied.");
  } catch {
    toast("Copy failed — select the prompt text instead.");
  }
});
$("#refresh-dashboard").addEventListener("click", (event) =>
  withLoadingButton(event.currentTarget, "Refreshing…", () =>
    loadDashboard(true),
  ).catch((error) => toast(error.message)),
);
$("#refresh-placement").addEventListener("click", (event) =>
  withLoadingButton(event.currentTarget, "Refreshing…", () =>
    loadPlacement(true),
  ).catch((error) => toast(error.message)),
);
$("#placement-search").addEventListener("input", renderPlacement);
$$("[data-sort]").forEach((button) =>
  button.addEventListener("click", () => {
    const key = button.dataset.sort;
    state.placementSort =
      state.placementSort.key === key
        ? {
            key,
            direction:
              state.placementSort.direction === "asc" ? "desc" : "asc",
          }
        : {
            key,
            direction:
              ["name", "campaignName", "status"].includes(key) ? "asc" : "desc",
          };
    renderPlacement();
  }),
);
$("#refresh-approvals").addEventListener("click", () => loadApprovals().catch((error) => toast(error.message)));
$("#refresh-isolation").addEventListener("click", () => loadIsolation().catch((error) => toast(error.message)));
$("#refresh-audit").addEventListener("click", () => loadAudit().catch((error) => toast(error.message)));

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
    await loadDashboard();
    addMessage("assistant", "Welcome back. Ask “help” to see allowlisted operations.");
  } catch {
    showLogin();
  }
})();
