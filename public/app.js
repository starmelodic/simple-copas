// Simple Copas client — a small hash-free SPA driven by location.pathname.
// Routes: "/" (create), "/<id>" or "/p/<id>" (view).

const $ = (sel, root = document) => root.querySelector(sel);
const view = $("#view");
const toasts = $("#toasts");

const state = {
  config: { maxContentBytes: 512 * 1024 },
  draft: { content: "", title: "", language: "", expiresIn: "never", burnAfterRead: false },
  deleteTokens: loadTokens(),
  highlightRequests: new Map(),
};

// ---------------------------------------------------------------- helpers

function el(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toast(message, type = "success", ms = 2600) {
  const node = el(`<div class="toast ${type}"><span>${esc(message)}</span></div>`);
  toasts.appendChild(node);
  setTimeout(() => {
    node.style.transition = "opacity .2s";
    node.style.opacity = "0";
    setTimeout(() => node.remove(), 220);
  }, ms);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) },
    ...options,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) {
    const err = new Error((data && data.message) || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {}
    ta.remove();
    return ok;
  }
}

function timeAgo(ts) {
  const diff = Math.max(0, Date.now() - ts);
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KiB`;
}

function expiresInLabel(expiresAt) {
  if (!expiresAt) return null;
  const ms = expiresAt - Date.now();
  if (ms <= 0) return "expired";
  const h = ms / 3_600_000;
  if (h < 1) return `expires in ${Math.max(1, Math.round(ms / 60000))}m`;
  if (h < 48) return `expires in ${Math.round(h)}h`;
  return `expires in ${Math.round(h / 24)}d`;
}

// Delete tokens are kept only in this browser so the creator can remove their
// own pastes; they are never sent anywhere except a delete request.
function loadTokens() {
  try {
    return JSON.parse(localStorage.getItem("copas-delete-tokens") || "{}");
  } catch {
    return {};
  }
}

function saveToken(id, token) {
  state.deleteTokens[id] = token;
  try {
    localStorage.setItem("copas-delete-tokens", JSON.stringify(state.deleteTokens));
  } catch {}
}

export function dropToken(id) {
  delete state.deleteTokens[id];
  try {
    localStorage.setItem("copas-delete-tokens", JSON.stringify(state.deleteTokens));
  } catch {}
}

// ------------------------------------------------------------------- theme

const themeIcon = $("#theme-icon");
const prismThemes = {
  dark: "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css",
  light: "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism.min.css",
};

function applyThemeIcon() {
  const dark = document.documentElement.dataset.theme === "dark";
  themeIcon.textContent = dark ? "☀️" : "🌙";
  let link = document.getElementById("prism-theme");
  if (!link) {
    link = document.createElement("link");
    link.id = "prism-theme";
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  link.href = dark ? prismThemes.dark : prismThemes.light;
}

$("#theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("copas-theme", next);
  } catch {}
  applyThemeIcon();
  // Re-highlight so token colours match the new theme.
  if (currentPaste) renderCodeBlock(currentPaste);
});

applyThemeIcon();

// -------------------------------------------------------------- highlight

const PRISM_BASE = "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/";
const prismLoaded = new Set();

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

async function ensurePrism(language) {
  if (!language) return false;
  const lang = language.toLowerCase();
  try {
    if (!prismLoaded.has("core")) {
      await loadScript(`${PRISM_BASE}components/prism-core.min.js`);
      await loadScript(`${PRISM_BASE}components/prism-markup.min.js`);
      await loadScript(`${PRISM_BASE}components/prism-clike.min.js`);
      await loadScript(`${PRISM_BASE}components/prism-javascript.min.js`);
      await loadScript(`${PRISM_BASE}plugins/autoloader/prism-autoloader.min.js`);
      prismLoaded.add("core");
    }
    if (window.Prism && !window.Prism.languages[lang] && lang !== "plain") {
      if (!state.highlightRequests.has(lang)) {
        state.highlightRequests.set(
          lang,
          loadScript(`${PRISM_BASE}components/prism-${lang}.min.js`).catch(() => {}),
        );
      }
      await state.highlightRequests.get(lang);
    }
    return Boolean(window.Prism && window.Prism.languages[lang]);
  } catch {
    return false;
  }
}

let currentPaste = null;

async function renderCodeBlock(paste) {
  const codeEl = $(".code-block code");
  if (!codeEl) return;
  codeEl.textContent = paste.content;
  const lang = paste.language;
  if (lang && (await ensurePrism(lang))) {
    // If the route changed while highlighting loaded, leave the DOM alone.
    if (currentPaste?.id !== paste.id) return;
    codeEl.className = `language-${lang} match-braces rainbow-braces`;
    codeEl.textContent = paste.content;
    window.Prism.highlightElement(codeEl);
  }
}

// ------------------------------------------------------------------ router

function navigate(path, { replace = false } = {}) {
  if (path === location.pathname) {
    route();
    return;
  }
  history[replace ? "replaceState" : "pushState"]({}, "", path);
  route();
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]");
  if (!a) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target === "_blank") return;
  e.preventDefault();
  navigate(a.getAttribute("href"));
});

window.addEventListener("popstate", route);

function pasteIdFromPath(path) {
  const m = /^\/(?:p\/)?([A-Za-z0-9_-]{4,32})\/?$/.exec(path);
  return m ? m[1] : null;
}

async function route() {
  const path = location.pathname;
  if (path === "/" || path === "") {
    await renderHome();
    return;
  }
  const id = pasteIdFromPath(path);
  if (id) {
    await renderPaste(id);
    return;
  }
  renderNotFound();
}

// -------------------------------------------------------------------- home

async function renderHome() {
  currentPaste = null;
  document.title = "Simple Copas — share text with a short link";

  const d = state.draft;
  view.innerHTML = `
    <section class="hero">
      <h1>Paste it. Share the link.</h1>
      <p>No account. No nonsense. Just a short URL for your text or code.</p>
    </section>
    <form class="card" id="paste-form" novalidate>
      <div class="card-body">
        <div class="field title-row">
          <label for="title">Title <span style="font-weight:400;color:var(--fg-faint)">(optional)</span></label>
          <input type="text" id="title" maxlength="120" placeholder="e.g. Deploy notes" value="${esc(d.title)}" autocomplete="off" />
        </div>
        <div class="field">
          <label for="content">Content <span style="font-weight:400;color:var(--fg-faint)">— paste anything</span></label>
          <textarea id="content" class="editor" spellcheck="false" placeholder="Paste your text or code here…&#10;&#10;Tip: press Ctrl/⌘ + Enter to publish."></textarea>
        </div>
      </div>
      <div class="form-footer">
        <div class="options">
          <div class="option">
            <label for="language">Language</label>
            <select id="language">
              ${[
                ["", "Plain text"],
                ["javascript", "JavaScript"],
                ["typescript", "TypeScript"],
                ["json", "JSON"],
                ["html", "HTML"],
                ["css", "CSS"],
                ["bash", "Bash / Shell"],
                ["python", "Python"],
                ["sql", "SQL"],
                ["yaml", "YAML"],
                ["markdown", "Markdown"],
                ["go", "Go"],
                ["java", "Java"],
                ["php", "PHP"],
                ["rust", "Rust"],
                ["diff", "Diff"],
              ]
                .map(
                  ([v, label]) =>
                    `<option value="${v}" ${d.language === v ? "selected" : ""}>${label}</option>`,
                )
                .join("")}
            </select>
          </div>
          <div class="option">
            <label for="expiry">Expires</label>
            <select id="expiry">
              ${[
                ["never", "Never"],
                ["10m", "10 minutes"],
                ["1h", "1 hour"],
                ["1d", "1 day"],
                ["7d", "7 days"],
                ["30d", "30 days"],
              ]
                .map(
                  ([v, label]) =>
                    `<option value="${v}" ${d.expiresIn === v ? "selected" : ""}>${label}</option>`,
                )
                .join("")}
            </select>
          </div>
          <label class="check">
            <input type="checkbox" id="burn" ${d.burnAfterRead ? "checked" : ""} />
            Burn after reading
          </label>
        </div>
        <div class="submit-area" style="display:flex;align-items:center;gap:14px">
          <span class="counter" id="counter">0 B</span>
          <button type="submit" class="btn btn-primary btn-lg" id="submit-btn">✨ Create paste</button>
        </div>
      </div>
    </form>
    <section class="section-title">
      <h2>Recently shared</h2>
      <a href="/api/pastes?limit=50" target="_blank" rel="noopener" style="font-size:.82rem">JSON API ↗</a>
    </section>
    <div id="recent"><div class="list"><div class="empty">Loading…</div></div></div>
    <footer class="authored-by">Made with ♥ · <a href="https://github.com/starmelodic/simple-copas" target="_blank" rel="noopener">GitHub</a></footer>
  `;

  const textarea = $("#content");
  textarea.value = d.content;
  textarea.addEventListener("input", () => {
    d.content = textarea.value;
    updateCounter();
  });
  $("#title").addEventListener("input", (e) => (d.title = e.target.value));
  $("#language").addEventListener("change", (e) => (d.language = e.target.value));
  $("#expiry").addEventListener("change", (e) => (d.expiresIn = e.target.value));
  $("#burn").addEventListener("change", (e) => (d.burnAfterRead = e.target.checked));

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: t } = textarea;
      textarea.setRangeText("  ", s, t, "end");
      d.content = textarea.value;
      updateCounter();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      $("#paste-form").requestSubmit();
    }
  });

  $("#paste-form").addEventListener("submit", (e) => {
    e.preventDefault();
    publishPaste();
  });

  updateCounter();
  textarea.focus();
  loadRecent();
}

function updateCounter() {
  const counter = $("#counter");
  if (!counter) return;
  const bytes = new TextEncoder().encode(state.draft.content).length;
  counter.textContent = formatBytes(bytes);
  counter.classList.toggle("over", bytes > state.config.maxContentBytes);
}

async function publishPaste() {
  const btn = $("#submit-btn");
  const d = state.draft;
  if (!d.content.trim()) {
    toast("Nothing to paste yet.", "error");
    $("#content").focus();
    return;
  }
  btn.disabled = true;
  btn.textContent = "Publishing…";
  try {
    const paste = await api("/api/pastes", {
      method: "POST",
      body: JSON.stringify({
        content: d.content,
        title: d.title || undefined,
        language: d.language || undefined,
        expiresIn: d.expiresIn,
        burnAfterRead: d.burnAfterRead,
      }),
    });
    if (paste.deleteToken) saveToken(paste.id, paste.deleteToken);
    state.draft = { content: "", title: "", language: "", expiresIn: "never", burnAfterRead: false };
    navigate(paste.url ? new URL(paste.url).pathname : `/${paste.id}`, { replace: true });
  } catch (err) {
    toast(err.message || "Failed to create paste.", "error", 4000);
    btn.disabled = false;
    btn.textContent = "✨ Create paste";
  }
}

async function loadRecent() {
  const container = $("#recent");
  if (!container) return;
  try {
    const { pastes } = await api("/api/pastes?limit=8");
    if (!pastes.length) {
      container.innerHTML = `<div class="list"><div class="empty">No pastes yet — be the first 🚀</div></div>`;
      return;
    }
    container.innerHTML = `<div class="list">${pastes.map(recentItem).join("")}</div>`;
  } catch {
    container.innerHTML = `<div class="list"><div class="empty">Couldn’t load recent pastes.</div></div>`;
  }
}

function recentItem(p) {
  const sub = [
    `<span>${esc(timeAgo(p.createdAt))}</span>`,
    `<span class="id">${esc(p.id)}</span>`,
    `<span>${formatBytes(p.size)}</span>`,
    `<span>${p.views} view${p.views === 1 ? "" : "s"}</span>`,
    p.expiresAt ? `<span title="Expires">⏳ ${esc(expiresInLabel(p.expiresAt))}</span>` : "",
  ]
    .filter(Boolean)
    .join("");
  return `
    <div class="list-item">
      <div class="main">
        <a class="name" href="/${esc(p.id)}" data-link>${esc(p.title || `Untitled paste`)}${
          p.language ? ` <span class="badge badge-accent">${esc(p.language)}</span>` : ""
        }${p.burnAfterRead ? ` <span class="badge badge-warn">🔥 one-time</span>` : ""}</a>
        <div class="sub">${sub}</div>
      </div>
      <a class="btn btn-ghost" href="/${esc(p.id)}" data-link>Open →</a>
    </div>`;
}

// ------------------------------------------------------------------- paste

async function renderPaste(id) {
  view.innerHTML = `<div class="center-state"><div class="spinner"></div><p>Loading paste…</p></div>`;
  let paste;
  try {
    paste = await api(`/api/pastes/${encodeURIComponent(id)}`);
  } catch (err) {
    renderNotFound(err.status === 404 ? "This paste doesn’t exist, was deleted, or has expired." : err.message);
    return;
  }
  currentPaste = paste;
  document.title = `${paste.title || "Paste " + paste.id} · Simple Copas`;

  const canDelete = Boolean(state.deleteTokens[paste.id]);
  const expiresLabel = expiresInLabel(paste.expiresAt);
  const rawUrl = `/raw/${paste.id}`;
  const downloadUrl = `/raw/${paste.id}?download=1`;

  view.innerHTML = `
    <article class="card">
      <div class="card-head">
        <div class="group">
          <h1 class="paste-title">${esc(paste.title || "Untitled paste")}</h1>
          ${paste.language ? `<span class="badge badge-accent">${esc(paste.language)}</span>` : `<span class="badge">text</span>`}
          ${paste.burnAfterRead ? `<span class="badge badge-warn">🔥 one-time link</span>` : ""}
          ${expiresLabel ? `<span class="badge" title="Expiry">⏳ ${esc(expiresLabel)}</span>` : ""}
        </div>
        <div class="paste-meta">
          <span class="id">${esc(paste.id)}</span>
          <span>${esc(timeAgo(paste.createdAt))}</span>
          <span>${formatBytes(paste.size)} · ${paste.lines} line${paste.lines === 1 ? "" : "s"}</span>
          <span>👁 ${paste.views}</span>
        </div>
      </div>
      <pre class="code-block" tabindex="0"><code>${esc(paste.content)}</code></pre>
      <div class="view-actions">
        <button class="btn" id="copy-content">📋 Copy content</button>
        <button class="btn" id="copy-url">🔗 Copy link</button>
        <a class="btn btn-ghost" href="${rawUrl}" target="_blank" rel="noopener">📄 Raw</a>
        <a class="btn btn-ghost" href="${downloadUrl}">⬇ Download</a>
        <span style="flex:1"></span>
        ${canDelete ? `<button class="btn btn-danger" id="delete-btn">🗑 Delete</button>` : ""}
        <a class="btn btn-primary" href="/" data-link>✏️ New paste</a>
      </div>
    </article>
    ${
      paste.burnAfterRead
        ? `<p style="text-align:center;color:var(--fg-muted);font-size:.85rem;margin-top:14px">This link self-destructs — the next visit will return “not found”.</p>`
        : ""
    }
  `;

  renderCodeBlock(paste);

  $("#copy-content").addEventListener("click", async () => {
    toast((await copyText(paste.content)) ? "Content copied" : "Copy failed", undefined, 1800);
  });
  $("#copy-url").addEventListener("click", async () => {
    toast((await copyText(location.origin + `/${paste.id}`)) ? "Link copied" : "Copy failed", undefined, 1800);
  });
  const deleteBtn = $("#delete-btn");
  if (deleteBtn) deleteBtn.addEventListener("click", () => confirmDelete(paste));
}

function confirmDelete(paste) {
  const dialog = el(`
    <dialog>
      <h2>Delete this paste?</h2>
      <p>This permanently removes <strong>${esc(paste.id)}</strong> and its link stops working.</p>
      <div class="actions">
        <button class="btn" value="cancel">Cancel</button>
        <button class="btn btn-danger" value="confirm">Delete</button>
      </div>
    </dialog>`);
  document.body.appendChild(dialog);
  dialog.showModal();
  dialog.addEventListener("click", async (e) => {
    const choice = e.target.closest("button")?.value;
    if (!choice) return;
    dialog.close();
    dialog.remove();
    if (choice !== "confirm") return;
    try {
      await api(`/api/pastes/${paste.id}`, {
        method: "DELETE",
        headers: { "X-Delete-Token": state.deleteTokens[paste.id] },
      });
      dropToken(paste.id);
      toast("Paste deleted");
      navigate("/");
    } catch (err) {
      toast(err.message || "Delete failed", "error");
    }
  });
}

// --------------------------------------------------------------- not found

function renderNotFound(message = "This paste doesn’t exist, was deleted, or has expired.") {
  currentPaste = null;
  document.title = "Not found · Simple Copas";
  view.innerHTML = `
    <div class="center-state">
      <div class="icon">🔍</div>
      <h1>Paste not found</h1>
      <p>${esc(message)}</p>
      <a href="/" class="btn btn-primary" data-link>Create a new paste</a>
    </div>`;
}

// ------------------------------------------------------------------- boot

(async function boot() {
  try {
    const health = await api("/api/health");
    const badge = $("#version-badge");
    if (badge && health.version) badge.textContent = `v${health.version.split(".")[0]}`;
  } catch {
    /* health is best-effort */
  }
  route();
})();
