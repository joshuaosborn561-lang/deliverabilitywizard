(() => {
  const state = {
    data: null,
    view: "campaigns",
    filter: "",
    selectedReply: 0,
    campaignFocus: null,
  };

  const els = {
    viewEyebrow: document.getElementById("view-eyebrow"),
    viewTitle: document.getElementById("view-title"),
    replyCount: document.getElementById("reply-count"),
    railNote: document.getElementById("rail-note"),
    filter: document.getElementById("filter"),
    statRow: document.getElementById("stat-row"),
    campaignRows: document.getElementById("campaign-rows"),
    viewCampaigns: document.getElementById("view-campaigns"),
    viewReplies: document.getElementById("view-replies"),
    threadList: document.getElementById("thread-list"),
    threadPane: document.getElementById("thread-pane"),
  };

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
      .replace(/████+/g, (m) => `<span class="offer-redact">${m}</span>`);
  }

  function matchesFilter(hay) {
    const q = state.filter.trim().toLowerCase();
    if (!q) return true;
    return hay.toLowerCase().includes(q);
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
      if (
        state.campaignFocus != null &&
        r.campaignOldId !== state.campaignFocus
      ) {
        return false;
      }
      return matchesFilter(
        [
          r.campaignName,
          r.category,
          r.fromName,
          r.company,
          r.subject,
          r.body,
        ].join(" "),
      );
    });
  }

  function renderStats() {
    const camps = state.data.campaigns || [];
    const totals = camps.reduce(
      (acc, c) => {
        acc.sent += c.sent || 0;
        acc.replied += c.replied || 0;
        acc.positive += c.positive || 0;
        acc.bounced += c.bounced || 0;
        return acc;
      },
      { sent: 0, replied: 0, positive: 0, bounced: 0 },
    );
    els.statRow.innerHTML = [
      ["Sent", totals.sent],
      ["Replied", totals.replied],
      ["Positive", totals.positive],
      ["Bounced", totals.bounced],
    ]
      .map(
        ([label, value]) =>
          `<div class="kpi"><span>${label}</span><strong>${fmt(value)}</strong></div>`,
      )
      .join("");
  }

  function renderCampaigns() {
    const rows = (state.data.campaigns || []).filter((c) =>
      matchesFilter(`${c.name} ${c.oldId} ${c.newId}`),
    );
    els.campaignRows.innerHTML = rows
      .map((c) => {
        const drafted = String(c.status || "").toUpperCase() === "DRAFTED";
        return `<tr>
          <td>
            <span class="campaign-name">${escapeHtml(c.name)}</span>
            <span class="campaign-ids">#${c.oldId} → #${c.newId}</span>
          </td>
          <td><span class="status-pill ${drafted ? "drafted" : ""}">${escapeHtml(c.status || "COMPLETED")}</span></td>
          <td class="num">${fmt(c.leads)}</td>
          <td class="num">${fmt(c.sent)}</td>
          <td class="num">${fmt(c.replied)}</td>
          <td class="num pos">${fmt(c.positive)}</td>
          <td class="num bounce">${fmt(c.bounced)}</td>
          <td><button type="button" class="linkish" data-open-replies="${c.oldId}">Replies</button></td>
        </tr>`;
      })
      .join("");
  }

  function renderReplies() {
    const list = repliesVisible();
    els.replyCount.textContent = String((state.data.replies || []).length);
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
          <div class="meta">${escapeHtml(r.campaignName)} · <span class="blur-email">${escapeHtml(r.fromEmailMasked)}</span></div>
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
    els.threadPane.innerHTML = `
      <div class="thread-head">
        <h3>${escapeHtml(r.subject)}</h3>
        <div class="row">
          <span class="cat ${catClass}">${escapeHtml(r.category)}</span>
          <span>${escapeHtml(r.fromName)}</span>
          <span class="blur-email">${escapeHtml(r.fromEmailMasked)}</span>
          <span>${escapeHtml(r.campaignName)}</span>
          <span>${escapeHtml(when)}</span>
        </div>
      </div>
      <div class="thread-body">${decorateBody(r.body)}</div>`;
  }

  function render() {
    if (!state.data) return;
    if (state.view === "campaigns") {
      renderStats();
      renderCampaigns();
    } else {
      renderReplies();
    }
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

  els.campaignRows.addEventListener("click", (e) => {
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
      els.replyCount.textContent = String((data.replies || []).length);
      setView("campaigns");
    })
    .catch((err) => {
      els.viewTitle.textContent = "Failed to load";
      els.railNote.textContent = String(err.message || err);
    });
})();
