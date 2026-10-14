/* =========================================================
   Daily Spin — admin shared data cache (localStorage + TTL).
   Every page of every admin list is stored under its own key,
   so revisiting a page is INSTANT (no backend call), and the
   backend only ever gets asked for the 5 rows actually shown.
   ========================================================= */

"use strict";

window.AdminStore = (function () {
  const PREFIX = "adspin_";
  const DEFAULT_TTL = null; // never expires - data stays until the browser tab is cleared manually

  function read(key, ttl) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (!raw) return null;
      const item = JSON.parse(raw);
      if (ttl && Date.now() - item.t > ttl) return null;
      return item.v;
    } catch (e) { return null; }
  }

  function write(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify({ t: Date.now(), v: value }));
    } catch (e) { /* quota — ignore, next fetch will reuse memory */ }
  }

  function drop(key) {
    try { localStorage.removeItem(PREFIX + key); } catch (e) {}
  }

  /* In-place update: walk EVERY cached page and apply `mutator` to every row
     whose `idKey` equals `idValue`. If mutator returns null the row is
     removed (and the page's total is decremented). Everything else is
     untouched - no backend call, no page is re-fetched. */
  function patchRows(idKey, idValue, mutator) {
    try {
      Object.keys(localStorage).forEach(function (k) {
        if (k.indexOf(PREFIX) !== 0) return;
        let item;
        try { item = JSON.parse(localStorage.getItem(k)); } catch (e) { return; }
        const v = item.v;
        if (!v) return;

        let changed = false;
        ["users", "rows"].forEach(function (listKey) {
          const arr = v[listKey];
          if (!Array.isArray(arr)) return;
          const out = [];
          let removed = 0;
          arr.forEach(function (row) {
            if (String(row[idKey]) === String(idValue)) {
              changed = true;
              const next = mutator(row);
              if (next) { out.push(next); } else { removed++; }
              return;
            }
            out.push(row);
          });
          v[listKey] = out;
          if (removed && typeof v.total === "number") {
            v.total = Math.max(0, v.total - removed);
          }
        });

        if (changed) {
          try { localStorage.setItem(k, JSON.stringify(item)); } catch (e) {}
        }
      });
    } catch (e) {}
  }

  return { read: read, write: write, drop: drop, patchRows: patchRows, PREFIX: PREFIX };
})();