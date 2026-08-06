#!/usr/bin/env python3
"""Convert every Markdown file in a folder to printable, standalone HTML.

Requirements:
    Pandoc: https://pandoc.org/installing.html

Examples:
    python md_to_html.py
    # Then paste: D:\美妆

    python md_to_html.py "D:\美妆"
    python md_to_html.py "D:\资料\美妆" --toc

Local image paths such as ``images/photo.png`` are resolved relative to each
Markdown file. By default, Pandoc embeds images into the generated HTML, so the
result is a portable single file.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import List, Optional, Tuple


PRINT_CSS = r"""
:root {
  color-scheme: light;
  --text: #222;
  --muted: #666;
  --border: #b8b8b8;
  --shade: #f5f6f8;
  --accent: #315a86;
}

* { box-sizing: border-box; }

html {
  background: #eceff3;
  -webkit-text-size-adjust: 100%;
}

body {
  max-width: 920px;
  margin: 28px auto;
  padding: 44px 54px;
  background: #fff;
  color: var(--text);
  font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC",
               "Source Han Sans SC", Arial, sans-serif;
  font-size: 15px;
  line-height: 1.75;
  overflow-wrap: anywhere;
}

h1, h2, h3, h4 {
  line-height: 1.35;
  color: #182536;
  break-after: avoid-page;
  page-break-after: avoid;
}

h1 {
  margin: 0 0 1.2em;
  padding-bottom: .55em;
  border-bottom: 2px solid var(--accent);
  font-size: 2em;
  text-align: center;
}

h2 {
  margin-top: 2em;
  padding-bottom: .35em;
  border-bottom: 1px solid #d7dde4;
  font-size: 1.55em;
}

h3 { margin-top: 1.55em; font-size: 1.24em; }
h4 { margin-top: 1.35em; font-size: 1.08em; }

p { margin: .7em 0; }
ul, ol { padding-left: 1.8em; }
li + li { margin-top: .25em; }

a { color: #245b8f; text-decoration: none; }
strong { color: #142338; }
hr { margin: 2em 0; border: 0; border-top: 1px solid #ccd2d9; }

img {
  display: block;
  max-width: 100%;
  max-height: 220mm;
  width: auto;
  height: auto;
  margin: 1.1em auto;
  object-fit: contain;
  break-inside: avoid-page;
  page-break-inside: avoid;
}

figure { margin: 1.2em 0; text-align: center; }
figcaption { margin-top: .4em; color: var(--muted); font-size: .9em; }

table {
  width: 100%;
  margin: 1.2em 0;
  border-collapse: collapse;
  table-layout: auto;
  font-size: .92em;
}

thead { display: table-header-group; }
tr {
  break-inside: avoid-page;
  page-break-inside: avoid;
}
th, td {
  padding: .52em .62em;
  border: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
}
th { background: #edf1f5; font-weight: 700; }
tbody tr:nth-child(even) { background: #fafbfc; }

blockquote {
  margin: 1em 0;
  padding: .6em 1em;
  border-left: 4px solid #8296aa;
  background: var(--shade);
  color: #303842;
}
blockquote > :first-child { margin-top: 0; }
blockquote > :last-child { margin-bottom: 0; }

code {
  padding: .12em .32em;
  border-radius: 3px;
  background: #f0f2f4;
  font-family: Consolas, "SFMono-Regular", Menlo, monospace;
  font-size: .9em;
}

pre {
  padding: 1em;
  border: 1px solid #d7dce2;
  border-radius: 5px;
  background: #f6f8fa;
  white-space: pre-wrap;
  word-break: break-word;
  break-inside: avoid-page;
  page-break-inside: avoid;
}
pre code { padding: 0; background: transparent; }

#TOC {
  margin: 1.2em 0 2em;
  padding: 1em 1.4em;
  border: 1px solid #d7dde4;
  background: #fafbfc;
}
#TOC::before { content: "目录"; font-weight: 700; font-size: 1.15em; }
#TOC ul { margin: .55em 0 0; }

.page-break {
  break-before: page;
  page-break-before: always;
}

@page {
  size: A4;
  margin: 17mm 15mm 18mm;
}

@media print {
  html { background: #fff; }
  body {
    max-width: none;
    margin: 0;
    padding: 0;
    font-size: 10.5pt;
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }
  a { color: inherit; }
  a[href^="http"]::after { content: none; }
  p { orphans: 3; widows: 3; }
}
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="输入一个文件夹地址，自动将其中所有 Markdown 转为独立 HTML。"
    )
    parser.add_argument(
        "input", nargs="?", type=Path,
        help="包含 Markdown 的文件夹；省略时程序会提示粘贴地址",
    )
    parser.add_argument(
        "-o", "--output", type=Path,
        help="可选输出目录；默认在每个 Markdown 旁生成同名 HTML",
    )
    parser.add_argument("--toc", action="store_true", help="生成目录")
    parser.add_argument(
        "--number-sections", action="store_true", help="自动为标题编号"
    )
    parser.add_argument(
        "--skip-existing", action="store_true", help="已有同名 HTML 时跳过"
    )
    parser.add_argument(
        "--lang", default="zh-CN", help="HTML 语言标记，默认 zh-CN"
    )
    return parser.parse_args()


def get_input_path(args: argparse.Namespace) -> Path:
    """Read a folder path from the command line or an interactive prompt."""
    if args.input is not None:
        return args.input

    print("请输入包含 Markdown 文档的文件夹地址。")
    print(r"例如：D:\杉数科技\深职大项目案例\美妆")
    try:
        raw_path = input("文件夹地址：").strip()
    except EOFError as exc:
        raise ValueError("没有收到文件夹地址。") from exc

    # Windows Explorer's “Copy as path” usually includes surrounding quotes.
    raw_path = raw_path.strip('"').strip("'").strip()
    if not raw_path:
        raise ValueError("文件夹地址不能为空。")
    return Path(raw_path)


def find_pandoc() -> str:
    """Find Pandoc from PATH and common Windows/Conda installation folders."""
    pandoc = shutil.which("pandoc")
    if pandoc:
        return pandoc

    candidates: List[Path] = []

    configured_path = os.environ.get("PANDOC_PATH")
    if configured_path:
        candidates.append(Path(configured_path))

    local_appdata = os.environ.get("LOCALAPPDATA")
    program_files = os.environ.get("ProgramFiles")
    program_files_x86 = os.environ.get("ProgramFiles(x86)")
    conda_prefix = os.environ.get("CONDA_PREFIX")

    if local_appdata:
        local_root = Path(local_appdata)
        candidates.extend([
            local_root / "Pandoc" / "pandoc.exe",
            local_root / "Microsoft" / "WinGet" / "Links" / "pandoc.exe",
        ])
        winget_packages = local_root / "Microsoft" / "WinGet" / "Packages"
        if winget_packages.is_dir():
            for package in winget_packages.glob("JohnMacFarlane.Pandoc*"):
                candidates.extend(package.rglob("pandoc.exe"))

    for base in (program_files, program_files_x86):
        if base:
            candidates.append(Path(base) / "Pandoc" / "pandoc.exe")

    if conda_prefix:
        conda_root = Path(conda_prefix)
        candidates.extend([
            conda_root / "Library" / "bin" / "pandoc.exe",
            conda_root / "Scripts" / "pandoc.exe",
            conda_root / "pandoc.exe",
        ])

    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)

    checked = "\n".join(f"  - {path}" for path in candidates)
    raise RuntimeError(
        "已尝试从 PATH 和常见安装目录查找 Pandoc，但仍未找到 pandoc.exe。\n"
        "如果你知道 pandoc.exe 的位置，可设置环境变量 PANDOC_PATH。\n"
        f"已检查：\n{checked or '  （没有可检查的 Windows 安装目录）'}"
    )


def extract_page_title(md_file: Path) -> str:
    """Use the first level-1 heading as the browser title, if present."""
    try:
        text = md_file.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        text = md_file.read_text(encoding="gb18030")

    match = re.search(r"(?m)^\s*#\s+(.+?)\s*#*\s*$", text)
    if not match:
        return md_file.stem

    title = match.group(1)
    title = re.sub(r"!\[[^]]*]\([^)]*\)", "", title)
    title = re.sub(r"\[([^]]+)]\([^)]*\)", r"\1", title)
    title = re.sub(r"[*_`~]", "", title).strip()
    return title or md_file.stem


def supports_embed_resources(pandoc: str) -> bool:
    result = subprocess.run(
        [pandoc, "--help"], capture_output=True, text=True, encoding="utf-8"
    )
    return "--embed-resources" in result.stdout


def output_for_single(source: Path, requested: Optional[Path]) -> Path:
    if requested is None:
        return source.with_suffix(".html")
    if requested.exists() and requested.is_dir():
        return requested / f"{source.stem}.html"
    if requested.suffix.lower() not in {".html", ".htm"}:
        return requested / f"{source.stem}.html"
    return requested


def collect_jobs(args: argparse.Namespace) -> List[Tuple[Path, Path]]:
    source = get_input_path(args).expanduser().resolve()
    if not source.exists():
        raise FileNotFoundError(f"输入路径不存在：{source}")

    if source.is_file():
        if source.suffix.lower() not in {".md", ".markdown"}:
            raise ValueError("输入文件扩展名必须是 .md 或 .markdown")
        output = output_for_single(
            source, args.output.expanduser().resolve() if args.output else None
        )
        return [(source, output)]

    output_root = args.output.expanduser().resolve() if args.output else None
    candidates = sorted(
        path for path in source.rglob("*")
        if path.is_file() and path.suffix.lower() in {".md", ".markdown"}
    )
    if not candidates:
        raise FileNotFoundError(f"目录及其子目录中没有找到 Markdown 文件：{source}")

    jobs: List[Tuple[Path, Path]] = []
    for md_file in candidates:
        if output_root is None:
            output = md_file.with_suffix(".html")
        else:
            relative = md_file.relative_to(source).with_suffix(".html")
            output = output_root / relative
        jobs.append((md_file, output))
    return jobs


def convert_one(
    pandoc: str,
    source: Path,
    output: Path,
    args: argparse.Namespace,
    css_header: Path,
    embed_option: str,
) -> str:
    if output.exists() and args.skip_existing:
        return f"跳过（HTML 已存在）：{output}"

    output.parent.mkdir(parents=True, exist_ok=True)
    command = [
        pandoc,
        str(source),
        "--from=markdown",
        "--to=html5",
        "--standalone",
        f"--resource-path={source.parent}",
        f"--variable=lang:{args.lang}",
        f"--metadata=pagetitle:{extract_page_title(source)}",
        f"--include-in-header={css_header}",
        "--output",
        str(output),
    ]

    command.append(embed_option)
    if args.toc:
        command.extend(["--toc", "--toc-depth=3"])
    if args.number_sections:
        command.append("--number-sections")

    result = subprocess.run(
        command,
        cwd=source.parent,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "未知错误"
        raise RuntimeError(f"转换失败：{source}\n{detail}")

    warning = result.stderr.strip()
    if warning:
        return f"完成：{output}\n  Pandoc 提示：{warning}"
    return f"完成：{output}"


def main() -> int:
    args = parse_args()
    try:
        jobs = collect_jobs(args)
        pandoc = find_pandoc()
        embed_option = (
            "--embed-resources"
            if supports_embed_resources(pandoc)
            else "--self-contained"
        )

        print(f"\n找到 {len(jobs)} 个 Markdown 文档，开始转换……\n")
        success_count = 0
        skipped_count = 0
        failures: List[str] = []

        with tempfile.TemporaryDirectory(prefix="md_to_html_") as temp_dir:
            css_header = Path(temp_dir) / "print-style.html"
            css_header.write_text(
                f"<style>\n{PRINT_CSS}\n</style>\n", encoding="utf-8"
            )
            for source, output in jobs:
                try:
                    message = convert_one(
                        pandoc, source, output, args, css_header, embed_option
                    )
                    print(message)
                    if message.startswith("跳过"):
                        skipped_count += 1
                    else:
                        success_count += 1
                except (RuntimeError, OSError) as exc:
                    failures.append(str(exc))
                    print(f"失败：{source}\n  {exc}", file=sys.stderr)

        print(
            f"\n处理结束：成功 {success_count} 个，"
            f"跳过 {skipped_count} 个，失败 {len(failures)} 个。"
        )
        return 1 if failures else 0
    except (FileNotFoundError, ValueError, RuntimeError, OSError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
