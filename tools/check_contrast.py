"""对比度验收：直接解析 tokens.css，按 WCAG 2.1 计算两套主题的实际比值。

不依赖浏览器，可以在提交前跑。正文要求 4.5:1，大字与图形要求 3:1。
用法：
    python tools/check_contrast.py            # 打印表格
    python tools/check_contrast.py --strict    # 有失败项时退出码非 0
"""

from __future__ import annotations

import argparse
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKENS = os.path.join(ROOT, "frontend", "src", "theme", "tokens.css")

# (前景, 背景, 阈值, 用途说明)
PAIRS = [
    ("text", "bg", 4.5, "正文 / 页面背景"),
    ("text", "panel", 4.5, "正文 / 面板"),
    ("text-muted", "bg", 4.5, "次要文本 / 页面背景"),
    ("text-muted", "panel", 4.5, "次要文本 / 面板"),
    ("text-faint", "panel", 4.5, "辅助文本 / 面板"),
    ("text-faint", "bg", 4.5, "辅助文本 / 页面背景"),
    ("text-faint", "bg-sunken", 4.5, "辅助文本 / 沉底区域"),
    ("accent", "panel", 4.5, "链接与选中 / 面板"),
    ("accent", "bg", 4.5, "链接与选中 / 页面背景"),
    ("risk", "panel", 4.5, "风险标记 / 面板"),
    ("risk", "risk-soft", 4.5, "风险标记 / 风险底色"),
    ("warn", "panel", 4.5, "待核验标记 / 面板"),
    ("warn", "warn-soft", 4.5, "待核验标记 / 提醒底色"),
    ("accent-contrast", "accent", 4.5, "主按钮文字 / 主色"),
    ("text-muted", "bg-sunken", 4.5, "次要文本 / 沉底区域"),
    ("cat-1", "panel", 3.0, "类别色 1 / 面板"),
    ("cat-2", "panel", 3.0, "类别色 2 / 面板"),
    ("cat-3", "panel", 3.0, "类别色 3 / 面板"),
    ("cat-4", "panel", 3.0, "类别色 4 / 面板"),
    ("cat-5", "panel", 3.0, "类别色 5 / 面板"),
    ("cat-6", "panel", 3.0, "类别色 6 / 面板"),
    ("cat-7", "panel", 3.0, "类别色 7 / 面板"),
    ("cat-8", "panel", 3.0, "类别色 8 / 面板"),
]


def parse_blocks(css: str) -> dict[str, dict[str, str]]:
    """取出 :root[data-theme="light"] 与 dark 两个块里的变量。"""
    blocks: dict[str, dict[str, str]] = {}
    for theme in ("light", "dark"):
        match = re.search(
            r':root\[data-theme="' + theme + r'"\]\s*\{(.*?)\}', css, re.S
        )
        if not match:
            raise SystemExit(f"tokens.css 里找不到 {theme} 主题块")
        values: dict[str, str] = {}
        for name, value in re.findall(r"--([\w-]+):\s*(#[0-9a-fA-F]{3,8})", match.group(1)):
            values[name] = value
        blocks[theme] = values
    return blocks


def channel(value: int) -> float:
    c = value / 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def luminance(hex_color: str) -> float:
    h = hex_color.lstrip("#")
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    r, g, b = (int(h[i : i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def contrast(fg: str, bg: str) -> float:
    l1, l2 = luminance(fg), luminance(bg)
    hi, lo = max(l1, l2), min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--strict", action="store_true", help="有失败项时退出码非 0")
    args = parser.parse_args()

    with open(TOKENS, "r", encoding="utf-8") as f:
        blocks = parse_blocks(f.read())

    failures: list[str] = []
    for theme, values in blocks.items():
        print(f"\n=== {theme} ===")
        print(f"{'前景 / 背景':<34}{'比值':>7}{'阈值':>7}  结果  用途")
        for fg, bg, threshold, label in PAIRS:
            fg_value, bg_value = values.get(fg), values.get(bg)
            if not fg_value or not bg_value:
                failures.append(f"{theme}: 缺少 token --{fg} 或 --{bg}")
                print(f"{fg + ' / ' + bg:<34}{'—':>7}{threshold:>7}  SKIP  {label}")
                continue
            ratio = contrast(fg_value, bg_value)
            ok = ratio >= threshold
            if not ok:
                failures.append(f"{theme}: {label} 仅 {ratio:.2f}:1（需 {threshold}:1）")
            print(f"{fg + ' / ' + bg:<34}{ratio:>7.2f}{threshold:>7}  {'OK  ' if ok else 'FAIL'}  {label}")

    print()
    if failures:
        print(f"未通过 {len(failures)} 项：")
        for item in failures:
            print("  -", item)
        if args.strict:
            raise SystemExit(1)
    else:
        print("全部通过：正文 ≥ 4.5:1，图形与类别色 ≥ 3:1")


if __name__ == "__main__":
    main()
