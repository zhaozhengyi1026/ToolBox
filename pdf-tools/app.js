/* global pdfjsLib, PDFLib, JSZip */

const LIMITS = Object.freeze({ maxFiles: 20, maxFileBytes: 100 * 1024 * 1024, maxTotalBytes: 300 * 1024 * 1024, maxPages: 500, pagesPerView: 15, maxSplitItems: 500, maxCanvasPixels: 40_000_000 });
const PRESETS = Object.freeze({ small: { scale: 1.2, quality: .52 }, balanced: { scale: 1.5, quality: .68 }, clear: { scale: 2, quality: .82 } });
const MODE_COPY = Object.freeze({ split: { title: "拆分 PDF", kicker: "PDF SPLIT" }, image: { title: "PDF 转图片", kicker: "PDF TO IMAGE" }, compress: { title: "压缩 PDF", kicker: "PDF COMPRESS" } });
const state = { mode: null, documents: [], currentIndex: 0, busy: false, drag: null, ignoreNextClick: false };
const $ = (selector) => document.querySelector(selector);
const elements = {
  entries: $("#tool-entries"), shell: $("#tool-shell"), modeBack: $("#mode-back"), workbenchTitle: $("#workbench-title"), uploadKicker: $("#upload-kicker"), uploadView: $("#upload-view"), input: $("#pdf-input"), dropZone: $("#drop-zone"), workspace: $("#workspace"), workspaceModeTitle: $("#workspace-mode-title"), workspaceFileCount: $("#workspace-file-count"), changeFiles: $("#change-files"), fileList: $("#file-list"), fileCount: $("#file-count"),
  pageWorkspace: $("#page-workspace"), fileName: $("#file-name"), fileMeta: $("#file-meta"), pageWindowLabel: $("#page-window-label"), pageInput: $("#selected-pages"), selectedCount: $("#selected-count"), pageGrid: $("#page-grid"), previousSet: $("#previous-page-set"), nextSet: $("#next-page-set"), paginationLabel: $("#pagination-label"),
  splitPanel: $("#split-panel"), addSplit: $("#add-split"), splitSingle: $("#split-single"), splitList: $("#split-list"), splitEmpty: $("#split-empty"), splitBar: $("#split-download-bar"), splitCount: $("#split-count"), downloadPdfs: $("#download-all-pdfs"),
  imagePanel: $("#image-panel"), imageFormat: $("#image-format"), imageScale: $("#image-scale"), imageTitle: $("#image-selection-title"), imageCopy: $("#image-selection-copy"), downloadImages: $("#download-images"),
  compressPanel: $("#compress-panel"), compressionList: $("#compression-list"), compressSummary: $("#compress-summary"), compressPdf: $("#compress-pdf"), overlay: $("#loading-overlay"), loadingTitle: $("#loading-title"), loadingDetail: $("#loading-detail"), toast: $("#toast")
};

const librariesReady = Boolean(window.pdfjsLib && window.PDFLib && window.JSZip);
if (librariesReady) pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf-tools/pdf.worker.min.js";

let toastTimer;
function notify(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle("is-error", isError);
  elements.toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => elements.toast.classList.remove("is-visible"), message.length > 32 ? 5200 : 3200);
}

function setBusy(busy, title = "正在处理", detail = "请不要关闭页面") {
  state.busy = busy;
  elements.overlay.hidden = !busy;
  elements.loadingTitle.textContent = title;
  elements.loadingDetail.textContent = detail;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(.1, bytes / 1024).toFixed(bytes < 100 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 2 : 1)} MB`;
}

function safeName(name, fallback = "document") {
  return (String(name || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").trim() || fallback).slice(0, 120);
}

function currentDocument() { return state.documents[state.currentIndex] || null; }
function documentId() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`; }
function archiveFolder(document) { return `${String(state.documents.indexOf(document) + 1).padStart(2, "0")}-${safeName(document.baseName)}`; }

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1600);
}

function parsePageRange(value, pageCount) {
  const input = String(value || "").replace(/，/g, ",").trim();
  if (!input) return [];
  const pages = new Set();
  for (const rawPart of input.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;
    const match = part.match(/^(\d+)\s*(?:[-—~]\s*(\d+))?$/);
    if (!match) throw new Error(`无法识别页码“${part}”，请使用 1-3, 6 这样的格式。`);
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    if (start < 1 || end < 1 || start > end || end > pageCount) throw new Error(`页码“${part}”超出范围，当前 PDF 共 ${pageCount} 页。`);
    for (let page = start; page <= end; page += 1) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

function compactPages(pages) {
  if (!pages.length) return "";
  const values = [...new Set(pages)].sort((a, b) => a - b);
  const parts = [];
  let start = values[0];
  let previous = values[0];
  for (let index = 1; index <= values.length; index += 1) {
    const current = values[index];
    if (current === previous + 1) { previous = current; continue; }
    parts.push(start === previous ? String(start) : `${start}-${previous}`);
    start = current;
    previous = current;
  }
  return parts.join(", ");
}

function pdfLoadError(error) {
  if (error?.name === "PasswordException") return "文件已加密，暂不支持处理加密 PDF。";
  if (error?.name === "InvalidPDFException") return "文件已损坏或格式不完整。";
  if (error?.name === "NotReadableError") return "浏览器无法读取文件，请确认文件未被移动或占用。";
  if (/^(文件内容|PDF 共|PDF 读取超时)/.test(error?.message || "")) return error.message;
  return "PDF 读取失败，请确认文件完整。";
}

function operationError(error, fallback) {
  return /^(无法识别页码|页码“|拆分项|第 \d+ 页尺寸|图片生成失败)/.test(error?.message || "") ? error.message : fallback;
}

async function destroyDocuments() {
  const documents = state.documents;
  state.documents = [];
  state.currentIndex = 0;
  await Promise.all(documents.map(async (document) => {
    try { await document.pdf?.destroy(); } catch { /* 已释放或尚未加载完成 */ }
  }));
}

function enterMode(mode) {
  if (!MODE_COPY[mode]) return;
  state.mode = mode;
  elements.entries.hidden = true;
  elements.shell.hidden = false;
  elements.uploadView.hidden = false;
  elements.workspace.hidden = true;
  elements.workbenchTitle.textContent = MODE_COPY[mode].title;
  elements.uploadKicker.textContent = MODE_COPY[mode].kicker;
  elements.workspaceModeTitle.textContent = MODE_COPY[mode].title;
  elements.shell.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function returnToEntries() {
  if (state.busy) return;
  await destroyDocuments();
  state.mode = null;
  elements.input.value = "";
  elements.shell.hidden = true;
  elements.entries.hidden = false;
  elements.entries.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function resetUpload() {
  if (state.busy) return;
  await destroyDocuments();
  elements.input.value = "";
  elements.workspace.hidden = true;
  elements.uploadView.hidden = false;
}

async function loadPdfFile(file) {
  const buffer = await file.arrayBuffer();
  const header = new TextDecoder("latin1").decode(buffer.slice(0, 5));
  if (header !== "%PDF-") throw new Error("文件内容不是有效的 PDF。 ");
  const bytes = new Uint8Array(buffer);
  const loadingTask = pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false });
  let timer;
  const timeout = new Promise((_, reject) => { timer = window.setTimeout(() => { loadingTask.destroy(); reject(new Error("PDF 读取超时，请换一份文件重试。")); }, 30000); });
  let pdf;
  try { pdf = await Promise.race([loadingTask.promise, timeout]); }
  finally { window.clearTimeout(timer); }
  if (!pdf.numPages) throw new Error("文件没有可处理的页面。 ");
  if (pdf.numPages > LIMITS.maxPages) { await pdf.destroy(); throw new Error(`PDF 共 ${pdf.numPages} 页，超过 500 页上限。`); }
  return {
    id: documentId(), file, bytes, pdf, pageCount: pdf.numPages,
    baseName: safeName(file.name.replace(/\.pdf$/i, "")),
    selected: new Set(Array.from({ length: pdf.numPages }, (_, index) => index + 1)),
    previewPage: 1, splitItems: [], compression: null
  };
}

async function loadFiles(fileList) {
  if (state.busy) return;
  const received = [...fileList];
  if (!received.length) { notify("没有读取到文件，请重新选择 PDF。", true); return; }
  if (!librariesReady) { notify("PDF 组件加载失败，请检查网络后刷新页面。", true); return; }
  if (received.length > LIMITS.maxFiles) { notify(`一次最多选择 ${LIMITS.maxFiles} 份 PDF。`, true); return; }
  const pdfCandidates = received.filter((file) => /\.pdf$/i.test(file.name) || file.type === "application/pdf");
  if (!pdfCandidates.length) { notify("没有找到 PDF 文件，请选择扩展名为 .pdf 的文件。", true); return; }
  const totalBytes = pdfCandidates.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > LIMITS.maxTotalBytes) { notify(`所选文件共 ${formatBytes(totalBytes)}，超过 300MB 总上限。`, true); return; }

  await destroyDocuments();
  const accepted = [];
  const rejected = [];
  setBusy(true, "正在读取 PDF", `准备检查 ${pdfCandidates.length} 份文件`);
  try {
    for (let index = 0; index < pdfCandidates.length; index += 1) {
      const file = pdfCandidates[index];
      elements.loadingDetail.textContent = `正在读取第 ${index + 1} / ${pdfCandidates.length} 份：${file.name}`;
      if (file.size > LIMITS.maxFileBytes) { rejected.push(`${file.name}：超过 100MB`); continue; }
      try { accepted.push(await loadPdfFile(file)); }
      catch (error) { console.error("PDF 读取失败", file.name, error); rejected.push(`${file.name}：${pdfLoadError(error)}`); }
    }
  } finally { setBusy(false); }

  if (!accepted.length) {
    notify(rejected[0] || "没有可处理的 PDF 文件。", true);
    return;
  }
  state.documents = accepted;
  state.currentIndex = 0;
  elements.uploadView.hidden = true;
  elements.workspace.hidden = false;
  renderWorkspace();
  if (received.length !== pdfCandidates.length || rejected.length) {
    const ignored = received.length - pdfCandidates.length;
    const notices = [];
    if (ignored) notices.push(`忽略 ${ignored} 个非 PDF 文件`);
    if (rejected.length) notices.push(`跳过 ${rejected.length} 份无法处理的 PDF`);
    notify(notices.join("；"), true);
  }
}

function renderWorkspace() {
  const count = state.documents.length;
  elements.workspaceFileCount.textContent = `${count} 份文件`;
  elements.fileCount.textContent = String(count);
  elements.pageWorkspace.hidden = state.mode === "compress";
  elements.splitPanel.hidden = state.mode !== "split";
  elements.imagePanel.hidden = state.mode !== "image";
  elements.compressPanel.hidden = state.mode !== "compress";
  renderFileList();
  if (state.mode === "compress") renderCompressionList();
  else renderCurrentDocument();
}

function fileStatus(document) {
  if (state.mode === "split") return `${document.splitItems.length} 个拆分项`;
  if (state.mode === "image") return `已选 ${document.selected.size} / ${document.pageCount} 页`;
  return document.compression ? `${formatBytes(document.file.size)} → ${formatBytes(document.compression.size)}` : `源文件 ${formatBytes(document.file.size)}`;
}

function renderFileList() {
  elements.fileList.replaceChildren();
  const fragment = document.createDocumentFragment();
  state.documents.forEach((pdfDocument, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "file-item";
    button.classList.toggle("is-active", index === state.currentIndex);
    if (index === state.currentIndex) button.setAttribute("aria-current", "page");
    button.setAttribute("aria-label", `打开 ${pdfDocument.file.name}`);
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    const meta = document.createElement("small");
    title.textContent = pdfDocument.file.name;
    meta.textContent = fileStatus(pdfDocument);
    copy.append(title, meta);
    button.appendChild(copy);
    button.addEventListener("click", () => {
      if (index === state.currentIndex) return;
      state.currentIndex = index;
      renderFileList();
      if (state.mode !== "compress") renderCurrentDocument();
    });
    fragment.appendChild(button);
  });
  elements.fileList.appendChild(fragment);
}

function renderCurrentDocument() {
  const document = currentDocument();
  if (!document) return;
  elements.fileName.textContent = document.file.name;
  elements.fileMeta.textContent = `${document.pageCount} 页 · ${formatBytes(document.file.size)}`;
  renderPageGrid();
  refreshSelectionUi();
  if (state.mode === "split") renderSplitList();
}

async function renderThumbnail(document, pageNumber, canvas) {
  try {
    const page = await document.pdf.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(145 / base.width, 170 / base.height);
    const viewport = page.getViewport({ scale });
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.ceil(viewport.width * ratio);
    canvas.height = Math.ceil(viewport.height * ratio);
    const context = canvas.getContext("2d", { alpha: false });
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    await page.render({ canvasContext: context, viewport, background: "white" }).promise;
  } catch (error) {
    console.error("页面缩略图渲染失败", document.file.name, pageNumber, error);
    canvas.parentElement?.classList.add("thumbnail-failed");
  }
}

function pageBounds(document) {
  const totalViews = Math.max(1, Math.ceil(document.pageCount / LIMITS.pagesPerView));
  document.previewPage = Math.min(Math.max(document.previewPage, 1), totalViews);
  const start = (document.previewPage - 1) * LIMITS.pagesPerView + 1;
  const end = Math.min(start + LIMITS.pagesPerView - 1, document.pageCount);
  return { totalViews, start, end };
}

function createPageCard(document, pageNumber) {
  const card = documentElement("button", "page-card");
  card.type = "button";
  card.dataset.page = String(pageNumber);
  card.classList.toggle("is-selected", document.selected.has(pageNumber));
  card.setAttribute("aria-label", `第 ${pageNumber} 页，${document.selected.has(pageNumber) ? "已选择" : "未选择"}`);
  card.innerHTML = `<span class="page-check">✓</span><canvas aria-hidden="true"></canvas><span class="page-number">${pageNumber}</span>`;
  card.addEventListener("pointerdown", (event) => beginDragSelection(event, document, pageNumber));
  card.addEventListener("click", () => {
    if (state.ignoreNextClick) { state.ignoreNextClick = false; return; }
    togglePage(document, pageNumber);
  });
  return card;
}

function documentElement(tag, className) {
  const element = window.document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function renderPageGrid() {
  const document = currentDocument();
  if (!document) return;
  const { totalViews, start, end } = pageBounds(document);
  elements.pageGrid.replaceChildren();
  const fragment = window.document.createDocumentFragment();
  const cards = [];
  for (let page = start; page <= end; page += 1) {
    const card = createPageCard(document, page);
    cards.push(card);
    fragment.appendChild(card);
  }
  elements.pageGrid.appendChild(fragment);
  cards.forEach((card) => renderThumbnail(document, Number(card.dataset.page), card.querySelector("canvas")));
  elements.pageWindowLabel.textContent = `第 ${start}–${end} 页`;
  elements.paginationLabel.textContent = `${document.previewPage} / ${totalViews}`;
  elements.previousSet.disabled = document.previewPage <= 1;
  elements.nextSet.disabled = document.previewPage >= totalViews;
}

function updateCardState(document, pageNumber) {
  const card = elements.pageGrid.querySelector(`[data-page="${pageNumber}"]`);
  if (!card) return;
  const selected = document.selected.has(pageNumber);
  card.classList.toggle("is-selected", selected);
  card.setAttribute("aria-label", `第 ${pageNumber} 页，${selected ? "已选择" : "未选择"}`);
}

function setPageSelection(document, pageNumber, selected) {
  if (selected) document.selected.add(pageNumber);
  else document.selected.delete(pageNumber);
  updateCardState(document, pageNumber);
}

function togglePage(document, pageNumber) {
  setPageSelection(document, pageNumber, !document.selected.has(pageNumber));
  refreshSelectionUi();
  renderFileList();
}

function beginDragSelection(event, document, pageNumber) {
  if (event.pointerType !== "mouse" || event.button !== 0) return;
  event.preventDefault();
  state.drag = { pointerId: event.pointerId, documentId: document.id, selecting: !document.selected.has(pageNumber), visited: new Set() };
  state.ignoreNextClick = true;
  try { elements.pageGrid.setPointerCapture?.(event.pointerId); } catch { /* 合成事件或旧浏览器不支持捕获，仍可继续划选 */ }
  applyDragPage(document, pageNumber);
}

function applyDragPage(document, pageNumber) {
  if (!state.drag || state.drag.documentId !== document.id || state.drag.visited.has(pageNumber)) return;
  state.drag.visited.add(pageNumber);
  setPageSelection(document, pageNumber, state.drag.selecting);
  refreshSelectionUi();
}

function moveDragSelection(event) {
  if (!state.drag || event.pointerId !== state.drag.pointerId) return;
  const target = window.document.elementFromPoint(event.clientX, event.clientY)?.closest(".page-card");
  if (!target || !elements.pageGrid.contains(target)) return;
  const document = currentDocument();
  if (document) applyDragPage(document, Number(target.dataset.page));
}

function finishDragSelection(event) {
  if (!state.drag || (event.pointerId !== undefined && event.pointerId !== state.drag.pointerId)) return;
  state.drag = null;
  renderFileList();
  window.setTimeout(() => { state.ignoreNextClick = false; }, 0);
}

function totalSelectedPages() { return state.documents.reduce((sum, document) => sum + document.selected.size, 0); }

function refreshSelectionUi() {
  const document = currentDocument();
  if (!document) return;
  const sorted = [...document.selected].sort((a, b) => a - b);
  elements.pageInput.value = compactPages(sorted);
  elements.selectedCount.textContent = `已选 ${sorted.length} / ${document.pageCount} 页`;
  if (state.mode === "image") {
    const total = totalSelectedPages();
    elements.imageTitle.textContent = total ? `全部文件共选择 ${total} 页` : "尚未选择页面";
    elements.imageCopy.textContent = `${document.file.name}：${sorted.length ? compactPages(sorted) : "未选择"}`;
    elements.downloadImages.disabled = !total;
    elements.downloadImages.textContent = total === 1 ? "下载所选图片" : `打包下载 ${total} 张图片`;
  }
}

function quickSelect(mode) {
  const document = currentDocument();
  if (!document) return;
  const pages = Array.from({ length: document.pageCount }, (_, index) => index + 1).filter((page) => mode === "all" || (mode === "odd" && page % 2) || (mode === "even" && !(page % 2)));
  document.selected = new Set(mode === "none" ? [] : pages);
  renderPageGrid();
  refreshSelectionUi();
  renderFileList();
}

function goToPreviewPage(offset) {
  const document = currentDocument();
  if (!document) return;
  document.previewPage += offset;
  renderPageGrid();
  elements.pageGrid.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function makeSplitItem(document, pages, name) {
  return { id: documentId(), pages: compactPages(pages), name: safeName(name) };
}

function totalSplitItems() { return state.documents.reduce((sum, document) => sum + document.splitItems.length, 0); }

function addSelectedSplit() {
  const document = currentDocument();
  if (!document) return;
  const pages = [...document.selected].sort((a, b) => a - b);
  if (!pages.length) { notify("请先为当前 PDF 选择至少一页。", true); return; }
  if (totalSplitItems() >= LIMITS.maxSplitItems) { notify("全部文件最多添加 500 个拆分项。", true); return; }
  document.splitItems.push(makeSplitItem(document, pages, `${document.baseName}-${compactPages(pages).replace(/, /g, "_")}`));
  renderSplitList();
  renderFileList();
  notify("已把当前 PDF 的所选页面加入拆分列表。 ");
}

function splitEveryPage() {
  const document = currentDocument();
  if (!document) return;
  const otherCount = totalSplitItems() - document.splitItems.length;
  if (otherCount + document.pageCount > LIMITS.maxSplitItems) { notify("拆分后会超过 500 个输出文件，请减少其他拆分项。", true); return; }
  document.splitItems = Array.from({ length: document.pageCount }, (_, index) => makeSplitItem(document, [index + 1], `${document.baseName}-第${index + 1}页`));
  renderSplitList();
  renderFileList();
  notify(`当前 PDF 已生成 ${document.pageCount} 个单页拆分项。`);
}

function validateSplitItem(document, item) {
  const pages = parsePageRange(item.pages, document.pageCount);
  if (!pages.length) throw new Error("拆分项的页码不能为空。");
  const name = safeName(item.name, `${document.baseName}-拆分`).replace(/\.pdf$/i, "");
  return { pages, name: `${name}.pdf` };
}

function renderSplitList() {
  const document = currentDocument();
  elements.splitList.replaceChildren();
  if (!document) return;
  document.splitItems.forEach((item, index) => {
    const row = documentElement("div", "split-item");
    row.innerHTML = `<label class="field">文件名<input class="name-input" maxlength="120"></label><label class="field">包含页码<input class="pages-input"></label><button class="item-button download-one" type="button">下载</button><button class="item-button remove-button" type="button" aria-label="删除第 ${index + 1} 项">删除</button>`;
    const nameInput = row.querySelector(".name-input");
    const pagesInput = row.querySelector(".pages-input");
    nameInput.value = item.name;
    pagesInput.value = item.pages;
    nameInput.addEventListener("input", (event) => { item.name = event.target.value; });
    pagesInput.addEventListener("input", (event) => { item.pages = event.target.value; pagesInput.removeAttribute("aria-invalid"); });
    pagesInput.addEventListener("blur", () => {
      try { validateSplitItem(document, item); pagesInput.setAttribute("aria-invalid", "false"); }
      catch (error) { pagesInput.setAttribute("aria-invalid", "true"); notify(operationError(error, "页码格式有误，请使用 1-3, 6 这样的格式。"), true); }
    });
    row.querySelector(".download-one").addEventListener("click", () => downloadOnePdf(document, item));
    row.querySelector(".remove-button").addEventListener("click", () => { document.splitItems = document.splitItems.filter((entry) => entry.id !== item.id); renderSplitList(); renderFileList(); });
    elements.splitList.appendChild(row);
  });
  const total = totalSplitItems();
  elements.splitEmpty.hidden = document.splitItems.length > 0;
  elements.splitBar.hidden = total === 0;
  elements.splitCount.textContent = String(total);
}

async function buildSplitPdf(source, pages) {
  const output = await PDFLib.PDFDocument.create();
  const copied = await output.copyPages(source, pages.map((page) => page - 1));
  copied.forEach((page) => output.addPage(page));
  return output.save({ useObjectStreams: true });
}

async function downloadOnePdf(document, item) {
  if (state.busy) return;
  setBusy(true, "正在生成 PDF", `${document.file.name} · 本地拆分中`);
  try {
    const target = validateSplitItem(document, item);
    const source = await PDFLib.PDFDocument.load(document.bytes, { updateMetadata: false });
    const bytes = await buildSplitPdf(source, target.pages);
    downloadBlob(new Blob([bytes], { type: "application/pdf" }), target.name);
    notify(`已生成 ${target.name}`);
  } catch (error) { console.error("PDF 拆分失败", error); notify(operationError(error, "PDF 拆分失败，请检查页码或原文件。"), true); }
  finally { setBusy(false); }
}

async function downloadAllPdfs() {
  if (state.busy || !totalSplitItems()) return;
  setBusy(true, "正在打包 PDF", `准备生成 ${totalSplitItems()} 份文件`);
  try {
    const zip = new JSZip();
    const seen = new Map();
    let completed = 0;
    for (const document of state.documents) {
      if (!document.splitItems.length) continue;
      const source = await PDFLib.PDFDocument.load(document.bytes, { updateMetadata: false });
      const folder = zip.folder(archiveFolder(document));
      for (const item of document.splitItems) {
        const target = validateSplitItem(document, item);
        completed += 1;
        elements.loadingDetail.textContent = `正在生成第 ${completed} / ${totalSplitItems()} 份`;
        let name = target.name;
        const key = `${document.id}/${name}`;
        const count = seen.get(key) || 0;
        seen.set(key, count + 1);
        if (count) name = name.replace(/\.pdf$/i, `-${count + 1}.pdf`);
        folder.file(name, await buildSplitPdf(source, target.pages));
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    }
    elements.loadingDetail.textContent = "正在压缩打包文件";
    downloadBlob(await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 5 } }), "PDF-拆分结果.zip");
    notify(`已打包 ${totalSplitItems()} 份 PDF。`);
  } catch (error) { console.error("PDF 打包失败", error); notify(operationError(error, "PDF 打包失败，请减少拆分数量后重试。"), true); }
  finally { setBusy(false); }
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("图片生成失败，浏览器内存可能不足。")), type, quality));
}

async function renderPageCanvas(document, pageNumber, scale, format = "jpeg") {
  const page = await document.pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  if (viewport.width * viewport.height > LIMITS.maxCanvasPixels) throw new Error(`第 ${pageNumber} 页尺寸过大，请降低清晰度后重试。`);
  const canvas = documentElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d", { alpha: format === "png" });
  if (format === "jpeg") { context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height); }
  await page.render({ canvasContext: context, viewport, background: format === "jpeg" ? "white" : undefined }).promise;
  return { canvas, page };
}

async function renderPageImage(document, pageNumber, format, scale) {
  const { canvas } = await renderPageCanvas(document, pageNumber, scale, format);
  return canvasToBlob(canvas, format === "jpeg" ? "image/jpeg" : "image/png", .92);
}

async function downloadImages() {
  if (state.busy) return;
  const targets = state.documents.flatMap((document) => [...document.selected].sort((a,b) => a-b).map((page) => ({ document, page })));
  if (!targets.length) { notify("请先为至少一份 PDF 选择页面。", true); return; }
  const format = elements.imageFormat.value;
  const extension = format === "jpeg" ? "jpg" : "png";
  const scale = Number(elements.imageScale.value);
  setBusy(true, "正在转换图片", `准备处理 ${targets.length} 页`);
  try {
    if (targets.length === 1) {
      const target = targets[0];
      downloadBlob(await renderPageImage(target.document, target.page, format, scale), `${target.document.baseName}-第${target.page}页.${extension}`);
    } else {
      const zip = new JSZip();
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index];
        elements.loadingDetail.textContent = `正在处理第 ${index + 1} / ${targets.length} 页`;
        const digits = String(target.document.pageCount).length;
        zip.folder(archiveFolder(target.document)).file(`${target.document.baseName}-第${String(target.page).padStart(digits,"0")}页.${extension}`, await renderPageImage(target.document, target.page, format, scale));
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
      elements.loadingDetail.textContent = "正在压缩图片";
      downloadBlob(await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 4 } }), "PDF-图片.zip");
    }
    notify(`已完成 ${targets.length} 页图片转换。`);
  } catch (error) { console.error("PDF 转图片失败", error); notify(operationError(error, "图片转换失败，请减少页数或降低清晰度。"), true); }
  finally { setBusy(false); }
}

function compressionRatio(original, compressed) { return original ? Math.round((1 - compressed / original) * 100) : 0; }

function renderCompressionList() {
  elements.compressionList.replaceChildren();
  for (const document of state.documents) {
    const row = documentElement("div", "compression-row");
    const identity = documentElement("div");
    const name = documentElement("strong");
    const pages = documentElement("small");
    name.textContent = document.file.name;
    pages.textContent = `${document.pageCount} 页`;
    identity.append(name, pages);
    const source = documentElement("div", "size-comparison");
    const original = documentElement("b");
    original.textContent = formatBytes(document.file.size);
    source.append("源文件 ", original);
    const result = documentElement("div", "size-comparison");
    if (document.compression) {
      const compressed = documentElement("b");
      const ratio = compressionRatio(document.file.size, document.compression.size);
      const change = documentElement("em");
      compressed.textContent = formatBytes(document.compression.size);
      change.textContent = ratio >= 0 ? `减少 ${ratio}%` : `增加 ${Math.abs(ratio)}%`;
      result.append("压缩后 ", compressed, change);
    } else {
      result.classList.add("size-pending");
      result.textContent = "压缩后：等待处理";
    }
    row.append(identity, source, result);
    elements.compressionList.appendChild(row);
  }
  const originalTotal = state.documents.reduce((sum, document) => sum + document.file.size, 0);
  const allComplete = state.documents.length && state.documents.every((document) => document.compression);
  if (allComplete) {
    const compressedTotal = state.documents.reduce((sum, document) => sum + document.compression.size, 0);
    const ratio = compressionRatio(originalTotal, compressedTotal);
    elements.compressSummary.textContent = `源文件共 ${formatBytes(originalTotal)}，压缩后共 ${formatBytes(compressedTotal)}，${ratio >= 0 ? `减少 ${ratio}%` : `增加 ${Math.abs(ratio)}%`}。`;
    elements.compressPdf.textContent = "重新压缩并下载";
  } else {
    elements.compressSummary.textContent = `源文件共 ${formatBytes(originalTotal)}；压缩完成后会在上方逐份显示结果。`;
    elements.compressPdf.textContent = `压缩 ${state.documents.length} 份 PDF`;
  }
  renderFileList();
}

async function compressDocument(document, preset) {
  const output = await PDFLib.PDFDocument.create();
  output.setTitle(document.baseName);
  output.setCreator("ToolBox PDF 工具");
  for (let pageNumber = 1; pageNumber <= document.pageCount; pageNumber += 1) {
    const { canvas, page } = await renderPageCanvas(document, pageNumber, preset.scale, "jpeg");
    const jpegBlob = await canvasToBlob(canvas, "image/jpeg", preset.quality);
    const image = await output.embedJpg(await jpegBlob.arrayBuffer());
    const originalViewport = page.getViewport({ scale: 1 });
    const outputPage = output.addPage([originalViewport.width, originalViewport.height]);
    outputPage.drawImage(image, { x: 0, y: 0, width: originalViewport.width, height: originalViewport.height });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  const bytes = await output.save({ useObjectStreams: true });
  return { bytes, blob: new Blob([bytes], { type: "application/pdf" }), size: bytes.byteLength };
}

async function compressAll() {
  if (state.busy || !state.documents.length) return;
  const presetName = document.querySelector('input[name="compress-preset"]:checked')?.value || "balanced";
  const preset = PRESETS[presetName];
  setBusy(true, "正在压缩 PDF", `准备处理 ${state.documents.length} 份文件`);
  try {
    for (let documentIndex = 0; documentIndex < state.documents.length; documentIndex += 1) {
      const document = state.documents[documentIndex];
      elements.loadingDetail.textContent = `第 ${documentIndex + 1} / ${state.documents.length} 份：${document.file.name}`;
      document.compression = await compressDocument(document, preset);
      renderCompressionList();
    }
    if (state.documents.length === 1) {
      const document = state.documents[0];
      downloadBlob(document.compression.blob, `${document.baseName}-压缩.pdf`);
    } else {
      elements.loadingDetail.textContent = "正在打包压缩后的 PDF";
      const zip = new JSZip();
      const seen = new Map();
      state.documents.forEach((document) => {
        let name = `${document.baseName}-压缩.pdf`;
        const count = seen.get(name) || 0;
        seen.set(name, count + 1);
        if (count) name = name.replace(/\.pdf$/i, `-${count + 1}.pdf`);
        zip.file(name, document.compression.bytes);
      });
      downloadBlob(await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 4 } }), "PDF-压缩结果.zip");
    }
    const originalTotal = state.documents.reduce((sum, document) => sum + document.file.size, 0);
    const compressedTotal = state.documents.reduce((sum, document) => sum + document.compression.size, 0);
    notify(`压缩完成：${formatBytes(originalTotal)} → ${formatBytes(compressedTotal)}`);
  } catch (error) { console.error("PDF 压缩失败", error); notify(operationError(error, "PDF 压缩失败，请降低档位或减少文件数量。"), true); }
  finally { setBusy(false); renderCompressionList(); }
}

document.querySelectorAll("[data-enter-mode]").forEach((button) => button.addEventListener("click", () => enterMode(button.dataset.enterMode)));
elements.modeBack.addEventListener("click", returnToEntries);
elements.changeFiles.addEventListener("click", resetUpload);
elements.input.addEventListener("change", (event) => loadFiles(event.target.files));
elements.dropZone.addEventListener("dragover", (event) => { event.preventDefault(); elements.dropZone.classList.add("is-dragging"); });
elements.dropZone.addEventListener("dragleave", () => elements.dropZone.classList.remove("is-dragging"));
elements.dropZone.addEventListener("drop", (event) => { event.preventDefault(); elements.dropZone.classList.remove("is-dragging"); loadFiles(event.dataTransfer.files); });
document.querySelectorAll("[data-select]").forEach((button) => button.addEventListener("click", () => quickSelect(button.dataset.select)));
elements.pageInput.addEventListener("change", () => {
  const document = currentDocument();
  if (!document) return;
  try {
    const pages = parsePageRange(elements.pageInput.value, document.pageCount);
    document.selected = new Set(pages);
    if (pages.length) document.previewPage = Math.ceil(pages[0] / LIMITS.pagesPerView);
    renderPageGrid();
    refreshSelectionUi();
    renderFileList();
  } catch (error) { notify(error.message, true); elements.pageInput.value = compactPages([...document.selected]); }
});
elements.pageInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); elements.pageInput.blur(); } });
elements.previousSet.addEventListener("click", () => goToPreviewPage(-1));
elements.nextSet.addEventListener("click", () => goToPreviewPage(1));
elements.pageGrid.addEventListener("pointermove", moveDragSelection);
elements.pageGrid.addEventListener("pointerup", finishDragSelection);
elements.pageGrid.addEventListener("pointercancel", finishDragSelection);
elements.pageGrid.addEventListener("lostpointercapture", finishDragSelection);
elements.addSplit.addEventListener("click", addSelectedSplit);
elements.splitSingle.addEventListener("click", splitEveryPage);
elements.downloadPdfs.addEventListener("click", downloadAllPdfs);
elements.downloadImages.addEventListener("click", downloadImages);
elements.compressPdf.addEventListener("click", compressAll);
document.querySelectorAll('input[name="compress-preset"]').forEach((input) => input.addEventListener("change", () => {
  document.querySelectorAll(".preset-grid label").forEach((label) => label.classList.toggle("is-selected", label.contains(input)));
  state.documents.forEach((document) => { document.compression = null; });
  if (state.mode === "compress") renderCompressionList();
}));

if (!librariesReady) window.setTimeout(() => notify("PDF 组件加载失败，请检查网络后刷新页面。", true), 300);
