# -*- coding: utf-8 -*-
"""ArtGen 桌面生图工具入口：启动 pywebview 窗口，挂载后端 js_api。"""
import os
import sys
import json
from pathlib import Path

import webview

from backend import Backend


def _resource_path(rel: str) -> str:
    """兼容 PyInstaller 打包后的资源路径。"""
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, rel)


def main():
    backend = Backend()
    html_path = _resource_path(os.path.join("web", "index.html"))
    webview.create_window(
        "image生图助手",
        url=html_path,
        js_api=backend,
        width=1280,
        height=840,
        min_size=(980, 640),
    )
    webview.start(icon=_resource_path("app_icon.ico"))


def run_self_test(output_path: str) -> int:
    """供发布包验收使用：走与界面生图相同的后端并把结果写到指定文件。"""
    report = {"ok": False}
    try:
        record = Backend().generate(
            "极简白色背景上的一颗蓝色玻璃球，柔和棚拍光，商业产品摄影",
            "gpt-image-2.5",
            "1536x1024",
            "auto",
        )
        image_path = Path(record.get("file_path", ""))
        report = {
            "ok": image_path.is_file() and image_path.stat().st_size > 0,
            "model": record.get("model"),
            "size": record.get("size"),
            "image_path": str(image_path),
            "image_bytes": image_path.stat().st_size if image_path.is_file() else 0,
            "record_id": record.get("id"),
        }
    except Exception as exc:
        report["error"] = f"{type(exc).__name__}: {exc}"
    Path(output_path).write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
    return 0 if report.get("ok") else 1


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--self-test":
        raise SystemExit(run_self_test(sys.argv[2]))
    main()
