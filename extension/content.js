// Pawchive Creator Downloader - page script
// Adds a "Download all" button to creator pages. It reads the creator's posts from
// Pawchive's own data feed, one page of 50 at a time, lets you filter them, then saves
// the chosen files post by post.

(() => {
  'use strict';

  const api = globalThis.browser ?? globalThis.chrome;

  // /<service>/user/<creator>   (the creator's main post list only)
  const PROFILE_PATH = /^\/([^/]+)\/user\/([^/]+)\/?$/;
  const PAGE_SIZE = 50;
  const PAGE_DELAY_MS = 1000; // pause between post-list pages
  const FILE_DELAY_MS = 500;  // pause between files, so the site isn't hammered
  const PARALLEL = 3;         // files downloading at the same time

  // Pawchive switches pages without reloading, so the creator is always read from the
  // current address, never remembered from when the page first loaded.
  function currentCreator() {
    const m = location.pathname.match(PROFILE_PATH);
    if (!m) return null;
    const service = decodeURIComponent(m[1]);
    const creatorId = decodeURIComponent(m[2]);
    return {
      service,
      creatorId,
      apiBase: `/api/v1/${encodeURIComponent(service)}/user/${encodeURIComponent(creatorId)}`,
      doneKey: `done:${service}:${creatorId}`,
    };
  }

  // ---------- helpers ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function getJson(url) {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(new URL(url, location.origin).href, {
        headers: { Accept: 'text/css' },
        credentials: 'same-origin',
      });
      if (res.ok) return res.json();
      if (attempt >= 3 || (res.status !== 429 && res.status < 500)) {
        throw new Error(`Pawchive answered ${res.status} for ${url}`);
      }
      await sleep(3000 * attempt); // rate-limited or server hiccup: back off and retry
    }
  }

  // Make text safe as a Windows/macOS/Linux file or folder name.
  const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
  function safe(text) {
    return String(text || '')
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function trimEnds(s) {
    return s.replace(/^[.\s]+|[.\s]+$/g, '');
  }
  function fitText(s, max) {
    return s.length > max ? trimEnds(s.slice(0, max)) : s;
  }
  function guardReserved(s) {
    return !s || RESERVED.test(s.split('.')[0]) ? `_${s}` : s;
  }

  // Folder for one post. The post id always survives, so two posts can never share a folder.
  function postFolder(date, title, id) {
    const tail = ` [${safe(id)}]`;
    const head = fitText(trimEnds(safe(`${date} - ${title || 'Untitled'}`)), 110 - tail.length);
    return guardReserved(head + tail);
  }

  // File name inside a post folder. The number prefix keeps same-named files apart,
  // and the extension is kept even when a long name has to be shortened.
  function fileName(n, original) {
    const prefix = `${String(n).padStart(2, '0')} - `;
    const name = trimEnds(safe(original)) || 'file';
    const m = /(\.[A-Za-z0-9]{1,8})$/.exec(name);
    const ext = m && m.index > 0 ? m[1] : '';
    const stem = name.slice(0, name.length - ext.length);
    const room = 140 - prefix.length - ext.length;
    const short = trimEnds(fitText(stem, room)) || 'file';
    return guardReserved(prefix + short + ext);
  }

  function extensionOf(name) {
    const m = /\.([a-z0-9]{1,8})$/i.exec(name || '');
    if (!m) return 'other';
    const e = m[1].toLowerCase();
    return e === 'jpeg' || e === 'jpe' ? 'jpg' : e;
  }

  function fileUrl(f) {
    const server = f.server || 'https://pawchive.pw';
    return `${server}/data${f.path}?f=${encodeURIComponent(f.name || '')}`;
  }

  // ---------- storage of finished files (lets you stop and resume) ----------

  async function loadDone(doneKey) {
    try {
      const got = await api.storage.local.get(doneKey);
      return new Set(got[doneKey] || []);
    } catch {
      return new Set();
    }
  }
  async function saveDone(doneKey, set) {
    try {
      await api.storage.local.set({ [doneKey]: [...set] });
    } catch { /* storage full or unavailable: resuming just re-downloads */ }
  }

  // ---------- panel UI ----------

  const host = document.createElement('div');
  host.id = 'pcd-host';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
              font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #e6e6e6; }
      .fab { background: #e8a17d; color: #1b1b1b; border: 0; border-radius: 999px; padding: 10px 16px;
             font-weight: 600; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.4); font: inherit; font-weight: 600; }
      .fab:hover { filter: brightness(1.08); }
      .panel { width: 380px; max-width: calc(100vw - 32px); max-height: calc(100vh - 32px); overflow-y: auto;
               box-sizing: border-box; background: #1e1e22; border: 1px solid #3a3a40;
               border-radius: 10px; padding: 14px; box-shadow: 0 8px 28px rgba(0,0,0,.5); }
      .title { font-weight: 700; margin-bottom: 6px; display: flex; justify-content: space-between; gap: 8px; }
      .close { background: none; border: 0; color: #aaa; cursor: pointer; font-size: 16px; line-height: 1; }
      .status { margin: 6px 0 10px; white-space: pre-line; }
      .bar { height: 8px; background: #33333a; border-radius: 4px; overflow: hidden; margin-bottom: 10px; }
      .bar > div { height: 100%; width: 0%; background: #e8a17d; transition: width .2s; }
      .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      button.act { background: #34343b; color: #eee; border: 1px solid #4a4a52; border-radius: 6px;
                   padding: 6px 12px; cursor: pointer; font: inherit; }
      button.act.primary { background: #e8a17d; color: #1b1b1b; border-color: #e8a17d; font-weight: 600; }
      button.act:disabled { opacity: .45; cursor: not-allowed; }
      button.act:hover:not(:disabled) { filter: brightness(1.12); }
      button.link { background: none; border: 0; color: #e8a17d; cursor: pointer; padding: 0; font: inherit; font-size: 12px; }
      .hidden { display: none !important; }
      .note { color: #9a9aa2; font-size: 12px; margin-top: 6px; }
      .filters { border-top: 1px solid #33333a; padding-top: 10px; margin-bottom: 10px; display: grid; gap: 12px; }
      .field > label, .field > .label { display: block; font-weight: 600; font-size: 13px; margin-bottom: 4px; }
      input[type=text], input[type=number], input[type=date] {
        background: #2a2a30; color: #eee; border: 1px solid #4a4a52; border-radius: 6px; padding: 5px 8px;
        font: inherit; font-size: 13px; box-sizing: border-box; color-scheme: dark; }
      input[type=text] { width: 100%; }
      input[type=number] { width: 80px; }
      input[type=date] { width: 140px; }
      .types { display: flex; flex-wrap: wrap; gap: 6px 12px; }
      .types label { font-size: 13px; display: flex; gap: 4px; align-items: center; cursor: pointer; }
      .hint { color: #9a9aa2; font-size: 12px; margin-top: 4px; white-space: pre-line; overflow-wrap: anywhere; }
      .summary { background: #2a2a30; border-radius: 6px; padding: 8px 10px; font-weight: 600; margin-bottom: 10px; }
    </style>
    <div class="wrap">
      <button class="fab">⬇ Download all</button>
      <div class="panel hidden">
        <div class="title"><span>Download posts</span><button class="close" title="Close">✕</button></div>
        <div class="status"></div>

        <div class="filters hidden">
          <div class="field">
            <label for="kw">Keywords in post title</label>
            <input id="kw" type="text" placeholder="e.g. animation, sketch   (empty = all posts)">
            <div class="hint">Separate keywords with commas. A post matches if its title contains any of them.</div>
          </div>
          <div class="field">
            <span class="label">File types</span>
            <div class="types"></div>
            <div class="row" style="margin-top:4px"><button class="link all-types">Select all</button><button class="link no-types">Select none</button></div>
          </div>
          <div class="field">
            <span class="label">Posts</span>
            <div class="row">from # <input id="from" type="number" min="1"> to # <input id="to" type="number" min="1"></div>
            <div class="hint range-hint"></div>
          </div>
          <div class="field">
            <span class="label">Published</span>
            <div class="row">from <input id="dfrom" type="date"> to <input id="dto" type="date"></div>
            <div class="hint date-hint"></div>
          </div>
        </div>

        <div class="summary hidden"></div>
        <div class="bar hidden"><div></div></div>
        <div class="row">
          <button class="act primary start hidden">Start</button>
          <button class="act pause hidden">Pause</button>
          <button class="act resume hidden">Resume</button>
          <button class="act retry hidden">Retry failed</button>
          <button class="act cancel hidden">Cancel</button>
        </div>
        <div class="note">Files are saved to Downloads/Pawchive/&lt;creator&gt;/&lt;date - post title&gt;/</div>
      </div>
    </div>`;
  // The script runs as soon as the page starts loading, so the button shows up right away
  // instead of waiting for the page's images and ads.
  const attach = () => (document.documentElement || document).appendChild(host);
  if (document.documentElement) attach();
  else document.addEventListener('readystatechange', attach, { once: true });

  // Pawchive's ad script listens for clicks on the whole page and opens pop-ups.
  // This script loads before the site's own scripts, so this listener runs first: a click
  // on the downloader panel is handled here and stopped, so the ads never see it.
  // Clicks anywhere else on the page are left alone. Checkboxes, text boxes and date
  // pickers still work normally, because stopping a click doesn't cancel what it does.
  const taps = new Map(); // panel element -> what clicking it does
  const onTap = (el, fn) => taps.set(el, fn);
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick',
    'auxclick', 'contextmenu', 'touchstart', 'touchend']) {
    window.addEventListener(type, (e) => {
      const path = e.composedPath();
      if (!path.includes(host)) return;
      e.stopImmediatePropagation();
      if (type !== 'click') return;
      for (const node of path) {
        if (node === host) break;
        const fn = taps.get(node);
        if (fn) { fn(e); break; }
      }
    }, true);
  }

  const $ = (sel) => root.querySelector(sel);
  const ui = {
    fab: $('.fab'), panel: $('.panel'), close: $('.close'), status: $('.status'),
    filters: $('.filters'), kw: $('#kw'), types: $('.types'), allTypes: $('.all-types'), noTypes: $('.no-types'),
    from: $('#from'), to: $('#to'), rangeHint: $('.range-hint'),
    dfrom: $('#dfrom'), dto: $('#dto'), dateHint: $('.date-hint'),
    summary: $('.summary'), bar: $('.bar'), fill: $('.bar > div'),
    start: $('.start'), pause: $('.pause'), resume: $('.resume'), retry: $('.retry'), cancel: $('.cancel'),
  };
  const show = (...els) => els.forEach((e) => e.classList.remove('hidden'));
  const hide = (...els) => els.forEach((e) => e.classList.add('hidden'));
  const buttons = () => [ui.start, ui.pause, ui.resume, ui.retry, ui.cancel];
  const setStatus = (text) => { ui.status.textContent = text; };
  const setProgress = (n, total) => {
    show(ui.bar);
    ui.fill.style.width = total ? `${Math.round((n / total) * 100)}%` : '0%';
  };

  // ---------- state ----------

  let scanning = false;
  let downloading = false;
  let paused = false;
  let cancelled = false;
  let scanId = 0;       // bumps whenever a scan should be abandoned
  let plan = null;      // { creator, who, posts: [{num,id,title,date,files:[...]}] } oldest first
  let doneSet = new Set();
  let failed = [];
  let failedKey = '';

  onTap(ui.fab, () => {
    hide(ui.fab);
    show(ui.panel);
    const who = currentCreator();
    // Rescan if nothing is loaded yet, or what's loaded belongs to a different creator.
    if (!scanning && !downloading && (!plan || !who || plan.who.doneKey !== who.doneKey)) scan();
  });
  onTap(ui.close, () => {
    hide(ui.panel);
    show(ui.fab);
  });
  onTap(ui.cancel, () => {
    if (downloading) {
      cancelled = true;
      paused = false;
      return;
    }
    scanId += 1; // abandons a scan in progress
    resetToIdle('Cancelled.');
  });
  onTap(ui.pause, () => { paused = true; hide(ui.pause); show(ui.resume); });
  onTap(ui.resume, () => { paused = false; hide(ui.resume); show(ui.pause); });
  onTap(ui.start, () => run(selectedFiles().files));
  onTap(ui.retry, () => run(failed.slice(), failedKey));

  for (const el of [ui.kw, ui.from, ui.to, ui.dfrom, ui.dto]) el.addEventListener('input', refresh);
  ui.types.addEventListener('change', refresh);
  onTap(ui.allTypes, () => { ui.types.querySelectorAll('input').forEach((c) => (c.checked = true)); refresh(); });
  onTap(ui.noTypes, () => { ui.types.querySelectorAll('input').forEach((c) => (c.checked = false)); refresh(); });

  function resetToIdle(message) {
    scanning = false;
    plan = null;
    failed = [];
    hide(...buttons(), ui.bar, ui.filters, ui.summary);
    setStatus(message);
  }

  // ---------- follow page changes ----------

  // Show the button only on a creator's page. While a download is running it stays
  // visible everywhere, so you can watch it, and it keeps saving the creator it started with.
  function updateVisibility() {
    const onCreator = !!currentCreator();
    root.querySelector('.wrap').classList.toggle('hidden', !onCreator && !downloading);
  }

  let lastPath = location.pathname;
  function onPageChange() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    if (!downloading) {
      scanId += 1; // drop any scan for the previous creator
      resetToIdle('');
      hide(ui.panel);
      show(ui.fab);
    }
    updateVisibility();
  }
  window.addEventListener('popstate', onPageChange);
  setInterval(onPageChange, 400);
  updateVisibility();

  // ---------- step 1: list every post and file ----------

  async function scan() {
    const who = currentCreator();
    if (!who) return;
    const { service, creatorId, apiBase } = who;
    const myScan = ++scanId;
    const stale = () => myScan !== scanId;

    scanning = true;
    plan = null;
    hide(...buttons(), ui.filters, ui.summary, ui.bar);
    show(ui.cancel);
    setStatus('Looking up the creator…');
    try {
      let creator = creatorId;
      try {
        const profile = await getJson(`${apiBase}/profile`);
        if (profile && profile.name) creator = profile.name;
      } catch { /* fall back to the id */ }
      if (stale()) return;

      const raw = [];
      for (let offset = 0; ; offset += PAGE_SIZE) {
        if (stale()) return;
        setStatus(`Reading the post list… ${raw.length} posts so far`);
        const page = await getJson(`${apiBase}/posts?o=${offset}`);
        if (stale()) return;
        if (!Array.isArray(page) || page.length === 0) break;
        raw.push(...page);
        if (page.length < PAGE_SIZE) break;
        await sleep(PAGE_DELAY_MS);
      }

      // Oldest first, so post #1 is the creator's first post.
      const seenPosts = new Set();
      const posts = raw
        .filter((p) => p && !seenPosts.has(p.id) && seenPosts.add(p.id))
        .map((p) => ({ p, date: String(p.published || p.added || '').slice(0, 10) }))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

      const creatorDir = fitText(trimEnds(safe(`${creator} (${service})`)), 80) || safe(creatorId);
      const next = { creator, who, posts: [] };
      posts.forEach(({ p, date }, i) => {
        const folder = postFolder(date || 'undated', p.title, p.id);
        const seen = new Set();
        const files = [];
        for (const f of [p.file, ...(p.attachments || [])]) {
          if (!f || !f.path || seen.has(f.path)) continue;
          seen.add(f.path);
          const original = f.name || f.path.split('/').pop();
          files.push({
            key: `${p.id}|${f.path}`,
            url: fileUrl(f),
            ext: extensionOf(original),
            filename: `Pawchive/${creatorDir}/${folder}/${fileName(files.length + 1, original)}`,
          });
        }
        next.posts.push({ num: i + 1, id: p.id, title: p.title || 'Untitled', date, files });
      });

      const done = await loadDone(who.doneKey);
      if (stale()) return;
      plan = next;
      doneSet = done;
      scanning = false;
      hide(...buttons());
      const total = plan.posts.reduce((n, p) => n + p.files.length, 0);
      setStatus(`${creator}\n${plan.posts.length} posts · ${total} files`);
      if (total === 0) return;
      buildFilters();
      show(ui.filters, ui.summary, ui.start, ui.cancel);
      refresh();
    } catch (err) {
      if (stale()) return;
      scanning = false;
      hide(...buttons());
      setStatus(`Couldn't read this creator's posts.\n${err.message}`);
    }
  }

  // ---------- filters ----------

  function buildFilters() {
    const counts = new Map();
    for (const p of plan.posts) for (const f of p.files) counts.set(f.ext, (counts.get(f.ext) || 0) + 1);
    ui.types.textContent = '';
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([ext, n]) => {
        const label = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = true;
        box.value = ext;
        label.append(box, ` ${ext} (${n})`);
        ui.types.append(label);
      });

    const last = plan.posts.length;
    ui.kw.value = '';
    ui.from.value = 1; ui.from.max = last;
    ui.to.value = last; ui.to.max = last;
    const dates = plan.posts.map((p) => p.date).filter(Boolean);
    ui.dfrom.value = ''; ui.dto.value = '';
    if (dates.length) {
      ui.dfrom.min = ui.dto.min = dates[0];
      ui.dfrom.max = ui.dto.max = dates[dates.length - 1];
      ui.dateHint.textContent = `Posts run from ${dates[0]} to ${dates[dates.length - 1]}. Leave empty for no limit.`;
    }
  }

  function describe(post) {
    if (!post) return '—';
    const t = post.title.length > 40 ? post.title.slice(0, 40) + '…' : post.title;
    return `#${post.num}  ${post.date || 'undated'}  ${t}`;
  }

  function selectedFiles() {
    if (!plan) return { posts: 0, files: [] };
    const last = plan.posts.length;
    const clamp = (v, d) => Math.min(Math.max(parseInt(v, 10) || d, 1), last);
    let from = clamp(ui.from.value, 1);
    let to = clamp(ui.to.value, last);
    if (from > to) [from, to] = [to, from];
    const words = ui.kw.value.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
    const types = new Set([...ui.types.querySelectorAll('input:checked')].map((c) => c.value));
    const dFrom = ui.dfrom.value || '';
    const dTo = ui.dto.value || '';

    let posts = 0;
    const files = [];
    for (const p of plan.posts) {
      if (p.num < from || p.num > to) continue;
      if (dFrom && (!p.date || p.date < dFrom)) continue;
      if (dTo && (!p.date || p.date > dTo)) continue;
      if (words.length && !words.some((w) => p.title.toLowerCase().includes(w))) continue;
      const picked = p.files.filter((f) => types.has(f.ext));
      if (!picked.length) continue;
      posts += 1;
      files.push(...picked);
    }
    return { posts, files, from, to };
  }

  function refresh() {
    if (!plan) return;
    const { posts, files, from, to } = selectedFiles();
    ui.rangeHint.textContent = `#1 is the oldest post.\nFrom: ${describe(plan.posts[from - 1])}\nTo:   ${describe(plan.posts[to - 1])}`;
    const already = files.filter((f) => doneSet.has(f.key)).length;
    const left = files.length - already;
    ui.summary.textContent =
      files.length === 0
        ? 'Nothing matches these filters.'
        : `Will download ${left} file${left === 1 ? '' : 's'} from ${posts} post${posts === 1 ? '' : 's'}` +
          (already ? ` (${already} already downloaded)` : '');
    ui.start.disabled = left === 0;
  }

  // ---------- step 2: download post by post ----------

  // Downloads belong to the creator they were picked from, even if you browse elsewhere meanwhile.
  async function run(items, doneKey = plan && plan.who.doneKey) {
    if (!doneKey || !items.length) return;
    const startedOn = location.pathname;
    downloading = true;
    cancelled = false;
    paused = false;
    failed = [];
    failedKey = doneKey;
    updateVisibility();
    hide(...buttons(), ui.filters, ui.summary);
    show(ui.pause, ui.cancel);

    doneSet = await loadDone(doneKey);
    const todo = items.filter((f) => !doneSet.has(f.key));
    let saved = 0;
    let finished = 0;
    let next = 0;
    let lastError = '';
    let lastLabel = '';

    const report = () => {
      setStatus(
        `Downloaded ${finished} of ${todo.length} (${PARALLEL} at a time)` +
          (lastLabel ? `\n${lastLabel}` : '') +
          (failed.length ? `\n${failed.length} failed` : '')
      );
      setProgress(finished, todo.length);
    };
    report();

    // A few workers share one list. Each takes the next file, saves it, pauses briefly, repeats.
    const worker = async (n) => {
      await sleep(n * 250); // stagger the start so requests don't all fire at once
      for (;;) {
        while (paused && !cancelled) await sleep(300);
        if (cancelled || next >= todo.length) return;
        const f = todo[next++];
        lastLabel = f.filename.split('/').slice(-2).join('/');
        report();

        let result;
        try {
          result = await api.runtime.sendMessage({ type: 'pcd-download', url: f.url, filename: f.filename });
        } catch (err) {
          result = { ok: false, error: String((err && err.message) || err) };
        }
        finished += 1;
        if (result && result.ok) {
          doneSet.add(f.key);
          saved += 1;
          if (saved % 10 === 0) saveDone(doneKey, doneSet);
        } else {
          failed.push(f);
          lastError = (result && result.error) || 'No answer from the extension';
        }
        report();
        await sleep(FILE_DELAY_MS);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, (_, n) => worker(n)));

    await saveDone(doneKey, doneSet);
    downloading = false;
    hide(...buttons());
    setProgress(todo.length, todo.length);

    const head = cancelled ? 'Stopped.' : 'Finished.';
    setStatus(
      `${head} ${saved} files saved` +
        (failed.length ? `, ${failed.length} failed.\nReason: ${lastError}` : '.') +
        '\nClose and reopen this panel to pick different posts or to continue.'
    );
    if (failed.length) show(ui.retry);
    plan = null; // reopening rescans, so new posts and the done list are picked up
    // If you browsed to a different page during the download, don't leave the old
    // creator's panel open there: go back to a fresh button for the page you're on.
    if (location.pathname !== startedOn) {
      resetToIdle('');
      hide(ui.panel);
      show(ui.fab);
    }
    updateVisibility();
  }
})();
