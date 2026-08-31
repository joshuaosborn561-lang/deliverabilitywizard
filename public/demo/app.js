(() => {
  const STORAGE_KEY = "dw-demo-hidden-campaigns";

  const state = {
    data: null,
    view: "campaigns",
    filter: "",
    client: "all",
    selectedReply: 0,
    campaignFocus: null,
    hiddenIds: loadHidden(),
  };

  const els = {
    viewEyebrow: document.getElementById("view-eyebrow"),
    viewTitle: document.getElementById("view-title"),
    replyCount: document.getElementById("reply-count"),
    railNote: document.getElementById("rail-note"),
    filter: document.getElementById("filter"),
    clientFilters: document.getElementById("client-filters"),
    statRow: document.getElementById("stat-row"),
    campaignRows: document.getElementById("campaign-rows"),
    campaignsEmpty: document.getElementById("campaigns-empty"),
    hiddenCount: document.getElementById("hidden-count"),
    restoreHidden: document.getElementById("restore-hidden"),
    viewCampaigns: document.getElementById("view-campaigns"),
    viewReplies: document.getElementById("view-replies"),
    threadList: document.getElementById("thread-list"),
    threadPane: document.getElementById("thread-pane"),
  };

  function loadHidden() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return new Set(
        (Array.isArray(parsed) ? parsed : [])
          .map(Number)
          .filter((n) => Number.isFinite(n)),
      );
    } catch {
      return new Set();
    }
  }

  function saveHidden() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...state.hiddenIds]));
  }

  function clientLabel(keyOrCampaign) {
    if (keyOrCampaign && typeof keyOrCampaign === "object") {
      return keyOrCampaign.client || "Client";
    }
    const clients = state.data?.clients || [];
    const hit = clients.find((c) => c.key === keyOrCampaign);
    return hit?.label || "Client";
  }

  function clientKeyOf(item) {
    return item.clientKey || "X";
  }

  function fmt(n) {
    return Number(n || 0).toLocaleString("en-US");
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function decorateBody(text) {
    return escapeHtml(text)
      .replace(
        /[A-Za-z0-9•]+\@[A-Za-z0-9•]+\.[A-Za-z]+/g,
        (m) => `<span class="blur-email">${m}</span>`,
      )
      // Remaining █ blocks are client signatures / stray redactionsacts — blur them.
      .replace(/█+/g, (m) => `<span class="blur-signature">${m}</span>`);
  }

  function blurSubject(text) {
    const raw = String(text || "████████");
    return `<span class="blur-subject" title="Subject hidden">${escapeHtml(raw)}</span>`;
  }

  function blurClient(label) {
    return `<span class="blur-client" title="Client hidden">${escapeHtml(label)}</span>`;
  }

  function matchesText(hay) {
    const q = state.filter.trim().toLowerCase();
    if (!q) return true;
    return hay.toLowerCase().includes(q);
  }

  function matchesClient(item) {
    if (state.client === "all") return true;
    return clientKeyOf(item) === state.client;
  }

  function visibleCampaigns() {
    return (state.data?.campaigns || []).filter((c) => {
      if (state.hiddenIds.has(Number(c.oldId))) return false;
      if (!matchesClient(c)) return false;
      return matchesText(`${c.name} ${c.oldId} ${c.newId} ${c.client}`);
    });
  }

  function setView(view) {
    state.view = view;
    document.querySelectorAll(".nav-item").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === view);
    });
    els.viewCampaigns.classList.toggle("active", view === "campaigns");
    els.viewReplies.classList.toggle("active", view === "replies");
    els.viewEyebrow.textContent =
      view === "campaigns" ? "Restored clients" : "Inbound replies";
    els.viewTitle.textContent = view === "campaigns" ? "Campaigns" : "Replies";
    els.filter.placeholder =
      view === "campaigns" ? "Filter campaigns…" : "Filter replies…";
    render();
  }

  function repliesVisible() {
    return (state.data?.replies || []).filter((r) => {
      if (state.hiddenIds.has(Number(r.campaignOldId))) return false;
      if (
        state.campaignFocus != null &&
        r.campaignOldId !== state.campaignFocus
      ) {
        return false;
      }
      if (!matchesClient(r)) return false;
      return matchesText(
        [
          r.campaignName,
          r.client,
          r.category,
          r.fromName,
          r.company,
          r.body,
          r.outreach?.body,
        ]
          .filter(Boolean)
          .join(" "),
      );
    });
  }

  function renderClientFilters() {
    const clients = state.data?.clients || [];
    const keys = ["all", ...clients.map((c) => c.key)];
    els.clientFilters.innerHTML = keys
      .map((key) => {
        const label =
          key === "all"
            ? "All clients"
            : clients.find((c) => c.key === key)?.label || key;
        const active = state.client === key ? "active" : "";
        const shown =
          key === "all"
            ? escapeHtml(label)
            : `<span class="blur-client">${escapeHtml(label)}</span>`;
        return `<button type="button" class="chip ${active}" data-client="${escapeHtml(key)}">${shown}</button>`;
      })
      .join("");
  }

  function renderStats() {
    const camps = visibleCampaigns();
    const totals = camps.reduce(
      (acc, c) => {
        acc.sent += c.sent || 0;
        acc.replied += c.replied || 0;
        acc.positive += c.positive || 0;
        acc.interested += c.interested || 0;
        acc.bounced += c.bounced || 0;
        return acc;
      },
      { sent: 0, replied: 0, positive: 0, interested: 0, bounced: 0 },
    );
    els.statRow.innerHTML = [
      ["Sent", totals.sent],
      ["Replied", totals.replied],
      ["Positive", totals.positive],
      ["Interested", totals.interested],
      ["Bounced", totals.bounced],
    ]
      .map(
        ([label, value]) =>
          `<div class="kpi"><span>${label}</span><strong>${fmt(value)}</strong></div>`,
      )
      .join("");
  }

  function renderHiddenControls() {
    const n = state.hiddenIds.size;
    els.hiddenCount.textContent = n
      ? `${n} hidden from this board`
      : "Sent / reply totals from before the delete";
    els.restoreHidden.classList.toggle("hidden", n === 0);
  }

  function renderCampaigns() {
    const rows = visibleCampaigns();
    els.campaignsEmpty.classList.toggle("hidden", rows.length > 0);
    els.campaignRows.innerHTML = rows
      .map((c) => {
        const drafted = String(c.status || "").toUpperCase() === "DRAFTED";
        return `<tr>
          <td>${blurClient(c.client || "Client")}</td>
          <td>
            <span class="campaign-name">${escapeHtml(c.name)}</span>
            <span class="campaign-ids">#${c.oldId} → #${c.newId}</span>
          </td>
          <td><span class="status-pill ${drafted ? "drafted" : ""}">${escapeHtml(c.status || "COMPLETED")}</span></td>
          <td class="num">${fmt(c.leads)}</td>
          <td class="num">${fmt(c.sent)}</td>
          <td class="num">${fmt(c.replied)}</td>
          <td class="num pos">${fmt(c.positive)}</td>
          <td class="num pos">${fmt(c.interested)}</td>
          <td class="num bounce">${fmt(c.bounced)}</td>
          <td>
            <div class="row-actions">
              <button type="button" class="linkish" data-open-replies="${c.oldId}">Replies</button>
              <button type="button" class="danger-link" data-delete-campaign="${c.oldId}" data-name="${escapeHtml(c.name)}">Delete</button>
            </div>
          </td>
        </tr>`;
      })
      .join("");
  }

  function renderMessageBubble(msg, kind) {
    if (!msg) return "";
    const label = kind === "outreach" ? "Your outreach" : "Their reply";
    const when = msg.at
      ? new Date(msg.at).toLocaleString("en-US", {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "";
    return `<div class="msg ${kind}">
      <div class="msg-meta">
        <strong>${label}</strong>
        <span>${blurSubject(msg.subject)}</span>
        <span>${escapeHtml(when)}</span>
      </div>
      <div class="msg-body">${decorateBody(msg.body || "")}</div>
    </div>`;
  }

  function renderReplies() {
    const list = repliesVisible();
    const aliveReplies = (state.data.replies || []).filter(
      (r) => !state.hiddenIds.has(Number(r.campaignOldId)),
    );
    els.replyCount.textContent = String(aliveReplies.length);
    if (!list.length) {
      els.threadList.innerHTML =
        '<div class="empty muted" style="padding:24px">No replies match.</div>';
      els.threadPane.innerHTML =
        '<div class="empty muted">Select a reply</div>';
      return;
    }
    if (state.selectedReply >= list.length) state.selectedReply = 0;
    els.threadList.innerHTML = list
      .map((r, i) => {
        const catClass =
          r.category === "Positive Reply" ? "" : "interested";
        return `<button type="button" class="thread-item ${i === state.selectedReply ? "active" : ""}" data-reply="${i}">
          <div class="who">
            <strong>${escapeHtml(r.fromName)}${r.company ? ` · ${escapeHtml(r.company)}` : ""}</strong>
            <span class="cat ${catClass}">${escapeHtml(r.category)}</span>
          </div>
          <div class="meta">${blurClient(r.client || "Client")} · ${blurSubject(r.subject)} · <span class="blur-email">${escapeHtml(r.fromEmailMasked)}</span></div>
          <div class="preview">${escapeHtml(r.body)}</div>
        </button>`;
      })
      .join("");

    const r = list[state.selectedReply];
    const when = r.at
      ? new Date(r.at).toLocaleString("en-US", {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "";
    const catClass = r.category === "Positive Reply" ? "" : "interested";
    const replyMsg = r.reply || {
      subject: r.subject,
      body: r.body,
      at: r.at,
    };
    els.threadPane.innerHTML = `
      <div class="thread-head">
        <h3>${blurSubject(r.subject)}</h3>
        <div class="row">
          <span class="cat ${catClass}">${escapeHtml(r.category)}</span>
          ${blurClient(r.client || "Client")}
          <span>${escapeHtml(r.fromName)}</span>
          <span class="blur-email">${escapeHtml(r.fromEmailMasked)}</span>
          <span>${escapeHtml(when)}</span>
        </div>
      </div>
      <div class="thread-thread">
        ${renderMessageBubble(r.outreach, "outreach")}
        ${renderMessageBubble(replyMsg, "reply")}
      </div>`;
  }

  function render() {
    if (!state.data) return;
    renderClientFilters();
    renderHiddenControls();
    if (state.view === "campaigns") {
      renderStats();
      renderCampaigns();
    } else {
      renderReplies();
    }
  }

  function hideCampaign(oldId) {
    state.hiddenIds.add(Number(oldId));
    saveHidden();
    if (state.campaignFocus === Number(oldId)) state.campaignFocus = null;
    render();
  }

  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.campaignFocus = null;
      setView(btn.dataset.view);
    });
  });

  els.filter.addEventListener("input", () => {
    state.filter = els.filter.value;
    render();
  });

  els.clientFilters.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-client]");
    if (!btn) return;
    state.client = btn.getAttribute("data-client") || "all";
    state.campaignFocus = null;
    render();
  });

  els.restoreHidden.addEventListener("click", () => {
    state.hiddenIds.clear();
    saveHidden();
    render();
  });

  els.campaignRows.addEventListener("click", (e) => {
    const del = e.target.closest("[data-delete-campaign]");
    if (del) {
      const id = Number(del.getAttribute("data-delete-campaign"));
      const name = del.getAttribute("data-name") || "this campaign";
      const ok = window.confirm(
        `Remove “${name}” from this archive board?\n\nThis only hides it in the demo (your browser). It does not delete anything in Smartlead.`,
      );
      if (ok) hideCampaign(id);
      return;
    }
    const btn = e.target.closest("[data-open-replies]");
    if (!btn) return;
    state.campaignFocus = Number(btn.getAttribute("data-open-replies"));
    state.selectedReply = 0;
    setView("replies");
  });

  els.threadList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-reply]");
    if (!btn) return;
    state.selectedReply = Number(btn.getAttribute("data-reply"));
    renderReplies();
  });

  fetch("./data.json")
    .then((r) => r.json())
    .then((data) => {
      state.data = data;
      els.railNote.textContent = data.note || "";
      setView("campaigns");
    })
    .catch((err) => {
      els.viewTitle.textContent = "Failed to load";
      els.railNote.textContent = String(err.message || err);
    });
})();
