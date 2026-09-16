/* global PDFLib, JSZip */

const LIMITS = Object.freeze({ maxFiles: 50, maxFileBytes: 25 * 1024 * 1024, maxTotalBytes: 250 * 1024 * 1024, maxPixels: 40_000_000, maxGroups: 100, maxGroupImages: 200 });
const PRESETS = Object.freeze({ small: { maxEdge: 1600, quality: .62 }, balanced: { maxEdge: 2400, quality: .76 }, clear: { maxEdge: 3840, quality: .88 } });
const MODE_COPY = Object.freeze({ pdf: { title: "图片转 PDF", kicker: "IMAGE TO PDF" }, compress: { title: "图片压缩", kicker: "IMAGE COMPRESS" } });
const state = { mode: null, images: [], groups: [], selected: new Set(), busy: false };
const $ = (selector) => document.querySelector(selector);
const elements = {
  entries: $("#tool-entries"), shell: $("#tool-shell"), modeBack: $("#mode-back"), workbenchTitle: $("#workbench-title"), uploadKicker: $("#upload-kicker"), uploadView: $("#upload-view"), input: $("#image-input"), addInput: $("#add-image-input"), dropZone: $("#drop-zone"), workspace: $("#workspace"), workspaceModeTitle: $("#workspace-mode-title"), workspaceFileCount: $("#workspace-file-count"), addImages: $("#add-images"), clearImages: $("#clear-images"), libraryHelp: $("#library-help"), selectionActions: $("#selection-actions"), selectAll: $("#select-all"), selectNone: $("#select-none"), selectedCount: $("#selected-count"), imageGrid: $("#image-grid"),
  pdfPanel: $("#pdf-panel"), createGroup: $("#create-group"), groupList: $("#group-list"), groupEmpty: $("#group-empty"), pdfDownloadBar: $("#pdf-download-bar"), groupCount: $("#group-count"), downloadAllPdfs: $("#download-all-pdfs"),
  compressPanel: $("#compress-panel"), compressionList: $("#compression-list"), compressSummary: $("#compress-summary"), compressImages: $("#compress-images"), overlay: $("#loading-overlay"), loadingTitle: $("#loading-title"), loadingDetail: $("#loading-detail"), toast: $("#toast"), confirmModal: $("#confirm-modal"), confirmTitle: $("#confirm-title"), confirmMessage: $("#confirm-message"), confirmCancel: $("#confirm-cancel"), confirmSubmit: $("#confirm-submit")
};

let toastTimer;
function notify(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle("is-error", isError);
  elements.toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => elements.toast.classList.remove("is-visible"), message.length > 32 ? 5200 : 3200);
}

function setBusy(busy, title = "正在处理图片", detail = "请不要关闭页面") {
  state.busy = busy;
  elements.overlay.hidden = !busy;
  elements.loadingTitle.textContent = title;
  elements.loadingDetail.textContent = detail;
}

let confirmationResolver = null;
let confirmationFocus = null;
function closeConfirmation(confirmed) {
  if (elements.confirmModal.hidden) return;
  elements.confirmModal.hidden = true;
  document.body.classList.remove("modal-open");
  const resolve = confirmationResolver;
  confirmationResolver = null;
  resolve?.(confirmed);
  if (confirmationFocus?.isConnected) confirmationFocus.focus();
  confirmationFocus = null;
}

function askConfirmation(title, message, confirmLabel = "确认") {
  if (confirmationResolver) closeConfirmation(false);
  confirmationFocus = document.activeElement;
  elements.confirmTitle.textContent = title;
  elements.confirmMessage.textContent = message;
  elements.confirmSubmit.textContent = confirmLabel;
  elements.confirmModal.hidden = false;
  document.body.classList.add("modal-open");
  elements.confirmCancel.focus();
  return new Promise((resolve) => { confirmationResolver = resolve; });
}

elements.confirmCancel.addEventListener("click", () => closeConfirmation(false));
elements.confirmSubmit.addEventListener("click", () => closeConfirmation(true));
elements.confirmModal.addEventListener("click", (event) => { if (event.target === elements.confirmModal) closeConfirmation(false); });
elements.confirmModal.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { event.preventDefault(); closeConfirmation(false); return; }
  if (event.key !== "Tab") return;
  const buttons = [elements.confirmCancel, elements.confirmSubmit];
  const index = buttons.indexOf(document.activeElement);
  if ((!event.shiftKey && index === buttons.length - 1) || (event.shiftKey && index <= 0)) {
    event.preventDefault();
    buttons[event.shiftKey ? buttons.length - 1 : 0].focus();
  }
});

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(.1, bytes / 1024).toFixed(bytes < 100 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 2 : 1)} MB`;
}

function safeName(name, fallback = "图片") {
  return (String(name || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").trim() || fallback).slice(0, 120);
}

function baseName(fileName) { return safeName(fileName.replace(/\.[^.]+$/, "")); }
function uniqueId() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`; }
function fileSignature(file) { return `${file.name.toLowerCase()}\u0000${file.size}\u0000${file.lastModified}`; }
function isSupportedImage(file) { return /\.(?:jpe?g|png|webp)$/i.test(file.name) || /^(?:image\/jpeg|image\/png|image\/webp)$/i.test(file.type); }
function imageById(id) { return state.images.find((imageItem) => imageItem.id === id); }

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1800);
}

function loadImageElement(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    let timer = window.setTimeout(() => { image.src = ""; reject(new Error("图片读取超时")); }, timeoutMs);
    image.onload = () => { window.clearTimeout(timer); resolve(image); };
    image.onerror = () => { window.clearTimeout(timer); reject(new Error("图片损坏或格式不受支持")); };
    image.src = url;
  });
}

async function prepareImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImageElement(url);
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) throw new Error("图片没有可读取的尺寸");
    if (width * height > LIMITS.maxPixels) throw new Error(`图片像素超过 ${LIMITS.maxPixels / 1_000_000}MP 上限`);
    return { id: uniqueId(), file, url, width, height, compression: null };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function enterMode(mode, shouldScroll = true) {
  if (!MODE_COPY[mode]) return;
  state.mode = mode;
  elements.entries.hidden = true;
  elements.shell.hidden = false;
  elements.uploadView.hidden = false;
  elements.workspace.hidden = true;
  elements.workbenchTitle.textContent = MODE_COPY[mode].title;
  elements.uploadKicker.textContent = MODE_COPY[mode].kicker;
  elements.workspaceModeTitle.textContent = MODE_COPY[mode].title;
  if (shouldScroll) elements.shell.scrollIntoView({ behavior: "smooth", block: "start" });
}

function releaseImages() {
  state.images.forEach((imageItem) => URL.revokeObjectURL(imageItem.url));
  state.images = [];
  state.groups = [];
  state.selected.clear();
}

function resetUpload() {
  if (state.busy) return;
  releaseImages();
  elements.input.value = "";
  elements.addInput.value = "";
  elements.imageGrid.replaceChildren();
  elements.workspaceFileCount.textContent = "0 张图片";
  elements.workspace.hidden = true;
  elements.uploadView.hidden = false;
}

function returnToEntries() {
  if (state.busy) return;
  resetUpload();
  state.mode = null;
  elements.shell.hidden = true;
  elements.entries.hidden = false;
  elements.entries.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function loadFiles(fileList, append = false) {
  if (state.busy) return;
  const received = [...fileList];
  if (!received.length) { notify("没有读取到图片，请重新选择。", true); return; }
  const receivedImages = received.filter(isSupportedImage);
  if (!receivedImages.length) { notify("仅支持 JPG、PNG 和 WebP 图片。", true); return; }
  const existing = new Set(append ? state.images.map((item) => fileSignature(item.file)) : []);
  const unique = new Map();
  receivedImages.forEach((file) => unique.set(fileSignature(file), file));
  const duplicateCount = append ? [...unique.keys()].filter((key) => existing.has(key)).length : receivedImages.length - unique.size;
  const candidates = [...unique].filter(([key]) => !existing.has(key)).map(([, file]) => file);
  if (state.images.length + candidates.length > LIMITS.maxFiles) { notify(`工作区最多保留 ${LIMITS.maxFiles} 张图片。`, true); return; }
  if (!candidates.length) { notify("这些图片已经在工作区中，无需重复添加。", true); return; }
  const totalBytes = state.images.reduce((sum, item) => sum + item.file.size, 0) + candidates.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > LIMITS.maxTotalBytes) { notify(`图片共 ${formatBytes(totalBytes)}，超过 250MB 总上限。`, true); return; }
  const accepted = [];
  const rejected = [];
  setBusy(true, "正在读取图片", `准备检查 ${candidates.length} 张图片`);
  try {
    for (let index = 0; index < candidates.length; index += 1) {
      const file = candidates[index];
      elements.loadingDetail.textContent = `正在读取第 ${index + 1} / ${candidates.length} 张：${file.name}`;
      if (file.size > LIMITS.maxFileBytes) { rejected.push(`${file.name}：超过 25MB`); continue; }
      try { accepted.push(await prepareImage(file)); }
      catch (error) { console.error("图片读取失败", file.name, error); rejected.push(`${file.name}：${error.message}`); }
    }
  } finally { setBusy(false); }
  if (!accepted.length) { notify(rejected[0] || "没有可处理的图片。", true); return; }
  if (!append) releaseImages();
  state.images.push(...accepted);
  if (state.mode === "pdf") accepted.forEach((item) => state.selected.add(item.id));
  elements.uploadView.hidden = true;
  elements.workspace.hidden = false;
  renderWorkspace();
  if (!append) elements.workspace.scrollIntoView({ behavior: "smooth", block: "start" });
  const notices = [];
  if (append) notices.push(`已加入 ${accepted.length} 张图片`);
  const unsupported = received.length - receivedImages.length;
  if (unsupported) notices.push(`忽略 ${unsupported} 个非图片文件`);
  if (rejected.length) notices.push(`跳过 ${rejected.length} 张无法处理的图片`);
  if (duplicateCount) notices.push(`忽略 ${duplicateCount} 张重复图片`);
  if (notices.length) notify(notices.join("；"), Boolean(unsupported || rejected.length));
}

function renderWorkspace() {
  elements.workspaceFileCount.textContent = `${state.images.length} 张图片`;
  elements.pdfPanel.hidden = state.mode !== "pdf";
  elements.compressPanel.hidden = state.mode !== "compress";
  elements.selectionActions.hidden = state.mode !== "pdf";
  elements.libraryHelp.textContent = state.mode === "pdf" ? "点击图片选择，可组合成 PDF。" : "所有图片会使用同一压缩档位。";
  renderImageGrid();
  if (state.mode === "pdf") renderGroups();
  else renderCompressionList();
}

function renderImageGrid() {
  elements.imageGrid.replaceChildren();
  const fragment = document.createDocumentFragment();
  state.images.forEach((imageItem) => {
    const card = document.createElement("article");
    card.className = "image-card";
    card.classList.toggle("is-selected", state.selected.has(imageItem.id));
    const select = document.createElement("button");
    select.type = "button";
    select.className = "image-select";
    select.disabled = state.mode !== "pdf";
    select.setAttribute("aria-pressed", String(state.selected.has(imageItem.id)));
    select.setAttribute("aria-label", `${state.selected.has(imageItem.id) ? "取消选择" : "选择"} ${imageItem.file.name}`);
    const thumb = document.createElement("span");
    thumb.className = "image-thumb";
    const image = document.createElement("img");
    image.src = imageItem.url;
    image.alt = "";
    thumb.appendChild(image);
    const copy = document.createElement("span");
    copy.className = "image-copy";
    const name = document.createElement("strong");
    const meta = document.createElement("small");
    name.textContent = imageItem.file.name;
    meta.textContent = `${imageItem.width} × ${imageItem.height} · ${formatBytes(imageItem.file.size)}`;
    copy.append(name, meta);
    const mark = document.createElement("span");
    mark.className = "selected-mark";
    mark.textContent = "✓";
    select.append(thumb, copy, mark);
    select.addEventListener("click", () => {
      if (state.selected.has(imageItem.id)) state.selected.delete(imageItem.id);
      else state.selected.add(imageItem.id);
      renderImageGrid();
      refreshSelection();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "image-remove";
    remove.textContent = "删除";
    remove.setAttribute("aria-label", `删除 ${imageItem.file.name}`);
    remove.addEventListener("click", () => removeImage(imageItem));
    card.append(select, remove);
    fragment.appendChild(card);
  });
  elements.imageGrid.appendChild(fragment);
  refreshSelection();
}

function refreshSelection() {
  elements.selectedCount.textContent = `已选 ${state.selected.size} 张`;
  elements.createGroup.disabled = !state.selected.size;
}

async function removeImage(imageItem) {
  if (state.busy || !state.images.includes(imageItem)) return;
  if (!await askConfirmation("删除图片", `删除“${imageItem.file.name}”？使用它的 PDF 组合也会同步移除这张图片。`, "删除")) return;
  state.images = state.images.filter((item) => item !== imageItem);
  state.selected.delete(imageItem.id);
  URL.revokeObjectURL(imageItem.url);
  state.groups.forEach((group) => { group.imageIds = group.imageIds.filter((id) => id !== imageItem.id); });
  state.groups = state.groups.filter((group) => group.imageIds.length);
  if (!state.images.length) { resetUpload(); notify("已删除最后一张图片，工作区已清空"); return; }
  renderWorkspace();
  notify(`已删除 ${imageItem.file.name}`);
}

function selectedIds() { return state.images.filter((item) => state.selected.has(item.id)).map((item) => item.id); }
function createGroup() {
  const ids = selectedIds();
  if (!ids.length) { notify("请先选择至少一张图片。", true); return; }
  if (state.groups.length >= LIMITS.maxGroups) { notify(`最多创建 ${LIMITS.maxGroups} 份 PDF。`, true); return; }
  const firstImage = imageById(ids[0]);
  const originalName = firstImage ? baseName(firstImage.file.name) : `图片文档-${state.groups.length + 1}`;
  state.groups.push({ id: uniqueId(), name: originalName, imageIds: ids });
  state.selected.clear();
  renderImageGrid();
  renderGroups();
  notify(`已新建 PDF 组合，共 ${ids.length} 张图片`);
}

function addSelectedToGroup(group) {
  const additions = selectedIds().filter((id) => !group.imageIds.includes(id));
  if (!additions.length) { notify("请先选择尚未加入这个组合的图片。", true); return; }
  if (group.imageIds.length + additions.length > LIMITS.maxGroupImages) { notify(`每份 PDF 最多包含 ${LIMITS.maxGroupImages} 张图片。`, true); return; }
  group.imageIds.push(...additions);
  state.selected.clear();
  renderImageGrid();
  renderGroups();
  notify(`已加入 ${additions.length} 张图片`);
}

function moveGroupImage(group, index, offset) {
  const target = index + offset;
  if (target < 0 || target >= group.imageIds.length) return;
  [group.imageIds[index], group.imageIds[target]] = [group.imageIds[target], group.imageIds[index]];
  renderGroups();
}

async function removeGroup(group) {
  if (!await askConfirmation("删除 PDF 组合", `删除“${group.name}”？已上传的原图片不会被删除。`, "删除")) return;
  state.groups = state.groups.filter((item) => item !== group);
  renderGroups();
  notify("已删除 PDF 组合");
}

function renderGroups() {
  elements.groupList.replaceChildren();
  const fragment = document.createDocumentFragment();
  state.groups.forEach((group) => {
    const article = document.createElement("article");
    article.className = "pdf-group";
    const top = document.createElement("div");
    top.className = "group-top";
    const name = document.createElement("input");
    name.className = "group-name";
    name.value = group.name;
    name.maxLength = 120;
    name.setAttribute("aria-label", "PDF 文件名");
    name.addEventListener("input", () => { group.name = name.value; });
    const actions = document.createElement("div");
    actions.className = "group-actions";
    const add = button("加入当前所选", () => addSelectedToGroup(group));
    const download = button("下载这份 PDF", () => downloadOnePdf(group));
    const remove = button("删除组合", () => removeGroup(group), "danger");
    actions.append(add, download, remove);
    top.append(name, actions);
    const images = document.createElement("div");
    images.className = "group-images";
    group.imageIds.forEach((id, index) => {
      const imageItem = imageById(id);
      if (!imageItem) return;
      const item = document.createElement("div");
      item.className = "group-image";
      const image = document.createElement("img");
      image.src = imageItem.url;
      image.alt = "";
      const copy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = `${index + 1}. ${imageItem.file.name}`;
      const controls = document.createElement("span");
      controls.className = "order-actions";
      controls.append(button("↑", () => moveGroupImage(group, index, -1), "", "上移"), button("↓", () => moveGroupImage(group, index, 1), "", "下移"), button("×", () => { group.imageIds.splice(index, 1); if (!group.imageIds.length) state.groups = state.groups.filter((entry) => entry !== group); renderGroups(); }, "", "从组合移除"));
      copy.append(title, controls);
      item.append(image, copy);
      images.appendChild(item);
    });
    article.append(top, images);
    fragment.appendChild(article);
  });
  elements.groupList.appendChild(fragment);
  elements.groupEmpty.hidden = state.groups.length > 0;
  elements.pdfDownloadBar.hidden = state.groups.length === 0;
  elements.groupCount.textContent = String(state.groups.length);
  elements.downloadAllPdfs.textContent = state.groups.length > 1 ? "打包下载全部 PDF" : "下载 PDF";
}

function button(text, onClick, extraClass = "", ariaLabel = "") {
  const control = document.createElement("button");
  control.type = "button";
  control.className = `small-button ${extraClass}`.trim();
  control.textContent = text;
  if (ariaLabel) control.setAttribute("aria-label", ariaLabel);
  control.addEventListener("click", onClick);
  return control;
}

async function canvasJpeg(imageItem, maxEdge, quality) {
  const image = await loadImageElement(imageItem.url);
  const scale = Math.min(1, maxEdge / Math.max(imageItem.width, imageItem.height));
  const width = Math.max(1, Math.round(imageItem.width * scale));
  const height = Math.max(1, Math.round(imageItem.height * scale));
  if (width * height > LIMITS.maxPixels) throw new Error(`${imageItem.file.name} 像素过大`);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("浏览器无法创建图片画布");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("图片编码失败")), "image/jpeg", quality));
}

async function jpegOrientation(file) {
  try {
    const view = new DataView(await file.slice(0, 128 * 1024).arrayBuffer());
    if (view.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) return 1;
    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      if (view.getUint8(offset) !== 0xff) break;
      const marker = view.getUint8(offset + 1);
      const length = view.getUint16(offset + 2, false);
      if (marker === 0xe1 && offset + 10 <= view.byteLength && view.getUint32(offset + 4, false) === 0x45786966) {
        const tiff = offset + 10;
        const littleEndian = view.getUint16(tiff, false) === 0x4949;
        const firstIfd = tiff + view.getUint32(tiff + 4, littleEndian);
        if (firstIfd + 2 > view.byteLength) return 1;
        const entries = view.getUint16(firstIfd, littleEndian);
        for (let index = 0; index < entries; index += 1) {
          const entry = firstIfd + 2 + index * 12;
          if (entry + 12 > view.byteLength) break;
          if (view.getUint16(entry, littleEndian) === 0x0112) return view.getUint16(entry + 8, littleEndian) || 1;
        }
        return 1;
      }
      if (length < 2) break;
      offset += 2 + length;
    }
  } catch (error) {
    console.warn("无法读取图片方向信息，将按原始方向处理", file.name, error);
  }
  return 1;
}

async function canvasPng(imageItem) {
  const image = await loadImageElement(imageItem.url);
  const canvas = document.createElement("canvas");
  canvas.width = imageItem.width;
  canvas.height = imageItem.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法创建图片画布");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("图片方向校正失败")), "image/png"));
}

async function embedOriginalAppearance(pdf, imageItem) {
  const isJpeg = /^(?:image\/jpeg)$/i.test(imageItem.file.type) || /\.jpe?g$/i.test(imageItem.file.name);
  const isPng = /^(?:image\/png)$/i.test(imageItem.file.type) || /\.png$/i.test(imageItem.file.name);
  if (isPng) return pdf.embedPng(await imageItem.file.arrayBuffer());
  if (isJpeg && await jpegOrientation(imageItem.file) === 1) return pdf.embedJpg(await imageItem.file.arrayBuffer());
  // PDF 不识别手机照片的 EXIF 旋转和 WebP；以无损 PNG 固化浏览器中看到的方向与画面。
  return pdf.embedPng(await (await canvasPng(imageItem)).arrayBuffer());
}

async function createPdfBlob(group) {
  if (!window.PDFLib) throw new Error("PDF 组件加载失败，请检查网络后刷新页面。");
  const pdf = await PDFLib.PDFDocument.create();
  for (let index = 0; index < group.imageIds.length; index += 1) {
    const imageItem = imageById(group.imageIds[index]);
    if (!imageItem) continue;
    elements.loadingDetail.textContent = `${group.name} · 第 ${index + 1} / ${group.imageIds.length} 张`;
    const embedded = await embedOriginalAppearance(pdf, imageItem);
    const scale = Math.min(1, 841.89 / Math.max(embedded.width, embedded.height));
    const pageWidth = embedded.width * scale;
    const pageHeight = embedded.height * scale;
    const page = pdf.addPage([pageWidth, pageHeight]);
    page.drawImage(embedded, { x: 0, y: 0, width: pageWidth, height: pageHeight });
  }
  if (!pdf.getPageCount()) throw new Error("PDF 组合中没有可用图片。");
  return new Blob([await pdf.save({ useObjectStreams: true })], { type: "application/pdf" });
}

async function downloadOnePdf(group) {
  if (state.busy) return;
  setBusy(true, "正在生成 PDF", group.name);
  try {
    downloadBlob(await createPdfBlob(group), `${safeName(group.name, "图片文档").replace(/\.pdf$/i, "")}.pdf`);
    notify("PDF 已生成");
  } catch (error) { console.error("PDF 生成失败", error); notify(error.message || "PDF 生成失败，请减少图片后重试。", true); }
  finally { setBusy(false); }
}

async function downloadAllPdfs() {
  if (state.busy || !state.groups.length) return;
  if (state.groups.length === 1) { await downloadOnePdf(state.groups[0]); return; }
  if (!window.JSZip) { notify("打包组件加载失败，请检查网络后刷新页面。", true); return; }
  setBusy(true, "正在生成 PDF", `准备处理 ${state.groups.length} 份组合`);
  try {
    const zip = new JSZip();
    const used = new Set();
    for (let index = 0; index < state.groups.length; index += 1) {
      const group = state.groups[index];
      elements.loadingDetail.textContent = `正在生成第 ${index + 1} / ${state.groups.length} 份：${group.name}`;
      let name = `${safeName(group.name, `图片文档-${index + 1}`).replace(/\.pdf$/i, "")}.pdf`;
      if (used.has(name.toLowerCase())) name = `${name.replace(/\.pdf$/i, "")}-${index + 1}.pdf`;
      used.add(name.toLowerCase());
      zip.file(name, await createPdfBlob(group));
    }
    elements.loadingDetail.textContent = "正在打包 PDF";
    downloadBlob(await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 4 } }), "图片转PDF结果.zip");
    notify(`已生成 ${state.groups.length} 份 PDF`);
  } catch (error) { console.error("PDF 批量生成失败", error); notify(error.message || "PDF 生成失败，请减少图片后重试。", true); }
  finally { setBusy(false); }
}

function compressionChange(original, result) {
  if (result >= original) return "保留原图";
  return `减少 ${Math.round((1 - result / original) * 100)}%`;
}

function renderCompressionList() {
  elements.compressionList.replaceChildren();
  const fragment = document.createDocumentFragment();
  state.images.forEach((imageItem) => {
    const row = document.createElement("div");
    row.className = "compression-row";
    const identity = document.createElement("div");
    const name = document.createElement("strong");
    const dimensions = document.createElement("small");
    name.textContent = imageItem.file.name;
    dimensions.textContent = `${imageItem.width} × ${imageItem.height}`;
    identity.append(name, dimensions);
    const source = document.createElement("div");
    source.className = "size-info size-before";
    const sourceLabel = document.createElement("span");
    sourceLabel.textContent = "压缩前大小";
    const sourceSize = document.createElement("b");
    sourceSize.textContent = formatBytes(imageItem.file.size);
    source.append(sourceLabel, sourceSize);
    const result = document.createElement("div");
    result.className = `size-info size-after${imageItem.compression ? " is-complete" : ""}`;
    const resultLabel = document.createElement("span");
    resultLabel.textContent = "压缩后大小";
    result.appendChild(resultLabel);
    if (imageItem.compression) {
      const resultSize = document.createElement("b");
      resultSize.textContent = formatBytes(imageItem.compression.size);
      const change = document.createElement("em");
      change.textContent = compressionChange(imageItem.file.size, imageItem.compression.size);
      result.append(resultSize, change);
    } else {
      const pending = document.createElement("b");
      pending.textContent = "等待压缩";
      result.appendChild(pending);
    }
    row.append(identity, source, result);
    fragment.appendChild(row);
  });
  elements.compressionList.appendChild(fragment);
  const originalTotal = state.images.reduce((sum, item) => sum + item.file.size, 0);
  const complete = state.images.length && state.images.every((item) => item.compression);
  if (complete) {
    const resultTotal = state.images.reduce((sum, item) => sum + item.compression.size, 0);
    elements.compressSummary.textContent = `源图片共 ${formatBytes(originalTotal)}，压缩后共 ${formatBytes(resultTotal)}（${compressionChange(originalTotal, resultTotal)}）`;
  } else elements.compressSummary.textContent = `源图片共 ${formatBytes(originalTotal)}`;
  elements.compressImages.textContent = `压缩 ${state.images.length} 张图片`;
  elements.compressImages.disabled = !state.images.length;
}

async function compressOne(imageItem, preset) {
  const compressed = await canvasJpeg(imageItem, preset.maxEdge, preset.quality);
  if (compressed.size >= imageItem.file.size) return { blob: imageItem.file, size: imageItem.file.size, name: imageItem.file.name, retained: true };
  return { blob: compressed, size: compressed.size, name: `${baseName(imageItem.file.name)}-压缩.jpg`, retained: false };
}

async function compressAll() {
  if (state.busy || !state.images.length) return;
  const presetName = document.querySelector('input[name="compress-preset"]:checked')?.value || "balanced";
  const preset = PRESETS[presetName];
  setBusy(true, "正在压缩图片", `准备处理 ${state.images.length} 张图片`);
  try {
    for (let index = 0; index < state.images.length; index += 1) {
      const imageItem = state.images[index];
      elements.loadingDetail.textContent = `正在压缩第 ${index + 1} / ${state.images.length} 张：${imageItem.file.name}`;
      imageItem.compression = await compressOne(imageItem, preset);
      renderCompressionList();
    }
    if (state.images.length === 1) {
      const imageItem = state.images[0];
      downloadBlob(imageItem.compression.blob, imageItem.compression.name);
    } else {
      if (!window.JSZip) throw new Error("打包组件加载失败，请检查网络后刷新页面。");
      const zip = new JSZip();
      const used = new Set();
      state.images.forEach((imageItem, index) => {
        let name = safeName(imageItem.compression.name, `图片-${index + 1}.jpg`);
        if (used.has(name.toLowerCase())) name = `${baseName(name)}-${index + 1}.${name.split(".").pop()}`;
        used.add(name.toLowerCase());
        zip.file(name, imageItem.compression.blob);
      });
      elements.loadingDetail.textContent = "正在打包压缩图片";
      downloadBlob(await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 4 } }), "图片压缩结果.zip");
    }
    const original = state.images.reduce((sum, item) => sum + item.file.size, 0);
    const result = state.images.reduce((sum, item) => sum + item.compression.size, 0);
    notify(`压缩完成：${formatBytes(original)} → ${formatBytes(result)}`);
  } catch (error) { console.error("图片压缩失败", error); notify(error.message || "图片压缩失败，请降低档位或减少图片数量。", true); }
  finally { setBusy(false); renderCompressionList(); }
}

document.querySelectorAll("[data-enter-mode]").forEach((control) => control.addEventListener("click", () => enterMode(control.dataset.enterMode)));
elements.modeBack.addEventListener("click", returnToEntries);
elements.addImages.addEventListener("click", () => elements.addInput.click());
elements.clearImages.addEventListener("click", async () => {
  if (!await askConfirmation("清空全部图片", "所有图片、PDF 组合和压缩结果都会清除。", "清空全部")) return;
  resetUpload();
  notify("已清空所有图片");
});
elements.input.addEventListener("change", (event) => { const files = [...event.target.files]; event.target.value = ""; loadFiles(files); });
elements.addInput.addEventListener("change", (event) => { const files = [...event.target.files]; event.target.value = ""; loadFiles(files, true); });
elements.dropZone.addEventListener("dragover", (event) => { event.preventDefault(); elements.dropZone.classList.add("is-dragging"); });
elements.dropZone.addEventListener("dragleave", () => elements.dropZone.classList.remove("is-dragging"));
elements.dropZone.addEventListener("drop", (event) => { event.preventDefault(); elements.dropZone.classList.remove("is-dragging"); loadFiles(event.dataTransfer.files); });
elements.selectAll.addEventListener("click", () => { state.images.forEach((item) => state.selected.add(item.id)); renderImageGrid(); });
elements.selectNone.addEventListener("click", () => { state.selected.clear(); renderImageGrid(); });
elements.createGroup.addEventListener("click", createGroup);
elements.downloadAllPdfs.addEventListener("click", downloadAllPdfs);
elements.compressImages.addEventListener("click", compressAll);
document.querySelectorAll('input[name="compress-preset"]').forEach((input) => input.addEventListener("change", () => {
  document.querySelectorAll(".preset-grid label").forEach((label) => label.classList.toggle("is-selected", label.contains(input)));
  state.images.forEach((item) => { item.compression = null; });
  if (state.mode === "compress") renderCompressionList();
}));

if (!window.PDFLib || !window.JSZip) window.setTimeout(() => notify("处理组件加载失败，请检查网络后刷新页面。", true), 300);

const initialMode = new URLSearchParams(window.location.search).get("mode");
if (MODE_COPY[initialMode]) enterMode(initialMode, false);
