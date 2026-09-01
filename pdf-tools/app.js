/* global pdfjsLib, PDFLib, JSZip */

const LIMITS = { maxBytes: 100 * 1024 * 1024, maxPages: 500, maxSplitItems: 500, maxCanvasPixels: 40_000_000 };
const PRESETS = { small: { scale: 1.2, quality: 0.52 }, balanced: { scale: 1.5, quality: 0.68 }, clear: { scale: 2, quality: 0.82 } };
const state = { file: null, bytes: null, pdf: null, pageCount: 0, baseName: "document", selected: new Set(), splitItems: [], busy: false };
const $ = (selector) => document.querySelector(selector);
const elements = {
  input: $("#pdf-input"), dropZone: $("#drop-zone"), uploadView: $("#upload-view"), editorView: $("#editor-view"), fileName: $("#file-name"), fileMeta: $("#file-meta"), changeFile: $("#change-file"), film: $("#page-film"), pageInput: $("#selected-pages"), selectedCount: $("#selected-count"),
  tabs: [...document.querySelectorAll(".mode-tab")], panels: [...document.querySelectorAll(".tool-panel")], addSplit: $("#add-split"), splitSingle: $("#split-single"), splitList: $("#split-list"), splitEmpty: $("#split-empty"), splitBar: $("#split-download-bar"), splitCount: $("#split-count"), downloadPdfs: $("#download-all-pdfs"),
  imageFormat: $("#image-format"), imageScale: $("#image-scale"), imageTitle: $("#image-selection-title"), imageCopy: $("#image-selection-copy"), downloadImages: $("#download-images"), compressPdf: $("#compress-pdf"), compressSummary: $("#compress-summary"), overlay: $("#loading-overlay"), loadingTitle: $("#loading-title"), loadingDetail: $("#loading-detail"), toast: $("#toast")
};

const librariesReady = Boolean(window.pdfjsLib && window.PDFLib && window.JSZip);
if (librariesReady) pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf-tools/pdf.worker.min.js";

let toastTimer;
function notify(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle("is-error", isError);
  elements.toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => elements.toast.classList.remove("is-visible"), message.length > 30 ? 5000 : 3200);
}

function setBusy(busy, title = "正在处理", detail = "请不要关闭页面") {
  state.busy = busy; elements.overlay.hidden = !busy; elements.loadingTitle.textContent = title; elements.loadingDetail.textContent = detail;
}

function formatBytes(bytes) { return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function safeName(name, fallback = "document") { return (String(name || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").trim() || fallback).slice(0, 120); }
function pdfLoadError(error) {
  if (error?.name === "PasswordException") return "这份 PDF 已加密，当前工具暂不支持处理加密文件。";
  if (error?.name === "InvalidPDFException") return "这份 PDF 已损坏或格式不完整，请换用原始文件重试。";
  if (error?.name === "NotReadableError") return "浏览器无法读取这份文件，请确认文件未被移动或占用。";
  if (error?.name === "AbortError") return "文件读取已取消，请重新选择 PDF。";
  if (/^(文件内容|这份 PDF|PDF 共|PDF 读取超时)/.test(error?.message || "")) return error.message;
  return "PDF 读取失败，请确认文件完整后重新选择。";
}
function operationError(error, fallback) {
  return /^(无法识别页码|页码“|拆分项|第 \d+ 页尺寸|图片生成失败)/.test(error?.message || "") ? error.message : fallback;
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function parsePageRange(value, pageCount = state.pageCount) {
  const input = String(value || "").replace(/，/g, ",").trim();
  if (!input) return [];
  const pages = new Set();
  for (const rawPart of input.split(",")) {
    const part = rawPart.trim(); if (!part) continue;
    const match = part.match(/^(\d+)\s*(?:[-—~]\s*(\d+))?$/);
    if (!match) throw new Error(`无法识别页码“${part}”，请使用 1-3, 6 这样的格式。`);
    const start = Number(match[1]); const end = Number(match[2] || match[1]);
    if (start < 1 || end < 1 || start > end || end > pageCount) throw new Error(`页码“${part}”超出范围，当前 PDF 共 ${pageCount} 页。`);
    for (let page = start; page <= end; page += 1) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

function compactPages(pages) {
  if (!pages.length) return "";
  const values = [...new Set(pages)].sort((a, b) => a - b); const parts = []; let start = values[0]; let previous = values[0];
  for (let i = 1; i <= values.length; i += 1) { const current = values[i]; if (current === previous + 1) { previous = current; continue; } parts.push(start === previous ? String(start) : `${start}-${previous}`); start = current; previous = current; }
  return parts.join(", ");
}

function updateSelection(pages, scroll = false) {
  state.selected = new Set(pages);
  elements.film.querySelectorAll(".page-card").forEach((card) => { const selected = state.selected.has(Number(card.dataset.page)); card.classList.toggle("is-selected", selected); card.setAttribute("aria-label", `第 ${card.dataset.page} 页，${selected ? "已选择" : "未选择"}`); });
  const sorted = [...state.selected].sort((a, b) => a - b); elements.pageInput.value = compactPages(sorted); elements.selectedCount.textContent = `已选 ${sorted.length} 页`;
  elements.imageTitle.textContent = sorted.length ? `将导出 ${sorted.length} 张图片` : "尚未选择页面"; elements.imageCopy.textContent = sorted.length ? `页码：${compactPages(sorted)}` : "在上方页码胶片中勾选需要转换的页面。"; elements.downloadImages.disabled = !sorted.length; elements.downloadImages.textContent = sorted.length <= 1 ? "下载所选图片" : `打包下载 ${sorted.length} 张图片`;
  if (scroll && sorted.length) elements.film.querySelector(`[data-page="${sorted[0]}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
}

async function renderThumbnail(pageNumber, canvas) {
  try { const page = await state.pdf.getPage(pageNumber); const base = page.getViewport({ scale: 1 }); const scale = Math.min(106 / base.width, 140 / base.height); const viewport = page.getViewport({ scale }); const ratio = Math.min(window.devicePixelRatio || 1, 2); canvas.width = Math.ceil(viewport.width * ratio); canvas.height = Math.ceil(viewport.height * ratio); const context = canvas.getContext("2d", { alpha: false }); context.setTransform(ratio, 0, 0, ratio, 0, 0); await page.render({ canvasContext: context, viewport, background: "white" }).promise; }
  catch (error) { console.error("页面缩略图渲染失败", pageNumber, error); canvas.dataset.failed = "true"; canvas.parentElement?.classList.add("thumbnail-failed"); }
}

function buildFilm() {
  elements.film.replaceChildren(); const cards = []; const fragment = document.createDocumentFragment();
  for (let page = 1; page <= state.pageCount; page += 1) { const card = document.createElement("button"); card.type = "button"; card.className = "page-card is-selected"; card.dataset.page = String(page); card.setAttribute("aria-label", `第 ${page} 页，已选择`); card.innerHTML = `<span class="page-check">✓</span><canvas aria-hidden="true"></canvas><span class="page-number">${page}</span>`; card.addEventListener("click", () => { const next = new Set(state.selected); if (next.has(page)) next.delete(page); else next.add(page); updateSelection([...next]); }); cards.push(card); fragment.appendChild(card); }
  elements.film.appendChild(fragment);
  if ("IntersectionObserver" in window) { const observer = new IntersectionObserver((entries, instance) => entries.forEach((entry) => { if (!entry.isIntersecting) return; renderThumbnail(Number(entry.target.dataset.page), entry.target.querySelector("canvas")); instance.unobserve(entry.target); }), { root: elements.film, rootMargin: "240px" }); cards.forEach((card) => observer.observe(card)); }
  else cards.forEach((card) => renderThumbnail(Number(card.dataset.page), card.querySelector("canvas")));
}

function resetWorkspace() {
  state.pdf?.destroy(); state.file = null; state.bytes = null; state.pdf = null; state.pageCount = 0; state.selected.clear(); state.splitItems = []; elements.input.value = ""; elements.film.replaceChildren(); renderSplitList(); elements.editorView.hidden = true; elements.uploadView.hidden = false;
}

async function loadPdf(file) {
  if (state.busy || !file) return;
  if (!librariesReady) { notify("PDF 组件加载失败，请检查网络后刷新页面。", true); return; }
  if (file.size > LIMITS.maxBytes) { notify("文件超过 100MB，请选择更小的 PDF。", true); return; }
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") { notify("这里只能处理 PDF 文件。", true); return; }
  setBusy(true, "正在读取 PDF", "正在检查文件并生成页面索引");
  try {
    const buffer = await file.arrayBuffer(); const header = new TextDecoder("latin1").decode(buffer.slice(0, 5)); if (header !== "%PDF-") throw new Error("文件内容不是有效的 PDF，请确认文件没有被错误改名。");
    const bytes = new Uint8Array(buffer); const loadingTask = pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }); let loadTimer;
    const loadTimeout = new Promise((_, reject) => { loadTimer = window.setTimeout(() => { loadingTask.destroy(); reject(new Error("PDF 读取超时，请刷新页面或换一份文件重试。")); }, 30000); });
    let pdf; try { pdf = await Promise.race([loadingTask.promise, loadTimeout]); } finally { window.clearTimeout(loadTimer); }
    if (!pdf.numPages) throw new Error("这份 PDF 没有可处理的页面。"); if (pdf.numPages > LIMITS.maxPages) { await pdf.destroy(); throw new Error(`PDF 共 ${pdf.numPages} 页，超过当前 500 页的处理上限。`); }
    state.file = file; state.bytes = bytes; state.pdf = pdf; state.pageCount = pdf.numPages; state.baseName = safeName(file.name.replace(/\.pdf$/i, "")); state.splitItems = [];
    elements.fileName.textContent = file.name; elements.fileMeta.textContent = `${pdf.numPages} 页 · ${formatBytes(file.size)}`; elements.uploadView.hidden = true; elements.editorView.hidden = false; buildFilm(); updateSelection(Array.from({ length: pdf.numPages }, (_, index) => index + 1)); renderSplitList();
  } catch (error) { console.error("PDF 读取失败", error); notify(pdfLoadError(error), true); }
  finally { setBusy(false); }
}

function switchMode(tab) { elements.tabs.forEach((item) => { const active = item === tab; item.classList.toggle("is-active", active); item.setAttribute("aria-selected", String(active)); }); elements.panels.forEach((panel) => { panel.hidden = panel.id !== tab.getAttribute("aria-controls"); }); }
function makeSplitItem(pages, name) { return { id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`, pages: compactPages(pages), name: safeName(name) }; }
function addSelectedSplit() { const pages = [...state.selected].sort((a, b) => a - b); if (!pages.length) { notify("请先勾选至少一页。", true); return; } if (state.splitItems.length >= LIMITS.maxSplitItems) { notify("拆分列表最多添加 500 份 PDF。", true); return; } state.splitItems.push(makeSplitItem(pages, `${state.baseName}-${compactPages(pages).replace(/, /g, "_")}`)); renderSplitList(); notify("已把所选页面加入拆分列表。"); }
function splitEveryPage() { state.splitItems = Array.from({ length: state.pageCount }, (_, index) => makeSplitItem([index + 1], `${state.baseName}-第${index + 1}页`)); renderSplitList(); notify(`已生成 ${state.pageCount} 份单页 PDF，可逐个修改文件名。`); }

function renderSplitList() {
  elements.splitList.replaceChildren();
  state.splitItems.forEach((item, index) => { const row = document.createElement("div"); row.className = "split-item"; row.innerHTML = `<label class="field">文件名<input class="name-input" maxlength="120"></label><label class="field">包含页码<input class="pages-input"></label><button class="item-button download-one" type="button">下载</button><button class="item-button remove-button" type="button" aria-label="删除第 ${index + 1} 项">删除</button>`; const nameInput = row.querySelector(".name-input"); const pagesInput = row.querySelector(".pages-input"); nameInput.value = item.name; pagesInput.value = item.pages; nameInput.addEventListener("input", (event) => { item.name = event.target.value; }); pagesInput.addEventListener("input", (event) => { item.pages = event.target.value; pagesInput.removeAttribute("aria-invalid"); }); pagesInput.addEventListener("blur", () => { try { if (!parsePageRange(item.pages).length) throw new Error("拆分项的页码不能为空。"); pagesInput.setAttribute("aria-invalid", "false"); } catch (error) { pagesInput.setAttribute("aria-invalid", "true"); notify(operationError(error, "页码格式有误，请使用 1-3, 6 这样的格式。"), true); } }); row.querySelector(".download-one").addEventListener("click", () => downloadOnePdf(item)); row.querySelector(".remove-button").addEventListener("click", () => { state.splitItems = state.splitItems.filter((entry) => entry.id !== item.id); renderSplitList(); }); elements.splitList.appendChild(row); });
  const hasItems = state.splitItems.length > 0; elements.splitEmpty.hidden = hasItems; elements.splitBar.hidden = !hasItems; elements.splitCount.textContent = String(state.splitItems.length);
}

function validateSplitItem(item) { const pages = parsePageRange(item.pages); if (!pages.length) throw new Error("拆分项的页码不能为空。"); const name = safeName(item.name, `${state.baseName}-拆分`).replace(/\.pdf$/i, ""); return { pages, name: `${name}.pdf` }; }
async function buildSplitPdf(source, pages) { const output = await PDFLib.PDFDocument.create(); const copied = await output.copyPages(source, pages.map((page) => page - 1)); copied.forEach((page) => output.addPage(page)); return output.save({ useObjectStreams: true }); }
async function downloadOnePdf(item) { if (state.busy) return; setBusy(true, "正在生成 PDF", "页面将在本地完成拆分"); try { const target = validateSplitItem(item); const source = await PDFLib.PDFDocument.load(state.bytes, { updateMetadata: false }); const bytes = await buildSplitPdf(source, target.pages); downloadBlob(new Blob([bytes], { type: "application/pdf" }), target.name); notify(`已生成 ${target.name}`); } catch (error) { console.error("PDF 拆分失败", error); notify(operationError(error, "PDF 拆分失败，请检查页码或换用原始文件重试。"), true); } finally { setBusy(false); } }
async function downloadAllPdfs() {
  if (state.busy || !state.splitItems.length) return; setBusy(true, "正在打包 PDF", `准备生成 ${state.splitItems.length} 份文件`);
  try { const targets = state.splitItems.map(validateSplitItem); const source = await PDFLib.PDFDocument.load(state.bytes, { updateMetadata: false }); const seen = new Map(); const zip = new JSZip(); for (let i = 0; i < targets.length; i += 1) { const target = targets[i]; elements.loadingDetail.textContent = `正在生成第 ${i + 1} / ${targets.length} 份`; let name = target.name; const count = seen.get(name) || 0; seen.set(name, count + 1); if (count) name = name.replace(/\.pdf$/i, `-${count + 1}.pdf`); zip.file(name, await buildSplitPdf(source, target.pages)); await new Promise((resolve) => window.setTimeout(resolve, 0)); } elements.loadingDetail.textContent = "正在压缩文件"; const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 5 } }); downloadBlob(blob, `${state.baseName}-拆分.zip`); notify(`已打包 ${targets.length} 份 PDF。`); }
  catch (error) { console.error("PDF 打包失败", error); notify(operationError(error, "PDF 打包失败，请减少拆分数量或检查文件是否完整。"), true); } finally { setBusy(false); }
}

function canvasToBlob(canvas, type, quality) { return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("图片生成失败，浏览器内存可能不足。")), type, quality)); }
async function renderPageCanvas(pageNumber, scale, format = "jpeg") { const page = await state.pdf.getPage(pageNumber); const viewport = page.getViewport({ scale }); if (viewport.width * viewport.height > LIMITS.maxCanvasPixels) throw new Error(`第 ${pageNumber} 页尺寸过大，请降低清晰度后重试。`); const canvas = document.createElement("canvas"); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height); const context = canvas.getContext("2d", { alpha: format === "png" }); if (format === "jpeg") { context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height); } await page.render({ canvasContext: context, viewport, background: format === "jpeg" ? "white" : undefined }).promise; return { canvas, page, viewport }; }
async function renderPageImage(pageNumber, format, scale) { const { canvas } = await renderPageCanvas(pageNumber, scale, format); return canvasToBlob(canvas, format === "jpeg" ? "image/jpeg" : "image/png", .92); }
async function downloadImages() {
  if (state.busy) return; const pages = [...state.selected].sort((a, b) => a - b); if (!pages.length) { notify("请先勾选需要转换的页面。", true); return; } const format = elements.imageFormat.value; const extension = format === "jpeg" ? "jpg" : "png"; const scale = Number(elements.imageScale.value); setBusy(true, "正在转换图片", `正在处理第 1 / ${pages.length} 页`);
  try { if (pages.length === 1) downloadBlob(await renderPageImage(pages[0], format, scale), `${state.baseName}-第${pages[0]}页.${extension}`); else { const zip = new JSZip(); const digits = String(state.pageCount).length; for (let i = 0; i < pages.length; i += 1) { elements.loadingDetail.textContent = `正在处理第 ${i + 1} / ${pages.length} 页`; zip.file(`${state.baseName}-第${String(pages[i]).padStart(digits, "0")}页.${extension}`, await renderPageImage(pages[i], format, scale)); await new Promise((resolve) => window.setTimeout(resolve, 0)); } elements.loadingDetail.textContent = "正在压缩图片"; downloadBlob(await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 4 } }), `${state.baseName}-图片.zip`); } notify(`已完成 ${pages.length} 页图片转换。`); }
  catch (error) { console.error("PDF 转图片失败", error); notify(operationError(error, "图片转换失败，请减少页数、降低清晰度或换用桌面浏览器。"), true); } finally { setBusy(false); }
}

async function compressPdf() {
  if (state.busy) return; const presetName = document.querySelector('input[name="compress-preset"]:checked')?.value || "balanced"; const preset = PRESETS[presetName]; setBusy(true, "正在压缩 PDF", `正在处理第 1 / ${state.pageCount} 页`);
  try { const output = await PDFLib.PDFDocument.create(); output.setTitle(state.baseName); output.setCreator("ToolBox PDF 工作台"); for (let pageNumber = 1; pageNumber <= state.pageCount; pageNumber += 1) { elements.loadingDetail.textContent = `正在处理第 ${pageNumber} / ${state.pageCount} 页`; const { canvas, page } = await renderPageCanvas(pageNumber, preset.scale, "jpeg"); const jpegBlob = await canvasToBlob(canvas, "image/jpeg", preset.quality); const image = await output.embedJpg(await jpegBlob.arrayBuffer()); const originalViewport = page.getViewport({ scale: 1 }); const outputPage = output.addPage([originalViewport.width, originalViewport.height]); outputPage.drawImage(image, { x: 0, y: 0, width: originalViewport.width, height: originalViewport.height }); await new Promise((resolve) => window.setTimeout(resolve, 0)); } elements.loadingDetail.textContent = "正在生成压缩文件"; const bytes = await output.save({ useObjectStreams: true }); const blob = new Blob([bytes], { type: "application/pdf" }); downloadBlob(blob, `${state.baseName}-压缩.pdf`); const ratio = state.file.size ? Math.round((1 - blob.size / state.file.size) * 100) : 0; notify(ratio > 0 ? `压缩完成，文件体积减少约 ${ratio}%。` : "压缩完成；这份 PDF 已较精简，新文件可能不会更小。 "); }
  catch (error) { console.error("PDF 压缩失败", error); notify(operationError(error, "PDF 压缩失败，请使用较低档位、关闭其他页面后重试。"), true); } finally { setBusy(false); }
}

elements.input.addEventListener("change", (event) => loadPdf(event.target.files?.[0])); elements.dropZone.addEventListener("dragover", (event) => { event.preventDefault(); elements.dropZone.classList.add("is-dragging"); }); elements.dropZone.addEventListener("dragleave", () => elements.dropZone.classList.remove("is-dragging")); elements.dropZone.addEventListener("drop", (event) => { event.preventDefault(); elements.dropZone.classList.remove("is-dragging"); const files = [...event.dataTransfer.files]; if (!files.length) { notify("没有读取到文件，请使用“选择 PDF”按钮重试。", true); return; } const pdfFile = files.find((file) => /\.pdf$/i.test(file.name) || file.type === "application/pdf") || files[0]; if (files.length > 1) notify("一次只能处理一份 PDF，已读取其中的 PDF 文件。"); loadPdf(pdfFile); }); elements.changeFile.addEventListener("click", resetWorkspace);
document.querySelectorAll("[data-select]").forEach((button) => button.addEventListener("click", () => { const mode = button.dataset.select; const pages = Array.from({ length: state.pageCount }, (_, index) => index + 1).filter((page) => mode === "all" || (mode === "odd" && page % 2) || (mode === "even" && !(page % 2))); updateSelection(mode === "none" ? [] : pages, true); }));
elements.pageInput.addEventListener("change", () => { try { updateSelection(parsePageRange(elements.pageInput.value), true); } catch (error) { notify(error.message, true); elements.pageInput.value = compactPages([...state.selected]); } }); elements.pageInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); elements.pageInput.blur(); } }); elements.tabs.forEach((tab) => tab.addEventListener("click", () => switchMode(tab))); elements.addSplit.addEventListener("click", addSelectedSplit); elements.splitSingle.addEventListener("click", splitEveryPage); elements.downloadPdfs.addEventListener("click", downloadAllPdfs); elements.downloadImages.addEventListener("click", downloadImages); elements.compressPdf.addEventListener("click", compressPdf);
document.querySelectorAll('input[name="compress-preset"]').forEach((input) => input.addEventListener("change", () => { document.querySelectorAll(".preset-grid label").forEach((label) => label.classList.toggle("is-selected", label.contains(input))); }));
if (!librariesReady) window.setTimeout(() => notify("PDF 组件加载失败，请检查网络后刷新页面。", true), 300);
