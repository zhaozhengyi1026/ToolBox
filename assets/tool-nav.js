(() => {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  const mode = new URLSearchParams(window.location.search).get("mode");
  const items = [
    ["首页 · 全部工具", "/", "home"],
    ["MD 转换成 PDF", "/md2pdf", "md"],
    ["拆分 PDF", "/pdf-tools/?mode=split", "pdf-split"],
    ["PDF 转图片", "/pdf-tools/?mode=image", "pdf-image"],
    ["压缩 PDF", "/pdf-tools/?mode=compress", "pdf-compress"],
    ["图片转 PDF", "/image-tools/?mode=pdf", "image-pdf"],
    ["图片压缩", "/image-tools/?mode=compress", "image-compress"],
    ["临时邮箱", "https://maildock-liard.vercel.app/", "mail", "target=\"_blank\" rel=\"noreferrer\""],
    ["MyACG", "/阅读小软件/MyACG.apk", "acg", "download"]
  ];
  const current = path === "/md2pdf" ? "md" : path === "/pdf-tools" ? `pdf-${mode}` : path === "/image-tools" ? `image-${mode}` : "";
  const link = ([label, href, key, attributes = ""]) => `<a href="${href}"${attributes ? ` ${attributes}` : ""}${key === current ? ' class="is-current" aria-current="page"' : ""}>${label}</a>`;
  const nav = document.createElement("aside");
  nav.className = "tool-nav";
  nav.id = "tool-nav";
  nav.setAttribute("aria-label", "所有工具");
  nav.innerHTML = `
    <a class="tool-nav-brand" href="/" aria-label="ToolBox 首页"><span class="tool-nav-mark" aria-hidden="true"><i></i><i></i><i></i></span><span>ToolBox</span></a>
    <div class="tool-nav-home">${link(items[0])}</div>
    <div class="tool-nav-group"><span>文档</span>${link(items[1])}</div>
    <div class="tool-nav-group"><span>PDF</span>${items.slice(2, 5).map(link).join("")}</div>
    <div class="tool-nav-group"><span>图片</span>${items.slice(5, 7).map(link).join("")}</div>
    <div class="tool-nav-group"><span>其他</span>${items.slice(7).map(link).join("")}</div>
    <p class="tool-nav-footer">文件处理在本地浏览器中完成</p>`;

  const toggle = document.createElement("button");
  toggle.className = "tool-nav-toggle";
  toggle.type = "button";
  toggle.setAttribute("aria-controls", "tool-nav");
  toggle.setAttribute("aria-expanded", "false");
  toggle.innerHTML = '<i aria-hidden="true"></i><span>所有工具</span>';
  const backdrop = document.createElement("button");
  backdrop.className = "tool-nav-backdrop";
  backdrop.type = "button";
  backdrop.setAttribute("aria-label", "关闭工具导航");

  function setOpen(open) {
    nav.classList.toggle("is-open", open);
    backdrop.classList.toggle("is-visible", open);
    document.body.classList.toggle("tool-nav-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    if (open) nav.querySelector("a")?.focus();
    else toggle.focus();
  }

  toggle.addEventListener("click", () => setOpen(!nav.classList.contains("is-open")));
  backdrop.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && nav.classList.contains("is-open")) setOpen(false); });
  document.body.classList.add("has-tool-nav");
  document.body.prepend(nav, backdrop, toggle);
})();
