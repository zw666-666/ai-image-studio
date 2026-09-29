/* image生图助手 - 移动端 */
"use strict";

const MODELS = [
  "gpt-image-2",
  "gpt-image-2.5",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
];

// 画质（quality 不影响分辨率，只影响细节/速度）
const QUALITIES = [
  { value: "auto", label: "自动" },
  { value: "high", label: "高（细节更细腻）" },
  { value: "medium", label: "中（细节均衡）" },
  { value: "low", label: "低（生成更快）" },
];

const SIZES = [
  { value: "1024x1024", label: "1:1 方形" },
  { value: "1536x1024", label: "3:2 横版" },
  { value: "1024x1536", label: "2:3 竖版" },
  { value: "1280x960", label: "4:3 横版" },
  { value: "960x1280", label: "3:4 竖版" },
  { value: "1792x1024", label: "16:9 宽屏" },
  { value: "1024x1792", label: "9:16 竖屏" },
  { value: "auto", label: "自适应" },
  { value: "__custom__", label: "自定义…" },
];

// 图生图输出比例：默认跟随原图比例
const EDIT_SIZES = [
  { value: "auto", label: "跟随原图比例" },
  ...SIZES.filter((s) => s.value !== "auto" && s.value !== "__custom__"),
];

const $ = (id) => document.getElementById(id);
const bridge = () => window.AndroidBridge;
let editSrcB64 = null;
let editRefB64 = null;
let promptSrcB64 = null;

// ---------- 异步任务桥（生成/编辑走前台服务，结果通过轮询获取） ----------
let reqSeq = 0;

function nextId() {
  return ++reqSeq;
}

// 轮询结果：不依赖 WebView 被动回调，即使切后台再回前台也能取到
function waitResult(id) {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const timer = setInterval(() => {
      let raw = null;
      try {
        raw = bridge().pollResult(id);
      } catch (e) {
        clearInterval(timer);
        reject(new Error("查询结果失败"));
        return;
      }
      if (raw != null) {
        clearInterval(timer);
        try { bridge().removeResult(id); } catch (e) {}
        try {
          const rec = JSON.parse(raw);
          if (rec.error) reject(new Error(rec.error));
          else resolve(rec);
        } catch (e) {
          reject(new Error("解析结果失败"));
        }
      } else if (++tries >= 180) { // 180 * 2s = 6 分钟超时
        clearInterval(timer);
        reject(new Error("生成超时，请重试"));
      }
    }, 2000);
  });
}

function callGenerate(prompt, model, size, quality) {
  try {
    const id = nextId();
    bridge().generate(prompt, model, size, quality, id);
    return waitResult(id);
  } catch (e) {
    return Promise.reject(e);
  }
}

function callEdit(imageBase64, refBase64, prompt, model, size) {
  try {
    const id = nextId();
    if (refBase64) {
      bridge().referenceEdit(imageBase64, refBase64, prompt, model, size, id);
    } else {
      bridge().edit(imageBase64, prompt, model, size, id);
    }
    return waitResult(id);
  } catch (e) {
    return Promise.reject(e);
  }
}

// ---------- 工具 ----------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function sizeLabel(v) {
  if (!v || v === "auto") return "自适应";
  return v;
}

// 解析自定义尺寸：支持 16:9（比例）或 1024x768（像素）
function parseSize(v) {
  v = (v || "").replace(/\s+/g, "");
  let m = v.match(/^(\d+):(\d+)$/);
  if (m) {
    const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
    if (!w || !h) return null;
    const scale = 1792 / Math.max(w, h);
    return Math.round(w * scale) + "x" + Math.round(h * scale);
  }
  m = v.match(/^(\d+)[xX*×](\d+)$/);
  if (m) {
    const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
    if (!w || !h) return null;
    return w + "x" + h;
  }
  return null;
}

let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}

function fillSelect(sel, items, def) {
  sel.innerHTML = items.map((i) => `<option value="${i.value}">${i.label}</option>`).join("");
  sel.value = def;
}

function fillModels(sel) {
  sel.innerHTML = MODELS.map((m) => `<option value="${m}">${m}</option>`).join("");
  sel.value = "gpt-image-2.5";
}

// ---------- Tab ----------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $("tab-" + btn.dataset.tab).classList.add("active");
  });
});

// ---------- 加载态 ----------
function setLoading(btn, loading, text) {
  if (loading) {
    btn.dataset.orig = btn.textContent;
    btn.textContent = text;
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.orig || btn.textContent;
    btn.disabled = false;
  }
}

function showSkeleton(imgEl, skelEl) {
  imgEl.classList.add("hidden");
  skelEl.classList.remove("hidden");
}

function renderResult(rec, imgEl, skelEl, metaEl, savedEl, wrap) {
  imgEl.src = rec.dataUrl;
  imgEl.classList.remove("hidden");
  skelEl.classList.add("hidden");
  metaEl.innerHTML =
    `<strong>${esc(rec.model)}</strong> · ${esc(sizeLabel(rec.size))}<br>` +
    `<span>${esc(rec.prompt)}</span>`;
  if (savedEl && rec.saved) savedEl.classList.remove("hidden");
  setTimeout(() => wrap.scrollIntoView({ behavior: "smooth", block: "nearest" }), 60);
}

// ---------- 比例：自定义切换 ----------
$("genSize").addEventListener("change", (e) => {
  $("genCustomWrap").classList.toggle("hidden", e.target.value !== "__custom__");
});

// ---------- 文生图 ----------
$("genBtn").addEventListener("click", () => {
  const prompt = $("genPrompt").value.trim();
  if (!prompt) { toast("请先输入提示词"); return; }
  const model = $("genModel").value;
  let size = $("genSize").value;
  if (size === "__custom__") {
    const c = parseSize($("genCustomSize").value.trim());
    if (!c) { toast("自定义尺寸格式不对，如 16:9 或 1024x768"); return; }
    size = c;
  }
  const quality = $("genQuality").value;

  setLoading($("genBtn"), true, "生成中…");
  $("genResult").classList.remove("hidden");
  $("genSaved").classList.add("hidden");
  showSkeleton($("genImg"), $("genSkel"));
  $("genMeta").innerHTML = "";

  callGenerate(prompt, model, size, quality)
    .then((rec) => renderResult(rec, $("genImg"), $("genSkel"), $("genMeta"), $("genSaved"), $("genResult")))
    .catch((e) => {
      $("genSkel").classList.add("hidden");
      $("genImg").classList.add("hidden");
      $("genMeta").innerHTML = `<span class="err">生成失败：${esc(e.message || e)}</span>`;
    })
    .finally(() => setLoading($("genBtn"), false));
});

// ---------- 从相册选图（异步，通过 window.__onPicked 回调） ----------
function pickImage() {
  return new Promise((resolve) => {
    window.__onPicked = (dataUrl) => {
      delete window.__onPicked;
      resolve(dataUrl);
    };
    bridge().pickImage();
  });
}

function pickImageRef() {
  return new Promise((resolve) => {
    window.__onPickedRef = (dataUrl) => {
      delete window.__onPickedRef;
      resolve(dataUrl);
    };
    bridge().pickImageRef();
  });
}

$("editPickBtn").addEventListener("click", async () => {
  try {
    const dataUrl = await pickImage();
    if (!dataUrl) return;
    editSrcB64 = dataUrl.split(",")[1];
    $("editPreview").src = dataUrl;
    $("editPreviewWrap").classList.remove("hidden");
    $("editBtn").disabled = false;
  } catch (e) {
    toast("选择图片失败");
  }
});
$("editPreview").addEventListener("click", () => $("editPickBtn").click());

$("refPickBtn").addEventListener("click", async () => {
  try {
    const dataUrl = await pickImageRef();
    if (!dataUrl) return;
    editRefB64 = dataUrl.split(",")[1];
    $("refPreview").src = dataUrl;
    $("refPreviewWrap").classList.remove("hidden");
  } catch (e) {
    toast("选择参考图失败");
  }
});
$("refPreview").addEventListener("click", () => $("refPickBtn").click());

// ---------- 提示词工坊 ----------
$("promptPickBtn").addEventListener("click", async () => {
  try {
    const dataUrl = await pickImage();
    if (!dataUrl) return;
    promptSrcB64 = dataUrl.split(",")[1];
    $("promptPreview").src = dataUrl;
    $("promptPreviewWrap").classList.remove("empty");
    $("promptPreviewWrap").classList.add("has-image");
    $("promptPickBtn").textContent = "更换图片";
    $("promptClearBtn").disabled = false;
    $("promptGenerateBtn").disabled = false;
    $("promptStatus").textContent = "图片已就绪，可开始拆解";
  } catch (e) {
    toast("选择图片失败");
  }
});

$("promptClearBtn").addEventListener("click", () => {
  promptSrcB64 = null;
  $("promptPreview").src = "";
  $("promptPreviewWrap").classList.add("empty");
  $("promptPreviewWrap").classList.remove("has-image");
  $("promptPickBtn").textContent = "选择图片";
  $("promptClearBtn").disabled = true;
  $("promptGenerateBtn").disabled = true;
  $("promptOutput").value = "";
  $("promptCopyBtn").disabled = true;
  $("promptStatus").textContent = "等待上传图片";
});

$("promptGenerateBtn").addEventListener("click", () => {
  if (!promptSrcB64) { toast("请先选择参考图"); return; }
  const btn = $("promptGenerateBtn");
  setLoading(btn, true, "拆解中…");
  $("promptStatus").textContent = "正在分析画面结构与材质…";
  try {
    const id = nextId();
    bridge().describeImage(promptSrcB64, $("promptType").value, "中文", id);
    waitResult(id)
      .then((result) => {
        $("promptOutput").value = result.prompt || "";
        $("promptCopyBtn").disabled = !result.prompt;
        $("promptStatus").textContent = "已生成，可复制到生图";
      })
      .catch((e) => {
        $("promptStatus").textContent = "生成失败";
        toast("提示词生成失败：" + (e.message || e));
      })
      .finally(() => setLoading(btn, false));
  } catch (e) {
    setLoading(btn, false);
    $("promptStatus").textContent = "生成失败";
    toast("提示词生成失败：" + (e.message || e));
  }
});

$("promptCopyBtn").addEventListener("click", async () => {
  const value = $("promptOutput").value.trim();
  if (!value) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(value);
    else { $("promptOutput").focus(); $("promptOutput").select(); document.execCommand("copy"); }
    $("promptStatus").textContent = "已复制到剪贴板";
  } catch (e) { toast("复制失败，请长按文本复制"); }
});

// ---------- 图生图 ----------
$("editBtn").addEventListener("click", () => {
  if (!editSrcB64) { toast("请先选择源图片"); return; }
  const prompt = $("editPrompt").value.trim();
  if (!prompt) { toast("请填写编辑描述"); return; }
  const model = $("editModel").value;
  const size = $("editSize").value;

  setLoading($("editBtn"), true, "编辑中…");
  $("editResult").classList.remove("hidden");
  $("editSaved").classList.add("hidden");
  showSkeleton($("editImg"), $("editSkel"));
  $("editMeta").innerHTML = "";

  callEdit(editSrcB64, editRefB64, prompt, model, size)
    .then((rec) => renderResult(rec, $("editImg"), $("editSkel"), $("editMeta"), $("editSaved"), $("editResult")))
    .catch((e) => {
      $("editSkel").classList.add("hidden");
      $("editImg").classList.add("hidden");
      $("editMeta").innerHTML = `<span class="err">编辑失败：${esc(e.message || e)}</span>`;
    })
    .finally(() => setLoading($("editBtn"), false));
});

// ---------- 清空（仅清空页面内容，不删除相册照片） ----------
function clearGenerate() {
  $("genPrompt").value = "";
  $("genSaved").classList.add("hidden");
  $("genResult").classList.add("hidden");
  $("genImg").src = "";
  $("genImg").classList.add("hidden");
  $("genMeta").innerHTML = "";
}

function clearEdit() {
  editSrcB64 = null;
  editRefB64 = null;
  $("editPreview").src = "";
  $("editPreviewWrap").classList.add("hidden");
  $("refPreview").src = "";
  $("refPreviewWrap").classList.add("hidden");
  $("editPrompt").value = "";
  $("editSaved").classList.add("hidden");
  $("editResult").classList.add("hidden");
  $("editImg").src = "";
  $("editImg").classList.add("hidden");
  $("editMeta").innerHTML = "";
  $("editBtn").disabled = true;
  $("editSize").value = "auto";
}

$("genClearBtn").addEventListener("click", clearGenerate);
$("editClearBtn").addEventListener("click", clearEdit);

// ---------- 初始化 ----------
fillModels($("genModel"));
fillModels($("editModel"));
fillSelect($("genQuality"), QUALITIES, "auto");
fillSelect($("genSize"), SIZES, "1024x1024");
fillSelect($("editSize"), EDIT_SIZES, "auto");
