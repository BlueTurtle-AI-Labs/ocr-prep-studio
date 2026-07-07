// ============================================================
// OCR Prep Studio — Page Range & Mask Studio
// All processing happens client-side: PDF.js renders pages,
// pdf-lib writes the exported PDFs. Nothing leaves the browser.
// ============================================================

function configurePdfJsWorker() {
  if (window.pdfjsLib && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
  }
}
configurePdfJsWorker();

const MIN_BOX = 0.008; // smallest normalized box dimension we accept (else treated as a click)
const HANDLE_PX = 9;   // resize-handle hit radius, in canvas pixels

const state = {
  pdfDoc: null,
  fileBaseName: "document",
  numPages: 0,
  ranges: [],         // {id, start, end, label}
  pageMasks: {},      // pageNum -> [{x,y,w,h}]  — fully independent per page
  currentPage: 1,
  maskColor: "#ffffff",
  zoom: 1.1,
  drag: null,         // {mode:'new'|'move'|'resize', index, corner, startX, startY, orig}
  selectedIndex: null,
  pendingExport: null, // {maskedUrl, cleanUrl, maskedName, cleanName}
};

let nextRangeId = 1;

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const fileInput = $("fileInput");
const fileNameLabel = $("fileNameLabel");
const rangeStart = $("rangeStart");
const rangeEnd = $("rangeEnd");
const rangeLabel = $("rangeLabel");
const addRangeBtn = $("addRangeBtn");
const rangeListEl = $("rangeList");
const prevPageBtn = $("prevPageBtn");
const nextPageBtn = $("nextPageBtn");
const pageInput = $("pageInput");
const numPagesLabel = $("numPagesLabel");
const pageStatus = $("pageStatus");
const includedChips = $("includedChips");
const zoomSelect = $("zoomSelect");
const canvasStack = $("canvasStack");
const emptyState = $("emptyState");
const baseCanvas = $("baseCanvas");
const overlayCanvas = $("overlayCanvas");
const baseCtx = baseCanvas.getContext("2d");
const overlayCtx = overlayCanvas.getContext("2d");
const maskListEl = $("maskList");
const deleteSelectedBtn = $("deleteSelectedBtn");
const clearPageBtn = $("clearPageBtn");
const copyNextBtn = $("copyNextBtn");
const copyRangeBtn = $("copyRangeBtn");
const qmTop = $("qmTop");
const qmBottom = $("qmBottom");
const qmLeft = $("qmLeft");
const qmRight = $("qmRight");
const exportBtn = $("exportBtn");
const exportBtn2 = $("exportBtn2");
const resolutionSelect = $("resolutionSelect");
const saveProjectBtn = $("saveProjectBtn");
const loadProjectInput = $("loadProjectInput");
const statusBar = $("statusBar");
const exportModal = $("exportModal");
const exportModalSummary = $("exportModalSummary");
const downloadMaskedBtn = $("downloadMaskedBtn");
const downloadCleanBtn = $("downloadCleanBtn");
const closeExportModalBtn = $("closeExportModalBtn");
const resizerLeft = $("resizerLeft");
const resizerRight = $("resizerRight");

// ---------- status helper ----------
function setStatus(msg, busy) {
  statusBar.textContent = msg;
  statusBar.classList.toggle("busy", !!busy);
}

// ============================================================
// Resizable side panels — drag the thin bars between the panels
// and the canvas viewer. Widths are kept as CSS custom properties
// on the root element so a single JS number stays in sync with layout.
// ============================================================
(function setupResizers() {
  const MIN_W = 200, MAX_W = 520;
  const root = document.documentElement;

  function currentPx(varName) {
    const v = getComputedStyle(root).getPropertyValue(varName).trim();
    return parseInt(v, 10) || 0;
  }

  function bind(handle, varName, growsWithPositiveDelta) {
    let startX = 0, startW = 0;
    function onMove(e) {
      const x = e.touches ? e.touches[0].clientX : e.clientX;
      const delta = x - startX;
      const next = growsWithPositiveDelta ? startW + delta : startW - delta;
      const clamped = Math.max(MIN_W, Math.min(MAX_W, next));
      root.style.setProperty(varName, clamped + "px");
    }
    function onUp() {
      handle.classList.remove("active");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
      try {
        localStorage.setItem("ocrprepPanelWidths", JSON.stringify({
          left: currentPx("--left-w"), right: currentPx("--right-w"),
        }));
      } catch (e) { /* localStorage unavailable — not critical */ }
    }
    function onDown(e) {
      startX = e.touches ? e.touches[0].clientX : e.clientX;
      startW = currentPx(varName);
      handle.classList.add("active");
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      window.addEventListener("touchmove", onMove, { passive: false });
      window.addEventListener("touchend", onUp);
      e.preventDefault();
    }
    handle.addEventListener("mousedown", onDown);
    handle.addEventListener("touchstart", onDown, { passive: false });
    handle.addEventListener("dblclick", () => {
      root.style.setProperty(varName, varName === "--left-w" ? "290px" : "300px");
    });
  }

  // restore any previously saved widths
  try {
    const saved = JSON.parse(localStorage.getItem("ocrprepPanelWidths") || "null");
    if (saved && saved.left) root.style.setProperty("--left-w", saved.left + "px");
    if (saved && saved.right) root.style.setProperty("--right-w", saved.right + "px");
  } catch (e) { /* ignore */ }

  bind(resizerLeft, "--left-w", true);
  bind(resizerRight, "--right-w", false);
})();

// ---------- library load check (after any CDN fallback) ----------
window.addEventListener("load", async () => {
  if (window.__libsReady) await window.__libsReady;
  configurePdfJsWorker();
  const missing = [];
  if (!window.pdfjsLib) missing.push("pdf.js");
  if (!window.PDFLib) missing.push("pdf-lib");
  if (missing.length) {
    setStatus(`Warning: ${missing.join(" and ")} failed to load from CDN. Check your connection (or ad-blocker) and reload the page.`);
  }
});

// ============================================================
// PDF loading
// ============================================================
fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (window.__libsReady) await window.__libsReady;
  configurePdfJsWorker();
  if (typeof pdfjsLib === "undefined") {
    alert("pdf.js didn't load from the CDN, so PDFs can't be read. Check your internet connection (or ad-blocker) and reload the page.");
    setStatus("pdf.js is unavailable — reload the page.");
    return;
  }
  setStatus("Loading PDF…", true);
  const buf = await file.arrayBuffer();
  try {
    state.pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
  } catch (err) {
    alert("Could not read this PDF: " + err.message);
    setStatus("Failed to load PDF.");
    return;
  }
  state.numPages = state.pdfDoc.numPages;
  state.fileBaseName = file.name.replace(/\.pdf$/i, "");
  fileNameLabel.textContent = file.name;
  numPagesLabel.textContent = state.numPages;
  state.currentPage = 1;
  state.ranges = [];
  state.pageMasks = {};
  state.selectedIndex = null;
  pageInput.max = state.numPages;
  pageInput.value = 1;
  emptyState.style.display = "none";
  canvasStack.style.display = "block";
  saveProjectBtn.disabled = false;
  exportBtn.disabled = false;
  exportBtn2.disabled = false;
  renderCurrentPage();
  setStatus(`Loaded ${file.name} — ${state.numPages} pages. Whole document is included by default.`);
});

// ============================================================
// Ranges (optional — restrict export to a subset of pages)
// ============================================================
function addRange() {
  const start = parseInt(rangeStart.value, 10);
  const end = parseInt(rangeEnd.value, 10);
  if (!state.pdfDoc) { alert("Load a PDF first."); return; }
  if (!start || !end || start < 1 || end < start || end > state.numPages) {
    alert(`Enter a valid page range between 1 and ${state.numPages}.`);
    return;
  }
  const label = rangeLabel.value.trim() || `Pages ${start}–${end}`;
  const id = "r" + nextRangeId++;
  state.ranges.push({ id, start, end, label });
  rangeStart.value = "";
  rangeEnd.value = "";
  rangeLabel.value = "";
  refreshPageDependentUI();
}
addRangeBtn.addEventListener("click", addRange);

function removeRange(id) {
  state.ranges = state.ranges.filter((r) => r.id !== id);
  refreshPageDependentUI();
}

function renderRangeList() {
  rangeListEl.innerHTML = "";
  if (!state.ranges.length) {
    rangeListEl.innerHTML = `<span class="hint" style="margin:0;">No ranges added — using the entire document.</span>`;
    return;
  }
  state.ranges.forEach((r) => {
    const div = document.createElement("div");
    const inThis = state.currentPage >= r.start && state.currentPage <= r.end;
    div.className = "range-chip" + (inThis ? " active" : "");
    div.innerHTML = `
      <span class="label">${escapeHtml(r.label)}</span>
      <span class="pages">${r.start}–${r.end}</span>
      <button title="Jump here" data-act="jump">↳</button>
      <button title="Remove range" data-act="remove">✕</button>
    `;
    div.querySelector('[data-act="jump"]').addEventListener("click", (ev) => {
      ev.stopPropagation();
      goToPage(r.start);
    });
    div.querySelector('[data-act="remove"]').addEventListener("click", (ev) => {
      ev.stopPropagation();
      removeRange(r.id);
    });
    rangeListEl.appendChild(div);
  });
}

// which pages are actually exported: union of ranges, or the
// whole document if no ranges have been defined
function isPageIncluded(p) {
  if (!state.ranges.length) return true;
  return state.ranges.some((r) => p >= r.start && p <= r.end);
}

function getIncludedPages() {
  if (!state.pdfDoc) return [];
  if (!state.ranges.length) {
    const all = [];
    for (let p = 1; p <= state.numPages; p++) all.push(p);
    return all;
  }
  const set = new Set();
  const ordered = [];
  state.ranges
    .slice()
    .sort((a, b) => a.start - b.start)
    .forEach((r) => {
      for (let p = r.start; p <= r.end; p++) {
        if (!set.has(p)) { set.add(p); ordered.push(p); }
      }
    });
  return ordered;
}

// the range containing a page, if any explicit ranges exist
function getRangeForPage(pageNum) {
  return state.ranges.find((r) => pageNum >= r.start && pageNum <= r.end) || null;
}

function renderIncludedChips() {
  const pages = getIncludedPages();
  includedChips.innerHTML = "";
  if (!pages.length) {
    includedChips.innerHTML = `<span class="hint" style="margin:0;">No pages selected yet.</span>`;
    return;
  }
  // avoid rendering thousands of chips for very large docs with no ranges
  const display = pages.length > 400 ? [] : pages;
  if (!display.length) {
    includedChips.innerHTML = `<span class="hint" style="margin:0;">All ${pages.length} pages included. Use the page field above to jump around.</span>`;
    return;
  }
  display.forEach((p) => {
    const span = document.createElement("span");
    span.className = "pchip" + (p === state.currentPage ? " current" : "");
    span.textContent = p;
    span.addEventListener("click", () => goToPage(p));
    includedChips.appendChild(span);
  });
}

// ============================================================
// Page navigation
// ============================================================
function goToPage(p) {
  p = Math.max(1, Math.min(state.numPages || 1, p));
  state.currentPage = p;
  pageInput.value = p;
  state.selectedIndex = null;
  renderCurrentPage();
}
prevPageBtn.addEventListener("click", () => goToPage(state.currentPage - 1));
nextPageBtn.addEventListener("click", () => goToPage(state.currentPage + 1));
pageInput.addEventListener("change", () => goToPage(parseInt(pageInput.value, 10) || 1));
zoomSelect.addEventListener("change", () => {
  state.zoom = parseFloat(zoomSelect.value);
  renderCurrentPage();
});

async function renderCurrentPage() {
  if (!state.pdfDoc) return;
  const page = await state.pdfDoc.getPage(state.currentPage);
  const viewport = page.getViewport({ scale: state.zoom });
  baseCanvas.width = overlayCanvas.width = viewport.width;
  baseCanvas.height = overlayCanvas.height = viewport.height;
  await page.render({ canvasContext: baseCtx, viewport }).promise;
  refreshPageDependentUI();
}

function refreshPageDependentUI() {
  renderRangeList();
  renderIncludedChips();
  updatePageStatus();
  drawOverlay();
  renderMaskList();
  updateActionButtons();
}

function updatePageStatus() {
  if (!state.pdfDoc) { pageStatus.textContent = "Load a PDF to begin."; return; }
  const included = isPageIncluded(state.currentPage);
  const r = getRangeForPage(state.currentPage);
  pageStatus.className = "page-status " + (included ? "in-range" : "out-range");
  if (!included) {
    pageStatus.innerHTML = `Page ${state.currentPage} of ${state.numPages} — not in any selected range (won't be exported)`;
  } else if (r) {
    pageStatus.innerHTML = `Page ${state.currentPage} of ${state.numPages} — in <span class="rn">${escapeHtml(r.label)}</span>`;
  } else {
    pageStatus.innerHTML = `Page ${state.currentPage} of ${state.numPages} — included (whole document)`;
  }
}

// ============================================================
// Mask data model — every page is independent by default.
// ============================================================
function getPageMasks(pageNum) {
  return state.pageMasks[pageNum] || [];
}
function getWorkingArray(pageNum) {
  if (!state.pageMasks[pageNum]) state.pageMasks[pageNum] = [];
  return state.pageMasks[pageNum];
}

function updateActionButtons() {
  const hasPdf = !!state.pdfDoc;
  const hasNext = hasPdf && state.currentPage < state.numPages;
  const masks = getPageMasks(state.currentPage);
  [qmTop, qmBottom, qmLeft, qmRight].forEach((b) => (b.disabled = !hasPdf));
  copyNextBtn.disabled = !hasNext || !masks.length;
  copyRangeBtn.disabled = !hasPdf || !masks.length;
  clearPageBtn.disabled = !masks.length;
  deleteSelectedBtn.disabled = state.selectedIndex == null;
}

// ---------- quick masks ----------
function addQuickMask(rect) {
  if (!state.pdfDoc) return;
  const arr = getWorkingArray(state.currentPage);
  arr.push(rect);
  refreshPageDependentUI();
}
qmTop.addEventListener("click", () => addQuickMask({ x: 0, y: 0, w: 1, h: 0.5 }));
qmBottom.addEventListener("click", () => addQuickMask({ x: 0, y: 0.5, w: 1, h: 0.5 }));
qmLeft.addEventListener("click", () => addQuickMask({ x: 0, y: 0, w: 0.5, h: 1 }));
qmRight.addEventListener("click", () => addQuickMask({ x: 0.5, y: 0, w: 0.5, h: 1 }));

clearPageBtn.addEventListener("click", () => {
  const arr = getWorkingArray(state.currentPage);
  if (!arr.length) return;
  if (!confirm("Clear all boxes on this page?")) return;
  arr.length = 0;
  state.selectedIndex = null;
  refreshPageDependentUI();
});
deleteSelectedBtn.addEventListener("click", () => {
  const arr = getWorkingArray(state.currentPage);
  if (state.selectedIndex == null) return;
  arr.splice(state.selectedIndex, 1);
  state.selectedIndex = null;
  refreshPageDependentUI();
});

// ---------- explicit copy actions ----------
copyNextBtn.addEventListener("click", () => {
  const arr = getPageMasks(state.currentPage);
  if (!arr.length || state.currentPage >= state.numPages) return;
  const target = state.currentPage + 1;
  if (getPageMasks(target).length &&
      !confirm(`Page ${target} already has boxes — overwrite them with this page's boxes?`)) {
    return;
  }
  state.pageMasks[target] = arr.map((m) => ({ ...m }));
  goToPage(target);
});

copyRangeBtn.addEventListener("click", () => {
  const arr = getPageMasks(state.currentPage);
  if (!arr.length) return;
  const r = getRangeForPage(state.currentPage);
  const start = r ? r.start : 1;
  const end = r ? r.end : state.numPages;
  const targetPages = [];
  for (let p = start; p <= end; p++) if (p !== state.currentPage) targetPages.push(p);
  const scopeLabel = r ? `"${r.label}" (${start}–${end})` : `the entire document (${start}–${end})`;
  if (!confirm(`Copy this page's ${arr.length} box(es) to all ${targetPages.length} other pages in ${scopeLabel}? This overwrites any boxes already on those pages.`)) {
    return;
  }
  targetPages.forEach((p) => { state.pageMasks[p] = arr.map((m) => ({ ...m })); });
  refreshPageDependentUI();
  setStatus(`Copied boxes to ${targetPages.length} pages in ${scopeLabel}.`);
});

// ============================================================
// Mask list panel
// ============================================================
function renderMaskList() {
  const masks = getPageMasks(state.currentPage);
  maskListEl.innerHTML = "";
  masks.forEach((m, i) => {
    const row = document.createElement("div");
    row.className = "mask-row" + (i === state.selectedIndex ? " selected" : "");
    row.innerHTML = `<span class="coords">x${Math.round(m.x * 100)}% y${Math.round(m.y * 100)}% ${Math.round(m.w * 100)}×${Math.round(m.h * 100)}%</span><button data-i="${i}">✕</button>`;
    row.addEventListener("click", (e) => {
      if (e.target.tagName === "BUTTON") return;
      state.selectedIndex = i;
      refreshPageDependentUI();
    });
    row.querySelector("button").addEventListener("click", (e) => {
      e.stopPropagation();
      const arr = getWorkingArray(state.currentPage);
      arr.splice(i, 1);
      state.selectedIndex = null;
      refreshPageDependentUI();
    });
    maskListEl.appendChild(row);
  });
}

// ============================================================
// Overlay drawing (existing boxes + live drag preview)
// ============================================================
let hatchPattern = null;
function getHatchPattern() {
  if (hatchPattern) return hatchPattern;
  const tile = document.createElement("canvas");
  tile.width = tile.height = 12;
  const tctx = tile.getContext("2d");
  tctx.strokeStyle = "rgba(138,58,47,0.55)";
  tctx.lineWidth = 2;
  tctx.beginPath();
  tctx.moveTo(0, 12); tctx.lineTo(12, 0);
  tctx.moveTo(-3, 3); tctx.lineTo(3, -3);
  tctx.moveTo(9, 15); tctx.lineTo(15, 9);
  tctx.stroke();
  hatchPattern = overlayCtx.createPattern(tile, "repeat");
  return hatchPattern;
}

function drawOverlay(previewRect) {
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  const masks = getPageMasks(state.currentPage);
  const W = overlayCanvas.width, H = overlayCanvas.height;
  masks.forEach((m, i) => {
    const px = m.x * W, py = m.y * H, pw = m.w * W, ph = m.h * H;
    overlayCtx.fillStyle = "rgba(236,231,216,0.35)";
    overlayCtx.fillRect(px, py, pw, ph);
    overlayCtx.fillStyle = getHatchPattern();
    overlayCtx.fillRect(px, py, pw, ph);
    overlayCtx.lineWidth = i === state.selectedIndex ? 2.5 : 1.5;
    overlayCtx.strokeStyle = i === state.selectedIndex ? "#8a3a2f" : "rgba(138,58,47,0.85)";
    overlayCtx.strokeRect(px, py, pw, ph);
    if (i === state.selectedIndex) {
      overlayCtx.fillStyle = "#8a3a2f";
      [
        [px, py], [px + pw, py], [px, py + ph], [px + pw, py + ph],          // corners
        [px + pw / 2, py], [px + pw / 2, py + ph],                            // top/bottom mid
        [px, py + ph / 2], [px + pw, py + ph / 2],                            // left/right mid
      ].forEach(([hx, hy]) => {
        overlayCtx.fillRect(hx - 4, hy - 4, 8, 8);
      });
    }
  });
  if (previewRect) {
    const { x, y, w, h } = previewRect;
    overlayCtx.setLineDash([5, 4]);
    overlayCtx.strokeStyle = "#3f6a5e";
    overlayCtx.lineWidth = 1.5;
    overlayCtx.strokeRect(x, y, w, h);
    overlayCtx.setLineDash([]);
  }
}

// ============================================================
// Mouse interaction: draw / move / resize boxes
// ============================================================
function canvasPos(e) {
  const rect = overlayCanvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function hitTest(px, py) {
  const masks = getPageMasks(state.currentPage);
  const W = overlayCanvas.width, H = overlayCanvas.height;
  for (let i = masks.length - 1; i >= 0; i--) {
    const m = masks[i];
    const rx = m.x * W, ry = m.y * H, rw = m.w * W, rh = m.h * H;
    // corners first (they take priority over edges)
    const corners = { tl: [rx, ry], tr: [rx + rw, ry], bl: [rx, ry + rh], br: [rx + rw, ry + rh] };
    for (const [name, [cx, cy]] of Object.entries(corners)) {
      if (Math.abs(px - cx) <= HANDLE_PX && Math.abs(py - cy) <= HANDLE_PX) {
        return { mode: "resize", index: i, corner: name };
      }
    }
    // edges: within HANDLE_PX of an edge line, between its corners
    const withinX = px >= rx - HANDLE_PX && px <= rx + rw + HANDLE_PX;
    const withinY = py >= ry - HANDLE_PX && py <= ry + rh + HANDLE_PX;
    if (withinX && Math.abs(py - ry) <= HANDLE_PX)        return { mode: "resize", index: i, corner: "t" };
    if (withinX && Math.abs(py - (ry + rh)) <= HANDLE_PX) return { mode: "resize", index: i, corner: "b" };
    if (withinY && Math.abs(px - rx) <= HANDLE_PX)        return { mode: "resize", index: i, corner: "l" };
    if (withinY && Math.abs(px - (rx + rw)) <= HANDLE_PX) return { mode: "resize", index: i, corner: "r" };
    if (px >= rx && px <= rx + rw && py >= ry && py <= ry + rh) {
      return { mode: "move", index: i };
    }
  }
  return { mode: "new" };
}

// map a hit result to the cursor the user should see
const CURSOR_FOR = {
  tl: "nwse-resize", br: "nwse-resize",
  tr: "nesw-resize", bl: "nesw-resize",
  t: "ns-resize", b: "ns-resize",
  l: "ew-resize", r: "ew-resize",
};
function cursorForHit(hit) {
  if (hit.mode === "resize") return CURSOR_FOR[hit.corner] || "crosshair";
  if (hit.mode === "move") return "move";
  return "crosshair";
}

overlayCanvas.addEventListener("mousedown", (e) => {
  if (!state.pdfDoc) return;
  const { x, y } = canvasPos(e);
  const hit = hitTest(x, y);
  const arr = getWorkingArray(state.currentPage);

  if (hit.mode === "move" || hit.mode === "resize") {
    state.selectedIndex = hit.index;
    state.drag = { mode: hit.mode, corner: hit.corner, index: hit.index, startX: x, startY: y, orig: { ...arr[hit.index] } };
  } else {
    state.selectedIndex = null;
    state.drag = { mode: "new", startX: x, startY: y };
  }
  overlayCanvas.style.cursor = cursorForHit(hit);
  refreshPageDependentUI();
});

overlayCanvas.addEventListener("mousemove", (e) => {
  const { x, y } = canvasPos(e);

  // not dragging: just update the hover cursor as an affordance
  if (!state.drag) {
    if (state.pdfDoc) overlayCanvas.style.cursor = cursorForHit(hitTest(x, y));
    return;
  }

  const W = overlayCanvas.width, H = overlayCanvas.height;
  const arr = getWorkingArray(state.currentPage);

  if (state.drag.mode === "new") {
    const rx = Math.min(state.drag.startX, x), ry = Math.min(state.drag.startY, y);
    const rw = Math.abs(x - state.drag.startX), rh = Math.abs(y - state.drag.startY);
    drawOverlay({ x: rx, y: ry, w: rw, h: rh });
  } else if (state.drag.mode === "move") {
    const dx = (x - state.drag.startX) / W, dy = (y - state.drag.startY) / H;
    const o = state.drag.orig;
    const m = arr[state.drag.index];
    m.x = clamp(o.x + dx, 0, 1 - o.w);
    m.y = clamp(o.y + dy, 0, 1 - o.h);
    drawOverlay();
  } else if (state.drag.mode === "resize") {
    const o = state.drag.orig;
    const m = arr[state.drag.index];
    let x0 = o.x * W, y0 = o.y * H, x1 = (o.x + o.w) * W, y1 = (o.y + o.h) * H;
    const c = state.drag.corner;
    // corners move two sides; edges move one
    if (c === "tl") { x0 = x; y0 = y; }
    else if (c === "tr") { x1 = x; y0 = y; }
    else if (c === "bl") { x0 = x; y1 = y; }
    else if (c === "br") { x1 = x; y1 = y; }
    else if (c === "t") { y0 = y; }
    else if (c === "b") { y1 = y; }
    else if (c === "l") { x0 = x; }
    else if (c === "r") { x1 = x; }
    const nx = Math.min(x0, x1) / W, ny = Math.min(y0, y1) / H;
    const nw = Math.abs(x1 - x0) / W, nh = Math.abs(y1 - y0) / H;
    m.x = clamp(nx, 0, 1); m.y = clamp(ny, 0, 1);
    m.w = Math.min(nw, 1 - m.x); m.h = Math.min(nh, 1 - m.y);
    drawOverlay();
  }
});

window.addEventListener("mouseup", (e) => {
  if (!state.drag) return;
  const arr = getWorkingArray(state.currentPage);
  if (state.drag.mode === "new") {
    const pos = canvasPos(e);
    const rx = Math.min(state.drag.startX, pos.x), ry = Math.min(state.drag.startY, pos.y);
    const rw = Math.abs(pos.x - state.drag.startX), rh = Math.abs(pos.y - state.drag.startY);
    const W = overlayCanvas.width, H = overlayCanvas.height;
    const nw = rw / W, nh = rh / H;
    if (nw > MIN_BOX && nh > MIN_BOX) {
      arr.push({ x: rx / W, y: ry / H, w: nw, h: nh });
      state.selectedIndex = arr.length - 1;
    }
  }
  state.drag = null;
  if (state.pdfDoc) {
    const pos2 = canvasPos(e);
    overlayCanvas.style.cursor = cursorForHit(hitTest(pos2.x, pos2.y));
  }
  refreshPageDependentUI();
});

// keyboard: delete / nudge selected box
window.addEventListener("keydown", (e) => {
  if (state.selectedIndex == null) return;
  const arr = getWorkingArray(state.currentPage);
  if (!arr[state.selectedIndex]) return;
  const tag = document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  const m = arr[state.selectedIndex];
  const step = 0.004;
  let handled = true;
  if (e.key === "Backspace" || e.key === "Delete") {
    arr.splice(state.selectedIndex, 1);
    state.selectedIndex = null;
  } else if (e.key === "ArrowLeft") m.x = clamp(m.x - step, 0, 1 - m.w);
  else if (e.key === "ArrowRight") m.x = clamp(m.x + step, 0, 1 - m.w);
  else if (e.key === "ArrowUp") m.y = clamp(m.y - step, 0, 1 - m.h);
  else if (e.key === "ArrowDown") m.y = clamp(m.y + step, 0, 1 - m.h);
  else handled = false;
  if (handled) { e.preventDefault(); refreshPageDependentUI(); }
});

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ============================================================
// Mask color swatches
// ============================================================
document.querySelectorAll(".swatch").forEach((sw) => {
  sw.addEventListener("click", () => {
    document.querySelectorAll(".swatch").forEach((s) => s.classList.remove("active"));
    sw.classList.add("active");
    state.maskColor = sw.dataset.color;
  });
});

// ============================================================
// Export: two PDFs, identical page ranges — one masked, one clean.
// Results are handed to the user via a small modal with two
// separate download buttons, since browsers often block a
// second automatic download triggered in the same script.
// ============================================================
async function exportPdfs() {
  if (window.__libsReady) await window.__libsReady;
  if (typeof PDFLib === "undefined") {
    alert("pdf-lib could not be loaded (local copy missing and CDNs unreachable), so export can't run. Make sure pdf-lib.min.js sits in the same folder as index.html.");
    return;
  }
  const pages = getIncludedPages();
  if (!pages.length) { alert("Nothing to export."); return; }
  const dpi = parseFloat(resolutionSelect.value);
  const scale = dpi / 72; // PDF points are defined as 1/72 inch, so this maps DPI to a PDF.js render scale

  exportBtn.disabled = exportBtn2.disabled = true;
  exportBtn.textContent = exportBtn2.textContent = "Rendering PDFs...";
  try {
    const maskedDoc = await PDFLib.PDFDocument.create();
    const cleanDoc = await PDFLib.PDFDocument.create();

    for (let i = 0; i < pages.length; i++) {
      const pageNum = pages[i];
      setStatus(`Rendering page ${pageNum} (${i + 1} of ${pages.length})…`, true);
      await new Promise((r) => setTimeout(r, 0)); // let the status text paint

      const page = await state.pdfDoc.getPage(pageNum);
      const renderViewport = page.getViewport({ scale });
      const baseViewport = page.getViewport({ scale: 1 });

      const canvas = document.createElement("canvas");
      canvas.width = renderViewport.width;
      canvas.height = renderViewport.height;
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;

      const cleanPng = canvas.toDataURL("image/png");

      const masks = getPageMasks(pageNum);
      if (masks.length) {
        ctx.fillStyle = state.maskColor;
        masks.forEach((m) => {
          ctx.fillRect(m.x * canvas.width, m.y * canvas.height, m.w * canvas.width, m.h * canvas.height);
        });
      }
      const maskedPng = canvas.toDataURL("image/png");

      const pw = baseViewport.width, ph = baseViewport.height;

      const cleanImg = await cleanDoc.embedPng(cleanPng);
      cleanDoc.addPage([pw, ph]).drawImage(cleanImg, { x: 0, y: 0, width: pw, height: ph });

      const maskedImg = await maskedDoc.embedPng(maskedPng);
      maskedDoc.addPage([pw, ph]).drawImage(maskedImg, { x: 0, y: 0, width: pw, height: ph });
    }

    setStatus("Finalizing PDFs…", true);
    const maskedBytes = await maskedDoc.save();
    const cleanBytes = await cleanDoc.save();

    if (state.pendingExport) {
      URL.revokeObjectURL(state.pendingExport.maskedUrl);
      URL.revokeObjectURL(state.pendingExport.cleanUrl);
    }
    const maskedBlob = new Blob([maskedBytes], { type: "application/pdf" });
    const cleanBlob = new Blob([cleanBytes], { type: "application/pdf" });
    state.pendingExport = {
      maskedUrl: URL.createObjectURL(maskedBlob),
      cleanUrl: URL.createObjectURL(cleanBlob),
      maskedName: `${state.fileBaseName}_masked.pdf`,
      cleanName: `${state.fileBaseName}_clean.pdf`,
    };
    exportModalSummary.textContent = `${pages.length} pages processed. Download each file below.`;
    exportModal.classList.remove("hidden");
    setStatus(`Export complete — ${pages.length} pages.`);
  } catch (err) {
    console.error(err);
    alert("Export failed: " + err.message);
    setStatus("Export failed.");
  } finally {
    exportBtn.disabled = exportBtn2.disabled = false;
    exportBtn.textContent = exportBtn2.textContent = "Export Masked + Clean PDFs";

  }
}
exportBtn.addEventListener("click", exportPdfs);
exportBtn2.addEventListener("click", exportPdfs);

downloadMaskedBtn.addEventListener("click", () => {
  if (!state.pendingExport) return;
  triggerDownload(state.pendingExport.maskedUrl, state.pendingExport.maskedName);
});
downloadCleanBtn.addEventListener("click", () => {
  if (!state.pendingExport) return;
  triggerDownload(state.pendingExport.cleanUrl, state.pendingExport.cleanName);
});
closeExportModalBtn.addEventListener("click", () => {
  exportModal.classList.add("hidden");
  if (state.pendingExport) {
    URL.revokeObjectURL(state.pendingExport.maskedUrl);
    URL.revokeObjectURL(state.pendingExport.cleanUrl);
    state.pendingExport = null;
  }
});

function triggerDownload(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ============================================================
// Project save / load (ranges + masks as JSON; PDF must be
// reloaded separately since we don't re-embed it)
// ============================================================
saveProjectBtn.addEventListener("click", () => {
  const project = {
    fileBaseName: state.fileBaseName,
    numPages: state.numPages,
    ranges: state.ranges,
    pageMasks: state.pageMasks,
    maskColor: state.maskColor,
    nextRangeId,
  };
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${state.fileBaseName}_ocrprep-project.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
});

loadProjectInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!state.pdfDoc) {
    alert("Load the matching PDF first, then load this project file.");
    e.target.value = "";
    return;
  }
  try {
    const text = await file.text();
    const project = JSON.parse(text);
    state.ranges = project.ranges || [];
    state.pageMasks = project.pageMasks || {};
    state.maskColor = project.maskColor || "#ffffff";
    nextRangeId = project.nextRangeId || (state.ranges.length + 1);
    document.querySelectorAll(".swatch").forEach((s) => s.classList.toggle("active", s.dataset.color === state.maskColor));
    state.selectedIndex = null;
    refreshPageDependentUI();
    setStatus(`Loaded project: ${file.name}`);
  } catch (err) {
    alert("Could not read this project file: " + err.message);
  }
  e.target.value = "";
});

// ============================================================
// util
// ============================================================
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}