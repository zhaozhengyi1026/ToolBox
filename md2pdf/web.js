const elements = {
  dropZone: document.querySelector("#drop-zone"),
  folderInput: document.querySelector("#folder-input"),
  fileInput: document.querySelector("#file-input"),
  multiMdInput: document.querySelector("#multi-md-input"),
  uploadPanel: document.querySelector("#upload-panel"),
  workspace: document.querySelector("#workspace"),
  documentSelect: document.querySelector("#document-select"),
  source: document.querySelector("#markdown-source"),
  sourceMeta: document.querySelector("#source-meta"),
  preview: document.querySelector("#markdown-preview"),
  toc: document.querySelector("#toc-option"),
  numbered: document.querySelector("#number-option"),
  changeFiles: document.querySelector("#change-files"),
  downloadHtml: document.querySelector("#download-html"),
  printPdf: document.querySelector("#print-pdf"),
  resultStatus: document.querySelector("#result-status"),
  toast: document.querySelector("#toast"),
};

const state = {
  files: [],
  markdownFiles: [],
  currentFile: null,
  renderedHtml: "",
  renderTimer: null,
};

const LIMITS = Object.freeze({
  maxFiles: 1000,
  maxMarkdownFiles: 100,
  maxMarkdownBytes: 10 * 1024 * 1024,
  maxImageBytes: 25 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
});

const IMAGE_MIME_BY_EXTENSION = Object.freeze({
  avif: "image/avif",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
});

const DOCUMENT_CSS = `
:root{color-scheme:light;--text:#252b36;--muted:#5e6878;--border:#b8b8b8;--shade:#f5f6f8;--accent:#315a86}
*{box-sizing:border-box}html{background:#eceff3;-webkit-text-size-adjust:100%}
body{max-width:920px;margin:28px auto;padding:44px 54px;background:#fff;color:var(--text);font-family:"Microsoft YaHei",sans-serif;font-size:15px;line-height:1.75;overflow-wrap:anywhere}
h1,h2,h3,h4{color:#182536;line-height:1.35;break-after:avoid-page;page-break-after:avoid}
h1{margin:0 0 1.2em;padding-bottom:.55em;border-bottom:2px solid var(--accent);font-size:2em;text-align:center}
h2{margin-top:2em;padding-bottom:.35em;border-bottom:1px solid #d7dde4;font-size:1.55em}
h3{margin-top:1.55em;font-size:1.24em}h4{margin-top:1.35em;font-size:1.08em}
p{margin:.7em 0}ul,ol{padding-left:1.8em}li+li{margin-top:.25em}a{color:#245b8f;text-decoration:none}hr{margin:2em 0;border:0;border-top:1px solid #ccd2d9}
img{display:block;max-width:100%;max-height:220mm;width:auto;height:auto;margin:1.1em auto;object-fit:contain;break-inside:avoid-page;page-break-inside:avoid}
table{width:100%;margin:1.2em 0;border-collapse:collapse;table-layout:auto;font-size:.92em}thead{display:table-header-group}tr{break-inside:avoid-page}th,td{padding:.52em .62em;border:1px solid var(--border);text-align:left;vertical-align:top}th{background:#edf1f5}tbody tr:nth-child(even){background:#fafbfc}
blockquote{margin:1em 0;padding:.6em 1em;border-left:4px solid #8296aa;background:var(--shade);color:#303842}blockquote>:first-child{margin-top:0}blockquote>:last-child{margin-bottom:0}
code{padding:.12em .32em;border-radius:3px;background:#f0f2f4;font-family:"Microsoft YaHei",sans-serif;font-size:.9em}pre{padding:1em;overflow:auto;border:1px solid #d7dce2;border-radius:5px;background:#f6f8fa;white-space:pre-wrap;word-break:break-word;break-inside:avoid-page}pre code{padding:0;background:transparent}
.document-toc{margin:1.2em 0 2em;padding:1em 1.4em;border:1px solid #d7dde4;background:#fafbfc}.document-toc strong{display:block;margin-bottom:.5em}.document-toc ol{margin:0;padding-left:1.4em}
.missing-image{padding:12px;border:1px dashed #e38752;background:#fff4ed;color:#a34f20;font-family:"Microsoft YaHei",sans-serif;font-size:12px}
@page{size:A4;margin:17mm 15mm 18mm}@media print{html{background:#fff}body{max-width:none;margin:0;padding:0;font-size:10.5pt;print-color-adjust:exact;-webkit-print-color-adjust:exact}a{color:inherit}p{orphans:3;widows:3}}
`;

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  const duration = message.length > 28 ? 4200 : 2800;
  showToast.timer = window.setTimeout(() => elements.toast.classList.remove("is-visible"), duration);
}

function setStep(step) {
  document.querySelectorAll(".step").forEach((item) => {
    item.classList.toggle("is-active", Number(item.dataset.step) === step);
  });
}

function normalizePath(path) {
  const parts = path.replaceAll("\\", "/").split("/");
  const normalized = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  return normalized.join("/");
}

function filePath(file) {
  return normalizePath(file.webkitRelativePath || file.relativePath || file.name);
}

function safeDecode(value) {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

function isRemotePath(path) {
  return /^(?:https?:|data:|blob:|file:|#|mailto:|tel:)/i.test(path);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extensionOf(file) {
  return file.name.split(".").pop()?.toLowerCase() || "";
}

function isMarkdownFile(file) {
  return /\.(?:md|markdown)$/i.test(file.name);
}

function imageMime(file) {
  const extensionMime = IMAGE_MIME_BY_EXTENSION[extensionOf(file)];
  if (extensionMime) return extensionMime;
  const declaredMime = (file.type || "").toLowerCase();
  return Object.values(IMAGE_MIME_BY_EXTENSION).includes(declaredMime) ? declaredMime : "";
}

function isImageFile(file) {
  return Boolean(imageMime(file));
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)}MB`;
}

async function looksLikeBinary(file) {
  if (!file.size) return false;
  const bytes = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  let suspicious = 0;
  for (const byte of bytes) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / bytes.length > 0.08;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const mime = imageMime(file);
      const commaIndex = result.indexOf(",");
      resolve(mime && commaIndex >= 0
        ? `data:${mime};base64,${result.slice(commaIndex + 1)}`
        : result);
    };
    reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
    reader.onabort = () => reject(new Error("图片读取已取消"));
    reader.readAsDataURL(file);
  });
}

async function readMarkdown(file) {
  const buffer = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^\uFEFF/, "");
  } catch {
    try { return new TextDecoder("gb18030").decode(buffer); }
    catch { return new TextDecoder().decode(buffer); }
  }
}

function createFileMap() {
  const map = new Map();
  for (const file of state.files) {
    const path = filePath(file);
    map.set(path.toLowerCase(), file);
  }
  return map;
}

function resolveImageFile(rawPath, markdownFile, fileMap) {
  const cleanPath = safeDecode(rawPath.trim().replace(/^<|>$/g, "").split(/[?#]/, 1)[0]);
  if (!cleanPath || isRemotePath(cleanPath)) return null;

  const markdownPath = filePath(markdownFile);
  const baseParts = markdownPath.split("/");
  baseParts.pop();
  const candidates = [normalizePath([...baseParts, cleanPath].join("/"))];

  const root = markdownPath.includes("/") ? markdownPath.split("/")[0] : "";
  if (cleanPath.startsWith("/") && root) candidates.push(normalizePath(`${root}/${cleanPath}`));
  candidates.push(normalizePath(cleanPath));

  for (const candidate of candidates) {
    const exact = fileMap.get(candidate.toLowerCase());
    if (exact) return exact;
  }

  const suffix = normalizePath(cleanPath).toLowerCase();
  const matches = [...fileMap.entries()].filter(([path, file]) =>
    isImageFile(file) && (path.endsWith(`/${suffix}`) || path === suffix)
  );
  return matches.length === 1 ? matches[0][1] : null;
}

async function embedLocalImages(markdown, markdownFile) {
  const fileMap = createFileMap();
  const replacements = new Map();
  const missing = new Set();
  const inlinePattern = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g;
  const targets = new Set();

  let match;
  while ((match = inlinePattern.exec(markdown))) {
    const target = match[1] || match[2];
    if (target && !isRemotePath(target)) targets.add(target);
  }

  const referenceIds = new Set();
  const referenceImagePattern = /!\[([^\]]*)\]\[([^\]]*)\]/g;
  while ((match = referenceImagePattern.exec(markdown))) {
    referenceIds.add((match[2] || match[1]).trim().toLowerCase());
  }

  const definitionPattern = /^\s*\[([^\]]+)\]:\s*(?:<([^>]+)>|([^\s]+))/gm;
  while ((match = definitionPattern.exec(markdown))) {
    if (!referenceIds.has(match[1].trim().toLowerCase())) continue;
    const target = match[2] || match[3];
    if (target && !isRemotePath(target)) targets.add(target);
  }

  await Promise.all([...targets].map(async (target) => {
    const file = resolveImageFile(target, markdownFile, fileMap);
    if (!file || !isImageFile(file)) {
      missing.add(target);
      return;
    }
    replacements.set(target, await readFileAsDataUrl(file));
  }));

  let output = markdown;
  for (const [target, dataUrl] of replacements) {
    output = output.replace(new RegExp(escapeRegExp(target), "g"), dataUrl);
  }
  return { markdown: output, missing: [...missing] };
}

function slugify(text, index) {
  const slug = text.trim().toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `section-${index + 1}`;
}

function enhanceDocument(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  const headings = [...template.content.querySelectorAll("h1, h2, h3")];
  const usedIds = new Set();
  let section = 0;
  let subsection = 0;

  headings.forEach((heading, index) => {
    let id = slugify(heading.textContent, index);
    const base = id;
    let suffix = 2;
    while (usedIds.has(id)) id = `${base}-${suffix++}`;
    usedIds.add(id);
    heading.id = id;

    if (elements.numbered.checked) {
      if (heading.tagName === "H2") {
        section += 1;
        subsection = 0;
        heading.textContent = `${section}. ${heading.textContent}`;
      } else if (heading.tagName === "H3" && section > 0) {
        subsection += 1;
        heading.textContent = `${section}.${subsection} ${heading.textContent}`;
      }
    }
  });

  template.content.querySelectorAll("a[href]").forEach((link) => {
    if (/^https?:/i.test(link.getAttribute("href"))) {
      link.target = "_blank";
      link.rel = "noreferrer";
    }
  });

  if (elements.toc.checked && headings.length) {
    const nav = document.createElement("nav");
    nav.className = "document-toc";
    nav.setAttribute("aria-label", "目录");
    nav.innerHTML = `<strong>目录</strong><ol>${headings.map((heading) =>
      `<li class="toc-${heading.tagName.toLowerCase()}"><a href="#${heading.id}">${escapeHtml(heading.textContent)}</a></li>`
    ).join("")}</ol>`;
    const firstHeading = template.content.querySelector("h1");
    if (firstHeading) firstHeading.after(nav);
    else template.content.prepend(nav);
  }

  return template.innerHTML;
}

async function renderDocument() {
  if (!state.currentFile) return;
  if (!window.marked || !window.DOMPurify) {
    updateStatus("转换组件加载失败，请检查网络后刷新页面", true);
    return;
  }

  const source = elements.source.value;
  elements.sourceMeta.textContent = `${source.length.toLocaleString("zh-CN")} 字符`;

  if (!source.trim()) {
    state.renderedHtml = "";
    elements.preview.innerHTML = '<div class="empty-document"><strong>这份 Markdown 还没有内容</strong><span>可以在左侧输入内容，预览会自动更新。</span></div>';
    updateStatus("当前 Markdown 为空", true, "输入内容后即可下载 HTML 或打印 PDF");
    setStep(2);
    return;
  }

  try {
    const { markdown, missing } = await embedLocalImages(source, state.currentFile);
    const rawHtml = window.marked.parse(markdown, { gfm: true, breaks: false });
    const safeHtml = window.DOMPurify.sanitize(rawHtml, { USE_PROFILES: { html: true } });
    let html = enhanceDocument(safeHtml);

    if (missing.length) {
      const warning = `<div class="missing-image"><strong>未找到 ${missing.length} 张本地图片：</strong><br>${missing.map(escapeHtml).join("<br>")}</div>`;
      html = warning + html;
      const onlyMarkdownFiles = state.files.every((file) => /\.(?:md|markdown)$/i.test(file.name));
      const missingImageHint = onlyMarkdownFiles
        ? "当前只选择了 Markdown；如文档引用本地图片，请改用“选择整个文件夹”"
        : "检查图片路径，或重新选择包含图片的文件夹";
      updateStatus(`已转换，但有 ${missing.length} 张图片未找到`, true, missingImageHint);
    } else {
      updateStatus("转换完成，所有本地图片已嵌入", false);
    }

    state.renderedHtml = html;
    elements.preview.innerHTML = html;
    setStep(2);
  } catch (error) {
    console.error(error);
    state.renderedHtml = "";
    updateStatus("转换失败", true, "文件可能已损坏；请重新选择文件后再试");
  }
}

function updateStatus(message, warning, detail) {
  elements.resultStatus.classList.toggle("has-warning", warning);
  elements.resultStatus.querySelector(".status-icon").textContent = warning ? "!" : "✓";
  elements.resultStatus.querySelector("strong").textContent = message;
  elements.resultStatus.querySelector("small").textContent = detail || (warning
    ? "检查图片路径，或重新选择包含图片的文件夹"
    : "文件只在当前浏览器中处理");
}

function scheduleRender() {
  window.clearTimeout(state.renderTimer);
  state.renderTimer = window.setTimeout(renderDocument, 280);
}

async function selectMarkdown(file) {
  if (!file) {
    updateStatus("无法打开所选文档", true, "请重新选择 Markdown 文件");
    return false;
  }
  try {
    state.currentFile = file;
    elements.source.value = await readMarkdown(file);
    await renderDocument();
    return true;
  } catch (error) {
    console.error(error);
    state.renderedHtml = "";
    elements.preview.innerHTML = "";
    updateStatus("Markdown 读取失败", true, "文件可能已损坏或已被其他程序移除");
    return false;
  }
}

async function loadFiles(files) {
  const receivedFiles = [...files];
  if (!receivedFiles.length) return false;
  if (receivedFiles.length > LIMITS.maxFiles) {
    showToast(`文件过多：最多一次处理 ${LIMITS.maxFiles} 个文件`);
    return false;
  }

  const unique = new Map();
  for (const file of receivedFiles) unique.set(filePath(file).toLowerCase(), file);
  const selectedFiles = [...unique.values()];
  const markdownCandidates = selectedFiles.filter(isMarkdownFile);
  const imageCandidates = selectedFiles.filter((file) => !isMarkdownFile(file) && isImageFile(file));
  const unsupportedCount = selectedFiles.length - markdownCandidates.length - imageCandidates.length;

  if (markdownCandidates.length > LIMITS.maxMarkdownFiles) {
    showToast(`Markdown 过多：最多一次处理 ${LIMITS.maxMarkdownFiles} 份`);
    return false;
  }

  const oversizedMarkdown = markdownCandidates.filter((file) => file.size > LIMITS.maxMarkdownBytes);
  const oversizedImages = imageCandidates.filter((file) => file.size > LIMITS.maxImageBytes);
  const sizeAcceptedMarkdown = markdownCandidates.filter((file) => file.size <= LIMITS.maxMarkdownBytes);
  const acceptedImages = imageCandidates.filter((file) => file.size <= LIMITS.maxImageBytes);
  const binaryChecks = await Promise.all(sizeAcceptedMarkdown.map(async (file) => ({
    file,
    binary: await looksLikeBinary(file),
  })));
  const acceptedMarkdown = binaryChecks.filter((item) => !item.binary).map((item) => item.file);
  const binaryCount = binaryChecks.length - acceptedMarkdown.length;
  const acceptedFiles = [...acceptedMarkdown, ...acceptedImages];
  const totalBytes = acceptedFiles.reduce((total, file) => total + file.size, 0);

  if (totalBytes > LIMITS.maxTotalBytes) {
    showToast(`文件总计 ${formatSize(totalBytes)}，一次最多处理 ${formatSize(LIMITS.maxTotalBytes)}`);
    return false;
  }

  state.files = acceptedFiles;
  state.markdownFiles = acceptedMarkdown
    .sort((a, b) => filePath(a).localeCompare(filePath(b), "zh-CN"));

  if (!state.markdownFiles.length) {
    const reason = oversizedMarkdown.length || binaryCount
      ? "Markdown 过大、损坏或不是文本文件"
      : "仅支持 .md 和 .markdown 文件";
    showToast(`没有可用的 Markdown：${reason}`);
    return false;
  }

  elements.documentSelect.innerHTML = state.markdownFiles.map((file, index) =>
    `<option value="${index}">${escapeHtml(filePath(file))}</option>`
  ).join("");
  elements.uploadPanel.hidden = true;
  elements.workspace.hidden = false;
  const opened = await selectMarkdown(state.markdownFiles[0]);
  if (!opened) return false;
  elements.workspace.scrollIntoView({ behavior: "smooth", block: "start" });
  const notices = [];
  if (unsupportedCount) notices.push(`忽略 ${unsupportedCount} 个无关文件`);
  if (oversizedMarkdown.length) notices.push(`跳过 ${oversizedMarkdown.length} 份超过 10MB 的 Markdown`);
  if (oversizedImages.length) notices.push(`跳过 ${oversizedImages.length} 张超过 25MB 的图片`);
  if (binaryCount) notices.push(`跳过 ${binaryCount} 份非文本 Markdown`);
  if (notices.length) showToast(notices.join("；"));
  return true;
}

async function handleFileSelection(files, failureMessage = "文件读取失败，请重新选择") {
  try { return await loadFiles(files); }
  catch (error) {
    console.error(error);
    showToast(failureMessage);
    return false;
  }
}

function resetWorkspace() {
  state.files = [];
  state.markdownFiles = [];
  state.currentFile = null;
  state.renderedHtml = "";
  elements.folderInput.value = "";
  elements.fileInput.value = "";
  elements.multiMdInput.value = "";
  elements.source.value = "";
  elements.preview.innerHTML = "";
  elements.workspace.hidden = true;
  elements.uploadPanel.hidden = false;
  setStep(1);
}

function readAllDirectoryEntries(reader) {
  return new Promise((resolve, reject) => {
    const entries = [];
    const readBatch = () => reader.readEntries((batch) => {
      if (!batch.length) return resolve(entries);
      entries.push(...batch);
      readBatch();
    }, reject);
    readBatch();
  });
}

async function entryToFiles(entry, parentPath = "") {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    Object.defineProperty(file, "relativePath", {
      value: normalizePath(`${parentPath}/${file.name}`),
      configurable: true,
    });
    return [file];
  }
  if (!entry.isDirectory) return [];
  const entries = await readAllDirectoryEntries(entry.createReader());
  const nested = await Promise.all(entries.map((child) => entryToFiles(child, `${parentPath}/${entry.name}`)));
  return nested.flat();
}

async function filesFromDrop(dataTransfer) {
  const entries = [...dataTransfer.items]
    .map((item) => item.webkitGetAsEntry?.())
    .filter(Boolean);
  if (!entries.length) return [...dataTransfer.files];
  return (await Promise.all(entries.map((entry) => entryToFiles(entry)))).flat();
}

function documentTitle() {
  return state.currentFile?.name.replace(/\.(?:md|markdown)$/i, "") || "Markdown 文档";
}

function buildStandaloneDocument() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${escapeHtml(documentTitle())}</title><style>${DOCUMENT_CSS}</style></head>
<body>${state.renderedHtml}</body></html>`;
}

function downloadHtml() {
  if (!state.renderedHtml) return;
  const blob = new Blob([buildStandaloneDocument()], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${documentTitle()}.html`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStep(3);
  showToast("HTML 已开始下载");
}

function printPdf() {
  if (!state.renderedHtml) return;
  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    showToast("浏览器阻止了打印窗口，请允许弹出窗口");
    return;
  }
  printWindow.document.open();
  printWindow.document.write(buildStandaloneDocument());
  printWindow.document.close();
  const openPrintDialog = () => {
    window.setTimeout(() => {
      printWindow.focus();
      printWindow.print();
    }, 250);
  };
  if (printWindow.document.readyState === "complete") openPrintDialog();
  else printWindow.addEventListener("load", openPrintDialog, { once: true });
  setStep(3);
}

elements.folderInput.addEventListener("change", () => handleFileSelection(elements.folderInput.files, "文件夹读取失败，请重新选择"));
elements.fileInput.addEventListener("change", () => handleFileSelection(elements.fileInput.files));
elements.multiMdInput.addEventListener("change", () => handleFileSelection(elements.multiMdInput.files));
elements.documentSelect.addEventListener("change", () => selectMarkdown(state.markdownFiles[Number(elements.documentSelect.value)]));
elements.source.addEventListener("input", scheduleRender);
elements.toc.addEventListener("change", renderDocument);
elements.numbered.addEventListener("change", renderDocument);
elements.changeFiles.addEventListener("click", resetWorkspace);
elements.downloadHtml.addEventListener("click", downloadHtml);
elements.printPdf.addEventListener("click", printPdf);

["dragenter", "dragover"].forEach((eventName) => {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("is-dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("is-dragging");
  });
});

elements.dropZone.addEventListener("drop", async (event) => {
  try { await handleFileSelection(await filesFromDrop(event.dataTransfer)); }
  catch (error) {
    console.error(error);
    showToast("读取文件夹失败，请使用选择文件夹按钮");
  }
});
