const state = {
  csrf: "",
  user: null,
  dashboard: null,
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

async function loadDashboard() {
  const data = await api("/dashboard");
  state.dashboard = data;
  const cards = [
    ["Pool mailboxes", data.pool.total, `${data.pool.byStatus.available || 0} available`],
    ["Warming", data.pool.byStatus.warming || 0, `${data.policy.warmupDays}-day requirement`],
    ["Held inboxes", data.pool.heldInboxes, `${data.policy.recoveryHoldDays}-day recovery hold`],
    ["Active swaps", data.pool.activeSwaps, `${data.pool.byStatus.assigned || 0} assigned generics`],
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
    ["Campaign floor", `${data.policy.campaignSenderFloor} senders`],
    ["Mailbox cap", `${data.policy.mailboxDailyCap}/day`],
    ["Inbox threshold", `${data.policy.inboxThreshold}%`],
    ["Bounce trigger", `${data.policy.bounceThreshold}% after ${data.policy.bounceMinSample}`],
    ["Pool warmup", `${data.policy.warmupDays} days`],
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
  renderAudit(data.recentAudit || []);
}

function switchPanel(name) {
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.panel === name));
  $$(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === `${name}-panel`));
  const title = { overview: "Overview", chat: "Assistant", approvals: "Approvals", audit: "Audit log" };
  $("#panel-title").textContent = title[name] || name;
  if (name === "approvals") loadApprovals().catch((error) => toast(error.message));
  if (name === "audit") loadAudit().catch((error) => toast(error.message));
}

function addMessage(role, text, confirmation) {
  const messages = $("#messages");
  const bubble = make("div", `message ${role}`, text);
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
}

async function sendChat(message) {
  switchPanel("chat");
  addMessage("user", message);
  addMessage("assistant", "Working…");
  const loading = $("#messages").lastElementChild;
  try {
    const response = await api("/chat", {
      method: "POST",
      body: JSON.stringify({ message }),
    });
    loading.remove();
    addMessage("assistant", response.message, response.confirmation);
    if (response.data?.refreshDashboard) await loadDashboard();
    if (response.data?.refreshApprovals) await loadApprovals();
    if (response.data && !response.confirmation && !response.data.refreshDashboard && !response.data.refreshApprovals) {
      const summary = summarizeData(response.data);
      if (summary) addMessage("assistant", summary);
    }
  } catch (error) {
    loading.remove();
    addMessage("assistant", `Operation failed safely: ${error.message}`);
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
$("#refresh-dashboard").addEventListener("click", () => loadDashboard().catch((error) => toast(error.message)));
$("#refresh-approvals").addEventListener("click", () => loadApprovals().catch((error) => toast(error.message)));
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
