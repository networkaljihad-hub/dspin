/* =========================================================
   Daily Spin — admin console (SINGLE PAGE).
   Tabs: Dashboard · Withdrawals · Users — all client-side,
   no page reloads. Talks to the same Supabase project.

   PAGINATION: only 5 rows are fetched per page (offset-based).
   CACHING:    every fetched page is stored in localStorage
               (AdminStore, never expires), so revisiting a page
               is instant and the backend is not hit again.
               Refresh / Approve / Reject / Edit / Ban / Delete
               only update the page you are looking at.

   Only accounts flagged is_admin can use this (server-checked).
   ========================================================= */

"use strict";

(function () {
  const PAGE_SIZE = 5;
  const VERSION = "8"; // single-page consolidated build

  /* ---------- per-list state ---------- */
  const lists = {
    pd: { page: 1, total: 0, busy: false },                 // dashboard: pending withdrawals
    wd: { page: 1, filter: "all", total: 0, busy: false },  // withdrawals: full list
    us: { page: 1, query: "", total: 0, busy: false }       // users
  };
  const LIST_IDS = { pd: "pdList", wd: "wdList", us: "userList" };
  const PAGER_IDS = {
    pd: ["pdPagerTop", "pdPagerBottom"],
    wd: ["wdPagerTop", "wdPagerBottom"],
    us: ["userPagerTop", "userPagerBottom"]
  };
  const REFRESH_IDS = { pd: "pdRefresh", wd: "wdRefresh", us: "userRefresh" };
  const PAGER_EMPTY = { pd: "Nothing here yet", wd: "Nothing here yet", us: "No users yet" };

  const busyTimers = {};
  const wdInFlight = {};
  const usInFlight = {};
  let MY_ID = null;
  let editingId = null;

  /* soft throttle: ignore clicks that arrive within 600ms of each other,
     so a control can never become permanently dead. */
  let lastClick = 0;
  function throttled() {
    const now = Date.now();
    if (now - lastClick < 600) return true;
    lastClick = now;
    return false;
  }

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    bindLogout();
    bindRefresh();
    bindFilters();
    bindSearch();
    bindModal();
    bindListToggle();
    bindDelegated();
    exposeVersion();
    boot();
  }

  function exposeVersion() {
    document.documentElement.setAttribute("data-admin-js", VERSION);
    ["pdRefresh", "wdRefresh", "userRefresh"].forEach(function (id) {
      const b = document.getElementById(id);
      if (b) b.title = "Refresh (admin.js v" + VERSION + ")";
    });
  }

  /* ---- one delegated listener drives tabs, pagers and row actions ----
     Delegation survives every re-render, so a button that gets replaced
     can never end up without a working click handler. */
  function bindDelegated() {
    document.addEventListener("click", function (e) {
      const t = e.target;
      if (!t || !t.closest) return;

      // top tabs
      const nav = t.closest(".admin-nav-item");
      if (nav && nav.dataset && nav.dataset.tab) { setTab(nav.dataset.tab); return; }

      // pagers — route by which list the pager belongs to
      const step = t.closest("[data-dir],[data-page]");
      if (step) {
        const box = step.closest(".admin-pager");
        if (!box) return;
        if (box.id.indexOf("userPager") === 0) pageControl("us", step);
        else if (box.id.indexOf("pdPager") === 0) pageControl("pd", step);
        else if (box.id.indexOf("wdPager") === 0) pageControl("wd", step);
        return;
      }

      // withdrawal approve / reject
      const rowBtn = t.closest("[data-action]");
      if (rowBtn) { review(rowBtn); return; }

      // user row actions
      const uBtn = t.closest("[data-act]");
      if (uBtn) { act(uBtn); }
    });
  }

  /* ---- tabs ---- */
  function setTab(name) {
    if (name !== "dashboard" && name !== "withdrawals" && name !== "users") name = "dashboard";
    document.querySelectorAll(".admin-nav-item").forEach(function (el) {
      el.classList.toggle("active", el.dataset.tab === name);
    });
    [["dashboard", "tabDashboard"], ["withdrawals", "tabWithdrawals"], ["users", "tabUsers"]].forEach(function (pair) {
      const sec = document.getElementById(pair[1]);
      if (sec) sec.hidden = (pair[0] !== name);
    });
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, "", "#" + name);
    }
    if (name === "dashboard") loadPending(false);
    else if (name === "withdrawals") loadList(lists.wd.filter, false);
    else loadUsers(false);
  }

  function initialTab() {
    const h = (window.location.hash || "").replace("#", "");
    return (h === "withdrawals" || h === "users") ? h : "dashboard";
  }

  /* ---- boot flow: session -> role -> first tab ---- */
  function boot() {
    window.supabase.auth.getSession().then(function (resp) {
      if (resp.error || !resp.data.session) {
        window.location.href = "../login.html";
        return;
      }
      MY_ID = resp.data.session.user.id;
      window.supabase.rpc("get_my_role").then(function (roleResp) {
        if (roleResp.error || roleResp.data !== "admin") { renderDenied(); return; }
        showMain();
        setTab(initialTab());
      });
    });
  }

  function renderDenied() {
    hideLoader();
    const main = document.getElementById("adminMain");
    const denied = document.getElementById("adminDenied");
    const who = document.getElementById("adminWho");
    if (main) main.hidden = true;
    if (denied) denied.hidden = false;
    if (who) who.textContent = "Restricted";
  }

  function showMain() {
    hideLoader();
    const main = document.getElementById("adminMain");
    const denied = document.getElementById("adminDenied");
    if (main) main.hidden = false;
    if (denied) denied.hidden = true;
  }

  function hideLoader() {
    const loader = document.getElementById("appLoader");
    if (loader) loader.classList.add("hide");
  }

  function bindLogout() {
    const btn = document.getElementById("adminLogout");
    if (!btn) return;
    btn.addEventListener("click", function () {
      window.supabase.auth.signOut().then(function () {
        window.location.href = "../login.html";
      });
    });
  }

  /* ---- shared helpers ---- */
  /* 3 decimals minimum, so a $0.001 referral commission is visible here too. */
  function fmt(n) {
    const v = Number(n || 0);
    return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 4 });
  }

  function escapeHtml(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function initials(name) {
    return String(name || "?").trim().split(/\s+/).map(function (w) { return w[0] || ""; }).join("").slice(0, 2).toUpperCase();
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function networkLabel() {
    return "Binance \u2014 USDT (BEP20)";
  }

  function statusBadge(status0) {
    const s = String(status0 || "pending").toLowerCase();
    const cls = s === "approved" ? "ok" : (s === "rejected" ? "rejected" : "pending");
    const label = s === "approved" ? "Approved" : (s === "rejected" ? "Rejected" : "Pending");
    return '<span class="txn-status ' + cls + '">' + label + "</span>";
  }

  function setNotice(msg) {
    const el = document.getElementById("adminNotice");
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ""; return; }
    el.hidden = false;
    el.textContent = msg;
  }

  function setUserNotice(msg) {
    const el = document.getElementById("userNotice");
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ""; return; }
    el.hidden = false;
    el.textContent = msg;
  }

  function showToast(message) {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.className = "toast show";
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () { toast.className = "toast"; }, 3000);
  }

  /* ---- busy + pager machinery (shared by all three lists) ----
     Busy is a VISUAL state only: it never touches the `disabled`
     attribute, so a control can never latch off and become dead. */
  function pagerEls(which) {
    return PAGER_IDS[which].map(function (id) { return document.getElementById(id); }).filter(Boolean);
  }

  function setBusy(which, on, listEl) {
    const s = lists[which];
    s.busy = !!on;
    if (busyTimers[which]) { clearTimeout(busyTimers[which]); busyTimers[which] = null; }
    if (on) busyTimers[which] = setTimeout(function () { setBusy(which, false, listEl); }, 8000);
    pagerEls(which).forEach(function (b) { b.classList.toggle("busy", s.busy); });
    if (listEl) listEl.classList.toggle("busy", s.busy);
    const rb = document.getElementById(REFRESH_IDS[which]);
    if (rb) {
      rb.classList.toggle("busy", s.busy);
      rb.setAttribute("aria-busy", s.busy ? "true" : "false");
    }
  }

  /* Page numbers with a sliding window: 1 … 4 5 6 … 12 */
  function pageWindow(current, totalPages) {
    const out = [];
    const push = function (n) { if (out[out.length - 1] !== n) out.push(n); };
    push(1);
    const start = Math.max(2, current - 1);
    const end = Math.min(totalPages - 1, current + 1);
    if (start > 2) out.push("…");
    for (let n = start; n <= end; n++) push(n);
    if (end < totalPages - 1) out.push("…");
    if (totalPages > 1) push(totalPages);
    return out;
  }

  /* Draws the numbered pager (top + bottom) and "Showing x–y of z". */
  function drawPager(which) {
    const boxes = pagerEls(which);
    if (!boxes.length) return;
    const s = lists[which];
    const total = Number(s.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (s.page > totalPages) s.page = totalPages;
    if (s.page < 1) s.page = 1;

    const from = total === 0 ? 0 : (s.page - 1) * PAGE_SIZE + 1;
    const to = Math.min(s.page * PAGE_SIZE, total);
    const canPrev = s.page > 1;
    const canNext = s.page < totalPages;

    const navBtn = function (dir, label, enabled) {
      return '<button class="btn btn-white btn-sm admin-pagebtn" type="button" data-dir="' + dir + '"' +
        (enabled ? "" : ' data-boundary="1" disabled') + ">" + label + "</button>";
    };

    const nums = pageWindow(s.page, totalPages).map(function (n) {
      if (n === "…") return '<span class="admin-pagegap">…</span>';
      if (n === s.page) {
        return '<button class="btn btn-white btn-sm admin-pagebtn is-current" type="button" data-page="' +
          n + '" aria-current="page" title="You are on this page">' + n + "</button>";
      }
      return '<button class="btn btn-white btn-sm admin-pagebtn" type="button" data-page="' + n + '">Go to page ' + n + "</button>";
    }).join("");

    const info = total === 0
      ? PAGER_EMPTY[which]
      : "Page " + s.page + " of " + totalPages + " · Showing " + from + "–" + to + " of " + total;

    const html =
      navBtn("prev", "‹ Prev", canPrev) +
      '<div class="admin-pagenums">' + nums + "</div>" +
      navBtn("next", "Next ›", canNext) +
      '<span class="admin-pager-info">' + info + "</span>";

    boxes.forEach(function (box) {
      box.innerHTML = html;
      box.hidden = false;
      box.classList.toggle("busy", s.busy);
      // Belt and braces: the document-level delegated listener handles these
      // too, but a direct listener guarantees the click is caught. throttled()
      // makes a double delivery harmless.
      box.querySelectorAll("[data-dir],[data-page]").forEach(function (btn) {
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          pageControl(which, btn);
        });
      });
    });
  }

  /* The page number is applied to the UI IMMEDIATELY, before the fetch
     starts, so a click always shows an immediate result. */
  function pageControl(which, el) {
    if (throttled()) return;
    const box = el.closest(".admin-pager");
    const s = lists[which];
    const target = el.dataset.dir
      ? s.page + (el.dataset.dir === "next" ? 1 : -1)
      : Number(el.dataset.page);

    if (!target || target < 1 || target === s.page) return;
    s.page = target;
    window.__adminClicks = (window.__adminClicks || 0) + 1;
    drawPager(which);              // instant feedback, no waiting on the network
    reloadFor(which)();
    if (box && PAGER_IDS[which].indexOf(box.id) === 1) {
      // Instant, not smooth: a moving target under the cursor swallows the
      // next click, which is what made the bottom pager feel "dead".
      const list = document.getElementById(LIST_IDS[which]);
      if (list && list.scrollIntoView) list.scrollIntoView({ block: "start" });
    }
  }

  function reloadFor(which) {
    if (which === "pd") return reloadPending;
    if (which === "wd") return reloadWd;
    return reloadUsers;
  }

  function reloadPending() { loadPending(false); }
  function reloadWd() { loadList(lists.wd.filter, false); }
  function reloadUsers() { loadUsers(false); }

  /* ================= Dashboard tab: pending withdrawals ================= */
  function loadPending(force) {
    const box = document.getElementById("pdList");
    if (!box) return;

    const key = "pd_p" + lists.pd.page;

    if (!force) {
      const cached = window.AdminStore.read(key);
      if (cached && cached.rows) { paintPending(cached); return; }
    }

    setBusy("pd", true);
    box.innerHTML = '<p class="empty-note">Loading…</p>';

    window.supabase.rpc("get_all_pending_withdrawals", { p_limit: PAGE_SIZE, p_offset: (lists.pd.page - 1) * PAGE_SIZE }).then(function (resp) {
      if (resp.error) {
        // DB not updated yet -> older function returns a plain array; use it so the page still works.
        window.supabase.rpc("get_all_pending_withdrawals").then(function (old) {
          if (old.error) {
            setBusy("pd", false);
            box.innerHTML = '<p class="empty-note">Could not load: ' + escapeHtml(String(old.error.message || old.error)) + "</p>";
            return;
          }
          const rows = old.data || [];
          const payload = {
            total: rows.length,
            gross: rows.reduce(function (a, r) { return a + (r.gross || 0); }, 0),
            net: rows.reduce(function (a, r) { return a + (r.net || 0); }, 0),
            rows: rows
          };
          window.AdminStore.write(key, payload);
          paintPending(payload);
        });
        return;
      }

      const d = resp.data || {};
      const payload = { total: d.total || 0, gross: d.gross || 0, net: d.net || 0, rows: d.rows || [] };
      window.AdminStore.write(key, payload);
      paintPending(payload);
    });
  }

  function paintPending(payload) {
    const box = document.getElementById("pdList");
    if (!box) return;
    setBusy("pd", false);
    // Always start from an empty list: a cached page is painted without the
    // "Loading…" reset, so appending here would duplicate the rows.
    box.innerHTML = "";
    lists.pd.total = Number(payload.total || 0);
    setText("stCount", String(lists.pd.total));
    setText("stGross", fmt(payload.gross));
    setText("stNet", fmt(payload.net));
    drawPager("pd");

    const rows = payload.rows || [];
    if (!rows.length) {
      box.insertAdjacentHTML("beforeend", '<p class="empty-note">No pending withdrawals for this page. All caught up!</p>');
      return;
    }
    box.insertAdjacentHTML("beforeend", rows.map(function (r) {
      return '<div class="wd-admin-row">' + wdInfo(r) + wdActions(r) + "</div>";
    }).join(""));
  }

  /* ================= Withdrawals tab: full list ================= */
  function bindFilters() {
    const wrap = document.getElementById("adminFilters");
    if (!wrap) return;
    wrap.querySelectorAll(".admin-chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        wrap.querySelectorAll(".admin-chip").forEach(function (c) { c.classList.remove("active"); });
        chip.classList.add("active");
        lists.wd.filter = chip.dataset.filter || "all";
        lists.wd.page = 1;
        loadList(lists.wd.filter, false);
      });
    });
  }

  function loadList(filter, force) {
    const box = document.getElementById("wdList");
    if (!box) return;

    const key = "wd_" + filter + "_p" + lists.wd.page;

    if (!force) {
      const cached = window.AdminStore.read(key);
      if (cached && cached.rows) { paintList(cached, filter); return; }
    }

    setBusy("wd", true);
    box.innerHTML = '<p class="empty-note">Loading…</p>';

    window.supabase.rpc("get_all_withdrawals", { p_status: filter, p_limit: PAGE_SIZE, p_offset: (lists.wd.page - 1) * PAGE_SIZE }).then(function (resp) {
      if (resp.error) {
        // Older DB -> get_all_withdrawals missing; fall back to the pending list.
        fallbackToPending(filter);
        return;
      }
      const d = resp.data || {};
      const payload = { total: d.total || 0, rows: d.rows || [] };
      window.AdminStore.write(key, payload);
      paintList(payload, filter);
    });
  }

  function fallbackToPending(filter) {
    const box = document.getElementById("wdList");
    if (!box) return;
    setBusy("wd", false);
    if (filter !== "all" && filter !== "pending") {
      setNotice("This filter needs the updated get_all_withdrawals() - re-run db/setup_admin.sql.");
      box.innerHTML = "";
      lists.wd.total = 0;
      drawPager("wd");
      return;
    }

    setNotice("Showing pending only. Full list needs the updated get_all_withdrawals() - re-run db/setup_admin.sql.");

    const key = "wd_" + filter + "_p" + lists.wd.page;
    window.supabase.rpc("get_all_pending_withdrawals", { p_limit: PAGE_SIZE, p_offset: (lists.wd.page - 1) * PAGE_SIZE }).then(function (resp) {
      if (resp.error) {
        box.innerHTML = '<p class="empty-note">Could not load: ' + escapeHtml(String(resp.error.message || resp.error)) + "</p>";
        return;
      }
      const d = resp.data || {};
      const rows = (d.rows || []).map(function (r) { r.status = r.status || "pending"; return r; });
      const payload = { total: d.total || 0, rows: rows };
      window.AdminStore.write(key, payload);
      paintList(payload, filter);
    });
  }

  function paintList(payload, filter) {
    const box = document.getElementById("wdList");
    if (!box) return;
    setNotice("");
    setBusy("wd", false);
    box.innerHTML = "";
    lists.wd.total = Number(payload.total || 0);
    drawPager("wd");

    const rows = payload.rows || [];
    if (!rows.length) {
      box.insertAdjacentHTML("beforeend", '<p class="empty-note">Nothing here yet.</p>');
      return;
    }

    box.insertAdjacentHTML("beforeend", rows.map(function (r) {
      const pending = String(r.status || "").toLowerCase() === "pending";
      return '<div class="wd-admin-row">' + wdInfo(r) + statusBadge(r.status) + (pending ? wdActions(r) : "") + "</div>";
    }).join(""));
  }

  /* Shared withdrawal row pieces (used by both dashboard + withdrawals). */
  function wdInfo(r) {
    return '<div class="wd-admin-info">' +
      "<strong>" + escapeHtml(r.email) + "</strong>" +
      "<span>" + escapeHtml(r.holder) + " · " + escapeHtml(r.account) + " · " + escapeHtml(networkLabel()) + " · " + escapeHtml(new Date(r.created).toLocaleString()) + "</span>" +
      '<span class="wd-admin-break">Gross <b>' + fmt(r.gross) + "</b> − Fee <b>" + fmt(r.fee) +
        "</b> → Net <b>" + fmt(r.net) + "</b></span>" +
      "</div>";
  }

  function wdActions(r) {
    return '<div class="wd-admin-actions">' +
      '<button class="btn btn-green btn-sm" data-action="approve" data-id="' + r.wd_id + '">Approve</button>' +
      '<button class="btn btn-danger btn-sm" data-action="reject" data-id="' + r.wd_id + '">Reject</button>' +
      "</div>";
  }

  /* ================= approve / reject ================= */
  function review(btn) {
    const accept = btn.dataset.action === "approve";
    const id = Number(btn.dataset.id);

    if (wdInFlight[id]) return;

    if (!accept && !window.confirm("Reject #" + id + "? The full deducted amount will be refunded to the user's wallet.")) {
      return;
    }

    // Which list is this row in? Reload only that one (force = bypass cache).
    const inPending = !!btn.closest("#pdList");
    const which = inPending ? "pd" : "wd";
    const forceReload = inPending
      ? function () { loadPending(true); }
      : function () { loadList(lists.wd.filter, true); };

    const old = btn.textContent;
    wdInFlight[id] = true;
    setBusy(which, true);
    btn.textContent = (accept ? "Approve" : "Reject") + "...";
    btn.classList.add("busy");

    const settle = function () {
      delete wdInFlight[id];
      if (btn.isConnected) {
        btn.textContent = old;
        btn.classList.remove("busy");
      }
      setBusy(which, false);
    };

    window.supabase.rpc("review_withdrawal", { p_wd_id: id, p_accept: accept }).then(function (resp) {
      if (resp.error) {
        showToast(window.apiMessage(resp.error) || "Action failed.");
        settle();
        return;
      }
      if (accept) {
        showToast("Withdrawal #" + id + " approved. Send payment to the user manually.");
      } else {
        showToast("Withdrawal #" + id + " rejected — " + fmt(resp.data && resp.data.refunded) + " refunded.");
      }
      forceReload();
      settle();
    }, function () {
      showToast("Network error — nothing was changed. Please try again.");
      settle();
    });
  }

  /* ================= Users tab ================= */
  function bindSearch() {
    const input = document.getElementById("userSearch");
    if (!input) return;
    let t = null;
    input.addEventListener("input", function () {
      clearTimeout(t);
      t = setTimeout(function () {
        lists.us.query = input.value.trim();
        lists.us.page = 1;
        loadUsers(false);
      }, 350);
    });
  }

  /* The page shows ONLY the total user count by default. The per-user list
     (with everyone's details) stays hidden until this button is pressed. */
  function bindListToggle() {
    const btn = document.getElementById("userListToggle");
    const detail = document.getElementById("userDetail");
    if (!btn || !detail) return;
    btn.addEventListener("click", function () {
      const show = detail.hidden;
      detail.hidden = !show;
      btn.textContent = show ? "Hide user list" : "Show user list";
      btn.setAttribute("aria-expanded", show ? "true" : "false");
    });
  }

  function cacheKey(pg) {
    return "users_" + (lists.us.query ? "q" + lists.us.query.replace(/[^a-z0-9]/gi, "_") : "all") + "_p" + pg;
  }

  function loadUsers(force) {
    const box = document.getElementById("userList");
    if (!box) return;

    const key = cacheKey(lists.us.page);

    if (!force) {
      const cached = window.AdminStore.read(key);
      if (cached && cached.users) { paint(cached); return; }
    }

    setBusy("us", true, box);
    box.innerHTML = "";

    window.supabase.rpc("admin_search_users", {
      p_query: lists.us.query || "",
      p_limit: PAGE_SIZE,
      p_offset: (lists.us.page - 1) * PAGE_SIZE
    }).then(function (resp) {
      if (resp.error) {
        setBusy("us", false, box);
        setUserNotice("Could not load users: " + escapeHtml(String(resp.error.message || resp.error)));
        lists.us.total = 0;
        drawPager("us");
        return;
      }
      setUserNotice("");
      const d = resp.data || {};
      const payload = { total: d.total || 0, users: d.users || [] };
      window.AdminStore.write(key, payload);
      paint(payload);
    });
  }

  function paint(payload) {
    const box = document.getElementById("userList");
    if (!box) return;
    setBusy("us", false, box);
    // A cached page is painted without the list reset that loadUsers() does,
    // so the list must be emptied here or the rows would duplicate.
    box.innerHTML = "";
    const total = Number(payload.total || 0);
    lists.us.total = total;
    setText("stUsers", String(total));
    setText("stTotalUsers", total.toLocaleString("en-US"));
    drawPager("us");

    const rows = payload.users || [];
    if (!rows.length) {
      box.insertAdjacentHTML("beforeend", lists.us.query
        ? '<p class="empty-note">No users match "' + escapeHtml(lists.us.query) + '".</p>'
        : '<p class="empty-note">No users yet.</p>');
      return;
    }
    box.insertAdjacentHTML("beforeend", rows.map(userRow).join(""));
  }

  function userRow(u) {
    const isSelf = u.id === MY_ID;
    const banned = !!u.banned;
    const date = u.created ? new Date(u.created).toLocaleDateString() : "";
    const colors = ["#1C66D6", "#7B61D8", "#0AA84F", "#E86B3D", "#0E2E5C"];
    const avIdx = Math.abs(String(u.id || "a").charCodeAt(0)) % colors.length;

    return (
      '<div class="user-row' + (banned ? " banned" : "") + '">' +
      '<span class="user-avatar" style="background:' + colors[avIdx] + '">' + escapeHtml(initials(u.name)) + "</span>" +
      '<div class="user-info">' +
      "<strong>" + escapeHtml(u.name) + (isSelf ? " <em>(you)</em>" : "") + "</strong>" +
      "<span>" + escapeHtml(u.email) + " · " + escapeHtml(String(u.ref_code || "")) + "</span>" +
      '<span class="user-meta">Bal <b>' + fmt(u.balance) + "</b> · Earned <b>" + fmt((u.spin_total || 0) + (u.referral_total || 0)) +
        "</b> · Withdrawn <b>" + fmt(u.withdrawn_total) + "</b> · Pending <b>" + fmt(u.pending) +
        "</b> · Referred <b>" + (u.referred || 0) + "</b> · Limit <b>" + (u.spin_limit || 0) +
        "/day</b> · Joined " + escapeHtml(date) + "</span>" +
      (u.ip || u.fp ? '<span class="user-meta devmeta">' +
        (u.ip ? 'IP <b>' + escapeHtml(u.ip) + "</b>" : "") +
        (u.fp ? " · FP <b title=\"" + escapeHtml(u.fp) + "\">" + escapeHtml(String(u.fp).slice(0, 14)) + (String(u.fp).length > 14 ? "…" : "") + "</b>" : "") +
        "</span>" : "") +
      "</div>" +
      (banned ? '<span class="user-status banned">Banned</span>' : '<span class="user-status active">Active</span>') +
      '<div class="wd-admin-actions">' +
      '<button class="btn btn-white btn-sm" data-act="edit" data-id="' + u.id + '" ' +
        (isSelf ? 'data-locked="1" disabled title="You cannot edit yourself"' : "") + '>Edit</button>' +
      '<button class="btn ' + (banned ? "btn-green" : "btn-danger") + ' btn-sm" data-act="' + (banned ? "unban" : "ban") + '" data-id="' + u.id + '" ' +
        (isSelf ? 'data-locked="1" disabled title="You cannot ban yourself"' : "") + '>' + (banned ? "Unban" : "Ban") + "</button>" +
      '<button class="btn btn-danger btn-sm" data-act="delete" data-id="' + u.id + '" ' +
        (isSelf ? 'data-locked="1" disabled title="You cannot delete yourself"' : "") + '>Delete</button>' +
      "</div>" +
      "</div>"
    );
  }

  function act(btn) {
    if (usInFlight[btn.dataset.id]) return;
    if (throttled()) return;
    const action = btn.dataset.act;
    const id = btn.dataset.id;

    if (action === "edit") openEdit(id);
    else if (action === "ban") confirmBan(id, true);
    else if (action === "unban") confirmBan(id, false);
    else if (action === "delete") confirmDelete(id);
  }

  function redrawUsers() {
    loadUsers(false); // re-render current page from the (already patched) cache - no backend call
  }

  function userListEl() { return document.getElementById("userList"); }

  function confirmBan(id, on) {
    if (!window.confirm((on ? "Ban " : "Unban ") + "user " + id + "? " + (on
      ? "They will not be able to sign in anymore. You can unban anytime."
      : "They will be able to sign in again."))) return;

    setBusy("us", true, userListEl());
    usInFlight[id] = true;
    window.supabase.rpc("admin_ban_user", { p_id: id, p_ban: on }).then(function (resp) {
      delete usInFlight[id];
      setBusy("us", false, userListEl());
      if (resp.error) {
        showToast(window.apiMessage(resp.error) || "Failed.");
        return;
      }
      window.AdminStore.patchRows("id", id, function (row) {
        row.banned = on;
        return row;
      });
      showToast(on ? "User banned." : "User unbanned.");
      redrawUsers();
    }, function () {
      delete usInFlight[id];
      setBusy("us", false, userListEl());
      showToast("Network error — nothing was changed. Please try again.");
    });
  }

  function confirmDelete(id) {
    if (!window.confirm("PERMANENTLY DELETE user " + id + "?\n\nThis deletes their account AND all their data (profile, balance, spin history, withdrawals, sessions). This CANNOT be undone.")) return;
    if (!window.confirm("Are you 100% sure? This is final.")) return;

    setBusy("us", true, userListEl());
    usInFlight[id] = true;
    window.supabase.rpc("admin_delete_user", { p_id: id }).then(function (resp) {
      delete usInFlight[id];
      setBusy("us", false, userListEl());
      if (resp.error) {
        showToast(window.apiMessage(resp.error) || "Failed.");
        return;
      }
      window.AdminStore.patchRows("id", id, function () { return null; }); // row removed + total adjusted
      showToast("User deleted. All data removed.");
      redrawUsers();
    }, function () {
      delete usInFlight[id];
      setBusy("us", false, userListEl());
      showToast("Network error — nothing was deleted. Please try again.");
    });
  }

  /* ---- edit modal ---- */
  function openEdit(id) {
    const nameInput = document.getElementById("uName");
    const spinInput = document.getElementById("uSpin");
    const msg = document.getElementById("uModalMsg");
    const modal = document.getElementById("userModal");
    if (!modal || !nameInput) return;

    nameInput.value = "";
    if (spinInput) spinInput.value = "";
    if (msg) { msg.hidden = true; msg.textContent = ""; }

    setBusy("us", true, userListEl());
    usInFlight[id] = true;
    window.supabase.rpc("admin_search_users", { p_query: id, p_limit: 1, p_offset: 0 }).then(function (resp) {
      delete usInFlight[id];
      setBusy("us", false, userListEl());
      if (resp.error) {
        // Never open an empty modal: saving it could rename the user by accident.
        showToast(window.apiMessage(resp.error) || "Could not load this user.");
        return;
      }
      const u = resp.data && resp.data.users && resp.data.users[0];
      if (!u) {
        showToast("User not found.");
        return;
      }
      editingId = id;
      nameInput.value = u.name || "";
      if (spinInput) spinInput.value = u.spin_limit || 3;
      modal.hidden = false;
      nameInput.focus();
    }, function () {
      delete usInFlight[id];
      setBusy("us", false, userListEl());
      showToast("Network error — nothing was changed. Please try again.");
    });
  }

  function bindModal() {
    const modal = document.getElementById("userModal");
    if (!modal) return;

    document.getElementById("uCancel").addEventListener("click", function () {
      modal.hidden = true;
      editingId = null;
    });

    modal.addEventListener("click", function (e) {
      if (e.target === modal) { modal.hidden = true; editingId = null; }
    });

    document.getElementById("uSave").addEventListener("click", function () {
      if (!editingId) return;
      const name = document.getElementById("uName").value.trim();
      const spin = parseInt(document.getElementById("uSpin").value, 10);
      const msg = document.getElementById("uModalMsg");

      if (name.length < 2) {
        if (msg) { msg.hidden = false; msg.textContent = "Name must be at least 2 characters."; }
        return;
      }
      if (!spin || spin < 1 || spin > 20) {
        if (msg) { msg.hidden = false; msg.textContent = "Spin limit must be between 1 and 20."; }
        return;
      }

      setBusy("us", true, userListEl());
      const savingId = editingId;
      usInFlight[savingId] = true;
      window.supabase.rpc("admin_update_user", { p_id: editingId, p_name: name, p_spin_limit: spin }).then(function (resp) {
        delete usInFlight[savingId];
        setBusy("us", false, userListEl());
        if (resp.error) {
          showToast(window.apiMessage(resp.error) || "Save failed.");
          return;
        }
        modal.hidden = true;
        // update ONLY this row in every cached page - nothing else is touched
        window.AdminStore.patchRows("id", editingId, function (row) {
          row.name = name;
          row.spin_limit = spin;
          return row;
        });
        showToast("User updated.");
        editingId = null;
        redrawUsers();
      }, function () {
        delete usInFlight[savingId];
        setBusy("us", false, userListEl());
        showToast("Network error — nothing was saved. Please try again.");
      });
    });
  }

  /* ---- refresh buttons (one per tab) ---- */
  function bindRefresh() {
    const pdBtn = document.getElementById("pdRefresh");
    if (pdBtn) {
      pdBtn.addEventListener("click", function () {
        if (throttled()) return;
        lists.pd.page = 1;
        setBusy("pd", true);
        loadPending(true);
      });
    }
    const wdBtn = document.getElementById("wdRefresh");
    if (wdBtn) {
      wdBtn.addEventListener("click", function () {
        if (throttled()) return;
        lists.wd.page = 1;
        setBusy("wd", true);
        loadList(lists.wd.filter, true);
      });
    }
    const uBtn = document.getElementById("userRefresh");
    if (uBtn) {
      uBtn.addEventListener("click", function () {
        if (throttled()) return;
        lists.us.page = 1;
        setBusy("us", true, userListEl());
        loadUsers(true);
      });
    }
  }
})();
