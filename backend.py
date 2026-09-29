# -*- coding: utf-8 -*-
"""ArtGen 后端：封装 BeeAPI 生图/图生图、历史记录与本地存储。

所有非下划线开头的公开方法会被 pywebview 作为 js_api 暴露给前端调用。
"""
import base64
import json
import mimetypes
import os
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

from openai import OpenAI

import webview

DATA_DIR = Path.home() / "ArtGen"
CONFIG_FILE = DATA_DIR / "config.json"
DEFAULT_BASE_URL = "https://beeapi.dev/v1"
DEFAULT_VISION_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
DEFAULT_VISION_MODEL = "doubao-seed-evolving"
ORIGINALS_DIR = DATA_DIR / "原图"
THUMBS_DIR = DATA_DIR / "缩略图"
DB_FILE = DATA_DIR / "artgen.db"

_THUMB_MAX = 360  # 缩略图最长边像素


def load_config() -> dict:
    """读取软件独立配置，避免被 .codex/auth.json 切换影响。"""
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"api_key": "", "base_url": DEFAULT_BASE_URL}


def get_api_key() -> str:
    return load_config().get("api_key", "").strip()


def get_base_url() -> str:
    return (load_config().get("base_url") or "").strip() or DEFAULT_BASE_URL


def get_vision_api_key() -> str:
    """读取豆包视觉 Key。环境变量优先，避免把密钥写入源码。"""
    config = load_config()
    return (os.environ.get("ARK_API_KEY") or config.get("vision_api_key") or "").strip()


def get_vision_base_url() -> str:
    config = load_config()
    return (os.environ.get("ARK_BASE_URL") or config.get("vision_base_url") or DEFAULT_VISION_BASE_URL).strip()


def get_vision_model() -> str:
    config = load_config()
    return (os.environ.get("ARK_VISION_MODEL") or config.get("vision_model") or DEFAULT_VISION_MODEL).strip()


class Backend:
    def __init__(self):
        DATA_DIR.mkdir(exist_ok=True)
        ORIGINALS_DIR.mkdir(exist_ok=True)
        THUMBS_DIR.mkdir(exist_ok=True)
        self._lock = threading.Lock()
        self._init_db()

    # ---------- 数据库 ----------
    def _init_db(self):
        with sqlite3.connect(DB_FILE) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS images (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    prompt TEXT NOT NULL,
                    model TEXT,
                    size TEXT,
                    kind TEXT DEFAULT 'text2img',
                    file_path TEXT NOT NULL,
                    thumb_path TEXT,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.commit()

    def _save_record(self, prompt, model, size, kind, file_path, thumb_path):
        with sqlite3.connect(DB_FILE) as conn:
            cur = conn.execute(
                "INSERT INTO images (prompt, model, size, kind, file_path, thumb_path, created_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (prompt, model, size, kind, file_path, thumb_path,
                 datetime.now().isoformat(timespec="seconds")),
            )
            conn.commit()
            return cur.lastrowid

    # ---------- 工具 ----------
    def _client(self):
        return OpenAI(api_key=get_api_key(), base_url=get_base_url())

    def _vision_client(self):
        key = get_vision_api_key()
        if not key:
            raise ValueError("请先配置豆包视觉 API Key：ARK_API_KEY")
        return OpenAI(api_key=key, base_url=get_vision_base_url())

    @staticmethod
    def _detect_ext(data: bytes) -> str:
        """根据字节魔数判断真实图片格式，返回扩展名（默认 png）。"""
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            return "png"
        if data[:3] == b"\xff\xd8\xff":
            return "jpg"
        if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            return "webp"
        if data[:2] == b"BM":
            return "bmp"
        return "png"

    def _save_image(self, item) -> str:
        """根据生成结果落盘，按真实格式写扩展名，返回文件绝对路径。优先 b64_json，其次 url。"""
        ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        if getattr(item, "b64_json", None):
            data = base64.b64decode(item.b64_json)
        elif getattr(item, "url", None):
            data = urllib.request.urlopen(item.url).read()
        else:
            raise RuntimeError("生成结果缺少图片数据(b64_json/url)")
        out = ORIGINALS_DIR / f"img_{ts}.{self._detect_ext(data)}"
        out.write_bytes(data)
        return str(out)

    def _save_image_bytes(self, data: bytes) -> str:
        """保存已解析出的图片字节，供不依赖 SDK 响应模型的生图接口使用。"""
        if not data:
            raise RuntimeError("接口未返回图片数据")
        ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        out = ORIGINALS_DIR / f"img_{ts}.{self._detect_ext(data)}"
        out.write_bytes(data)
        return str(out)

    @staticmethod
    def _safe_image_size(size: str) -> str:
        """把任意尺寸按方向映射到上游兼容性最好的三个标准尺寸。"""
        value = (size or "").strip().lower()
        if value == "auto":
            return "1024x1024"
        try:
            width, height = (int(part) for part in value.split("x", 1))
            ratio = width / height
            if ratio > 1.15:
                return "1536x1024"
            if ratio < 0.87:
                return "1024x1536"
        except (TypeError, ValueError, ZeroDivisionError):
            pass
        return "1024x1024"

    @staticmethod
    def _image_bytes_from_response(payload: dict) -> bytes:
        """兼容代理接口常见的 data/images/output 与 base64/url 返回格式。"""
        error = payload.get("error")
        if error:
            if isinstance(error, dict):
                message = error.get("message") or error.get("code") or "未知接口错误"
            else:
                message = str(error)
            raise RuntimeError(f"接口返回错误：{message}")

        candidates = []
        for key in ("data", "images", "output"):
            value = payload.get(key)
            if isinstance(value, list):
                candidates.extend(item for item in value if isinstance(item, dict))
            elif isinstance(value, dict):
                candidates.append(value)

        for item in candidates:
            for key in ("b64_json", "base64", "image_base64"):
                value = item.get(key)
                if isinstance(value, str) and value:
                    if value.startswith("data:") and "," in value:
                        value = value.split(",", 1)[1]
                    try:
                        return base64.b64decode(value, validate=True)
                    except Exception as exc:
                        raise RuntimeError("接口返回了无效的图片 Base64 数据") from exc
            url = item.get("url")
            if not url and isinstance(item.get("image_url"), dict):
                url = item["image_url"].get("url")
            if isinstance(url, str) and url:
                with urllib.request.urlopen(url, timeout=180) as response:
                    return response.read()

        message = payload.get("message")
        if message:
            raise RuntimeError(f"接口返回错误：{message}")
        raise RuntimeError("接口未返回图片数据（响应中没有可用的 Base64 或图片 URL）")

    def _post_image_generation(self, body: dict) -> bytes:
        """直接读取生图接口原始 JSON，避免 SDK 在非标准代理响应上抛出 NoneType。"""
        key = get_api_key()
        if not key:
            raise ValueError("请先配置生图 API Key")
        url = get_base_url().rstrip("/") + "/images/generations"
        request = urllib.request.Request(
            url,
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "ArtGen-Windows/1.0",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                raw = response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            try:
                detail = json.loads(raw)
                error = detail.get("error", detail)
                if isinstance(error, dict):
                    message = error.get("message") or error.get("code") or raw
                else:
                    message = str(error)
            except Exception:
                message = raw or str(exc)
            raise RuntimeError(f"接口错误 {exc.code}：{message}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"网络连接失败：{exc.reason}") from exc

        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError("接口返回了无法识别的内容，请稍后重试") from exc
        if not isinstance(payload, dict):
            raise RuntimeError("接口返回格式不正确，请稍后重试")
        return self._image_bytes_from_response(payload)

    @staticmethod
    def _is_retryable_image_error(error: Exception) -> bool:
        message = str(error).lower()
        return any(word in message for word in (
            "upstream", "retry", "tempor", "timeout", "timed out",
            "未返回图片数据", "rejected", "connection reset", "连接被重置"
        ))

    def _make_thumb(self, src_path) -> str:
        """生成缩略图到缩略图文件夹，失败返回空串（前端回退用原图）。"""
        try:
            from PIL import Image
            im = Image.open(src_path)
            im.thumbnail((_THUMB_MAX, _THUMB_MAX))
            thumb = THUMBS_DIR / (Path(src_path).stem + ".thumb.jpg")
            im.convert("RGB").save(thumb, "JPEG", quality=80)
            return str(thumb)
        except Exception:
            return ""

    def _thumb_of(self, src_path, thumb_path):
        """返回可用于缩略图的路径：优先已存 thumb，其次现场生成，最后原图。"""
        if thumb_path and Path(thumb_path).exists():
            return thumb_path
        p = Path(src_path)
        if p.exists():
            made = self._make_thumb(src_path)
            if made:
                return made
            return str(p)
        return ""

    @staticmethod
    def _to_record(rec_id, prompt, model, size, kind, file_path, thumb_path, created_at):
        return {
            "id": rec_id, "prompt": prompt, "model": model, "size": size,
            "kind": kind, "file_path": file_path, "created_at": created_at,
            "thumb_path": thumb_path or "",
        }

    # ---------- 基础生图 ----------
    def generate(self, prompt, model="gpt-image-2.5", size="1024x1024", quality="auto"):
        prompt = (prompt or "").strip()
        if not prompt:
            raise ValueError("提示词不能为空")
        model = (model or "gpt-image-2.5").strip()
        requested_size = (size or "1024x1024").strip()
        quality = (quality or "auto").strip()
        body = {
            "model": model, "prompt": prompt, "size": requested_size,
            "n": 1, "response_format": "b64_json",
        }
        if quality and quality != "auto":
            body["quality"] = quality

        safe_size = self._safe_image_size(requested_size)
        attempts = (
            (body, requested_size, 0.0),
            ({"model": model, "prompt": prompt, "size": safe_size,
              "response_format": "b64_json"}, safe_size, 2.5),
            ({"model": model, "prompt": prompt, "size": "1024x1024",
              "response_format": "b64_json"}, "1024x1024", 5.0),
            ({"model": model, "prompt": prompt, "size": "1024x1024",
              "response_format": "b64_json"}, "1024x1024", 10.0),
        )
        last_error = None
        image_bytes = None
        used_model = model
        used_size = requested_size
        for index, (attempt_body, attempt_size, delay) in enumerate(attempts):
            if delay:
                time.sleep(delay)
            try:
                image_bytes = self._post_image_generation(attempt_body)
                used_size = attempt_size
                break
            except Exception as error:
                last_error = error
                if not self._is_retryable_image_error(error):
                    if index == 0:
                        raise
                    break

        # BeeAPI 是多商家聚合路由，某个 image-2.5 商家异常时，用基础 image-2
        # 做最后一次兼容降级，避免用户只能手工反复点击。
        if image_bytes is None and model != "gpt-image-2":
            fallback_model = "gpt-image-2"
            fallback_body = {
                "model": fallback_model, "prompt": prompt, "size": "1024x1024",
                "response_format": "b64_json",
            }
            try:
                time.sleep(2.5)
                image_bytes = self._post_image_generation(fallback_body)
                used_model = fallback_model
                used_size = "1024x1024"
            except Exception as fallback_error:
                last_error = fallback_error

        if image_bytes is None:
            raise RuntimeError(
                f"上游生图服务失败（已尝试模型 {model} 的 4 组参数"
                f"{('，并降级到 gpt-image-2' if model != 'gpt-image-2' else '')}）：{last_error}"
            ) from last_error

        path = self._save_image_bytes(image_bytes)
        thumb = self._make_thumb(path)
        rec_id = self._save_record(prompt, used_model, used_size, "text2img", path, thumb)
        return self._to_record(rec_id, prompt, used_model, used_size, "text2img", path, thumb,
                               datetime.now().isoformat(timespec="seconds"))

    # ---------- 图生图 / 编辑 ----------
    def edit(self, image_path, prompt, model="gpt-image-2.5", size="auto"):
        prompt = (prompt or "").strip()
        p = Path(image_path)
        if not p.exists():
            raise ValueError("源图片不存在")
        if not prompt:
            raise ValueError("请填写编辑描述")
        size = self._resolve_size(size, p)
        client = self._client()
        with p.open("rb") as f:
            res = client.images.edit(model=model, image=f, prompt=prompt, size=size)
        path = self._save_image(res.data[0])
        thumb = self._make_thumb(path)
        rec_id = self._save_record(prompt, model, size, "img2img", path, thumb)
        return self._to_record(rec_id, prompt, model, size, "img2img", path, thumb,
                               datetime.now().isoformat(timespec="seconds"))

    # ---------- 参考图编辑（多图输入：原图 + 参考图） ----------
    def reference_edit(self, image_path, ref_path, prompt, model="gpt-image-2.5", size="auto"):
        prompt = (prompt or "").strip()
        p = Path(image_path)
        r = Path(ref_path)
        if not p.exists():
            raise ValueError("原图不存在")
        if not r.exists():
            raise ValueError("参考图不存在")
        if not prompt:
            raise ValueError("请填写编辑描述")
        size = self._resolve_size(size, p)
        client = self._client()
        with p.open("rb") as f1, r.open("rb") as f2:
            res = client.images.edit(model=model, image=[f1, f2], prompt=prompt, size=size)
        path = self._save_image(res.data[0])
        thumb = self._make_thumb(path)
        rec_id = self._save_record(prompt, model, size, "img2img", path, thumb)
        return self._to_record(rec_id, prompt, model, size, "img2img", path, thumb,
                               datetime.now().isoformat(timespec="seconds"))

    # ---------- 图片转提示词（豆包视觉） ----------
    @staticmethod
    def _sanitize_vision_prompt(text: str) -> str:
        """把视觉模型可能生成的高风险身份/商标措辞改成更兼容文生图的描述。"""
        replacements = (
            ("女高中生", "明确成年的东亚年轻女性"),
            ("男高中生", "明确成年的东亚年轻男性"),
            ("高中生", "明确成年的年轻人"),
            ("未成年", "成年"),
            ("学生妹", "年轻女性"),
            ("少女", "年轻女性"),
            ("少年", "年轻男性"),
            ("女孩", "年轻女性"),
            ("男孩", "年轻男性"),
            ("女学生", "年轻女性"),
            ("男学生", "年轻男性"),
            ("女生", "年轻女性"),
            ("男生", "年轻男性"),
            ("校服", "校园风制服"),
            ("学生服", "校园风制服"),
            ("可口可乐", "红色饮料品牌风格"),
            ("Coca-Cola", "红色饮料品牌风格"),
        )
        changed = False
        for source, target in replacements:
            if source in text:
                text = text.replace(source, target)
                changed = True
        text = text.replace("年轻年轻", "年轻").replace("成年成年", "成年")
        text = text.replace("校园风校园风制服", "校园风制服")
        if changed and "18岁以上" not in text and "成年" not in text:
            text += " 人物明确设定为18岁以上成年人，避免未成年身份或性化描述。"
        return text.strip()

    def describe_image(self, image_path, model="", prompt_type="通用提示词", language="中文"):
        """让视觉模型分析本地图片，并返回经过提示词工程整理的生图提示词。"""
        p = Path(image_path)
        if not p.exists() or not p.is_file():
            raise ValueError("图片不存在")
        data = base64.b64encode(p.read_bytes()).decode("ascii")
        mime = mimetypes.guess_type(p.name)[0] or "image/png"
        model = (model or get_vision_model()).strip()
        prompt_type = (prompt_type or "通用提示词").strip()
        language = (language or "中文").strip()
        instruction = (
            "你是一名资深的视觉提示词工程师。输入图片是唯一事实来源，请先识别画面，再把可见信息"
            "压缩成一段可直接粘贴到文生图模型的最终提示词。\n"
            f"提示词类型：{prompt_type}\n输出语言：{language}\n"
            "必须按这个顺序组织信息：主体与外观；材质与形状；动作或摆放；构图、景别与视角；"
            "环境与背景；光线与阴影；色彩；风格与用途；镜头、景深与清晰度；必要的负面约束。\n"
            "严格规则：只写图片中能观察或合理推断的内容，不臆造品牌、文字、尺寸、镜头焦段、光圈等不可见参数；"
            "若图片中有文字，准确描述文字内容和位置；删除同义重复和空泛形容词，不连续堆砌‘高级、高清、细腻’；"
            "下游模型兼容规则：人物无法确认年龄时，统一使用‘成年人物’或‘年轻女性/年轻男性’，明确按18岁以上处理；"
            "禁止输出‘女高中生、男高中生、少女、少年、未成年、学生妹’等未成年身份词，也不要把‘校服’写成真实学生身份，"
            "改写为‘校园风制服’或‘校园风西装’；避免性化身体描写；可识别商标、品牌名和大段文字改写为通用外观描述，除非用户明确要求保留；"
            "不要把分析过程、标题、编号、Markdown、引号或‘提示词：’写进结果；不要把不存在的物体补出来。"
            "输出一段完整、连贯、信息密度适中的提示词，长度控制在 160 至 320 个中文字符左右。"
        )
        client = self._vision_client()
        image_url = f"data:{mime};base64,{data}"
        try:
            response = client.responses.create(
                model=model,
                input=[{
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": instruction},
                        {"type": "input_image", "image_url": image_url, "detail": "high"},
                    ],
                }],
            )
            text = getattr(response, "output_text", "") or ""
        except AttributeError:
            response = client.chat.completions.create(
                model=model,
                messages=[{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": instruction},
                        {"type": "image_url", "image_url": {"url": image_url, "detail": "high"}},
                    ],
                }],
                max_tokens=1200,
            )
            text = response.choices[0].message.content or ""
        text = text.strip()
        if text.startswith("```"):
            text = text.strip("`").strip()
        for prefix in ("提示词：", "提示词:", "最终提示词：", "最终提示词:"):
            if text.startswith(prefix):
                text = text[len(prefix):].strip()
                break
        if not text:
            raise RuntimeError("视觉模型没有返回提示词")
        return self._sanitize_vision_prompt(text)

    # ---------- 比例解析：跟随原图 / 指定尺寸 ----------
    def _resolve_size(self, size, p):
        """size 为空或 auto 时，按原图比例映射为最接近的预设尺寸。"""
        if not size or size == "auto":
            return self._size_from_image(p)
        return size

    def _size_from_image(self, p):
        try:
            from PIL import Image
            with Image.open(p) as im:
                w, h = im.size
            return self._size_from_ratio(w, h)
        except Exception:
            return "1024x1024"

    @staticmethod
    def _size_from_ratio(w, h):
        presets = [
            (1.0, "1024x1024"), (1.5, "1536x1024"), (2 / 3, "1024x1536"),
            (4 / 3, "1280x960"), (3 / 4, "960x1280"), (16 / 9, "1792x1024"), (9 / 16, "1024x1792"),
        ]
        r = w / h if h else 1.0
        return min(presets, key=lambda item: abs(item[0] - r))[1]

    # ---------- 选择图片文件 ----------
    def pick_image(self):
        try:
            window = webview.windows[0]
            result = window.create_file_dialog(
                webview.OPEN_DIALOG,
                allow_multiple=False,
                file_types=("图片文件 (*.png;*.jpg;*.jpeg;*.webp;*.bmp)",),
            )
            if not result:
                return None
            path = result[0] if isinstance(result, (tuple, list)) else result
            return str(path)
        except Exception:
            return None

    # ---------- 历史图库 ----------
    def get_history(self, limit=60, offset=0, model="", kind="", keyword=""):
        sql = ("SELECT id, prompt, model, size, kind, file_path, thumb_path, created_at "
               "FROM images WHERE 1=1")
        args = []
        if model:
            sql += " AND model=?"
            args.append(model)
        if kind:
            sql += " AND kind=?"
            args.append(kind)
        if keyword:
            sql += " AND prompt LIKE ?"
            args.append(f"%{keyword}%")
        sql += " ORDER BY id DESC LIMIT ? OFFSET ?"
        args += [int(limit), int(offset)]
        with sqlite3.connect(DB_FILE) as conn:
            rows = conn.execute(sql, args).fetchall()
        return [self._to_record(*r) for r in rows]

    def get_total(self, model="", kind="", keyword=""):
        sql = "SELECT COUNT(*) FROM images WHERE 1=1"
        args = []
        if model:
            sql += " AND model=?"
            args.append(model)
        if kind:
            sql += " AND kind=?"
            args.append(kind)
        if keyword:
            sql += " AND prompt LIKE ?"
            args.append(f"%{keyword}%")
        with sqlite3.connect(DB_FILE) as conn:
            return conn.execute(sql, args).fetchone()[0]

    def get_image_data(self, path):
        """返回 base64 data URL，供前端预览。"""
        p = Path(path)
        if not p.exists():
            return None
        b64 = base64.b64encode(p.read_bytes()).decode()
        ext = p.suffix.lower().lstrip(".") or "png"
        mime = {"jpg": "jpeg", "jpeg": "jpeg", "png": "png", "webp": "webp", "bmp": "bmp"}.get(ext, "png")
        return f"data:image/{mime};base64,{b64}"

    def get_thumbnail(self, file_path, thumb_path):
        """返回缩略图 data URL；无缩略图时返回原图 data URL。"""
        tp = self._thumb_of(file_path, thumb_path or "")
        return self.get_image_data(tp)

    def delete_image(self, rec_id):
        with sqlite3.connect(DB_FILE) as conn:
            row = conn.execute("SELECT file_path, thumb_path FROM images WHERE id=?", (rec_id,)).fetchone()
            if not row:
                return False
            conn.execute("DELETE FROM images WHERE id=?", (rec_id,))
            conn.commit()
        for p in row:
            if p:
                try:
                    Path(p).unlink(missing_ok=True)
                except Exception:
                    pass
        return True

    # ---------- 打开原图文件夹 ----------
    def open_image_folder(self):
        """用系统资源管理器打开原图文件夹。"""
        try:
            os.startfile(str(ORIGINALS_DIR))
            return True
        except Exception:
            return False
