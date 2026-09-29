/* ArtGen 前端逻辑 */
"use strict";

const MODELS = [
  "gpt-image-2",
  "gpt-image-2.5",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
];

// 画质选项（value 为传给接口的 quality；实测 quality 不影响分辨率，仅影响渲染细节/速度）
const QUALITIES = [
  { value: "auto", label: "自动" },
  { value: "high", label: "高（细节更细腻）" },
  { value: "medium", label: "中（细节均衡）" },
  { value: "low", label: "低（生成更快）" },
];

// 画面比例预设（value 为传给接口的 size，label 为展示文案）
const PRESET_SIZES = [
  { value: "1024x1024", label: "1:1 方形" },
  { value: "1536x1024", label: "3:2 横版" },
  { value: "1024x1536", label: "2:3 竖版" },
  { value: "1280x960", label: "4:3 横版" },
  { value: "960x1280", label: "3:4 竖版" },
  { value: "1792x1024", label: "16:9 宽屏" },
  { value: "1024x1792", label: "9:16 竖屏" },
  { value: "auto", label: "自适应" },
];

// 自定义比例状态（仅基础生图用到）
const sizeState = { gen: { custom: null } };

// 图生图输出比例：默认跟随原图比例
const EDIT_SIZES = [
  { value: "auto", label: "跟随原图比例" },
  ...PRESET_SIZES.filter((s) => s.value !== "auto"),
];

const api = () => window.pywebview.api;

const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

function setApiReady() {
  const desktopStatus = $("apiStatus");
  if (desktopStatus) desktopStatus.innerHTML = "<span></span>已连接";
  const mobileStatus = $("mobileApiStatus");
  if (mobileStatus) mobileStatus.setAttribute("aria-label", "服务已连接");
}

// 当前图库状态
let gallery = { limit: 60, offset: 0 };
let editSourcePath = null; // 图生图的源图路径
let editRefPath = null; // 参考图路径（可选）
let promptSourcePath = null; // 提示词工坊的参考图路径
let lightboxId = null;
let lightboxRecord = null;

// ---------- 通用 ----------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function sizeLabel(s) {
  if (!s) return "默认";
  if (s === "auto") return "自适应";
  return s;
}

function fillModelSelect(sel) {
  sel.innerHTML = MODELS.map((m) => `<option value="${m}">${m}</option>`).join("");
  sel.value = "gpt-image-2.5";
}

function fillQualitySelect(sel) {
  sel.innerHTML = QUALITIES.map((q) => `<option value="${q.value}">${q.label}</option>`).join("");
  sel.value = "auto";
}

function fillSizeSelect(sel) {
  sel.innerHTML = PRESET_SIZES.map((s) => `<option value="${s.value}">${s.label}</option>`).join("");
}

function fillEditSizeSelect(sel) {
  sel.innerHTML = EDIT_SIZES.map((s) => `<option value="${s.value}">${s.label}</option>`).join("");
  sel.value = "auto";
}

// ---------- 尺寸（比例）选择（基础生图） ----------
function initSizes(id, stateKey) {
  const wrap = $(id);
  wrap.innerHTML = "";
  PRESET_SIZES.forEach((s, i) => {
    const b = document.createElement("button");
    b.className = "seg-btn" + (i === 0 ? " active" : "");
    b.textContent = s.label;
    b.dataset.size = s.value;
    b.addEventListener("click", () => setActiveSize(id, stateKey, b));
    wrap.appendChild(b);
  });

  // 自定义按钮
  const cBtn = document.createElement("button");
  cBtn.className = "seg-btn seg-custom";
  cBtn.textContent = "自定义…";
  wrap.appendChild(cBtn);

  const inp = document.createElement("input");
  inp.className = "input size-input hidden";
  inp.placeholder = "如 16:9 或 1024x768";
  wrap.appendChild(inp);

  const okBtn = document.createElement("button");
  okBtn.className = "seg-btn hidden";
  okBtn.textContent = "确定";
  wrap.appendChild(okBtn);

  cBtn.addEventListener("click", () => {
    inp.classList.remove("hidden");
    okBtn.classList.remove("hidden");
    inp.focus();
  });

  const applyCustom = () => {
    const raw = inp.value.trim();
    if (!raw) return;
    const size = parseSize(raw);
    if (!size) { alert("格式不对，请输入 宽:高（如 16:9）或 宽x高（如 1024x768）"); return; }
    sizeState[stateKey].custom = size;
    inp.classList.add("hidden");
    okBtn.classList.add("hidden");
    highlightCustom(id, cBtn, raw);
  };
  okBtn.addEventListener("click", applyCustom);
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") applyCustom(); });
}

function highlightCustom(id, cBtn, raw) {
  const wrap = $(id);
  wrap.querySelectorAll(".seg-btn").forEach((x) => x.classList.remove("active"));
  cBtn.classList.add("active");
  cBtn.textContent = "自定义 " + raw;
}

function setActiveSize(id, stateKey, btn) {
  const wrap = $(id);
  wrap.querySelectorAll(".seg-btn").forEach((x) => x.classList.remove("active"));
  btn.classList.add("active");
  const cBtn = wrap.querySelector(".seg-custom");
  if (cBtn) cBtn.textContent = "自定义…";
  sizeState[stateKey].custom = null;
}

function currentSize(id, stateKey) {
  if (sizeState[stateKey].custom) return sizeState[stateKey].custom;
  const a = $(id).querySelector(".seg-btn.active");
  return (a && a.dataset.size) ? a.dataset.size : PRESET_SIZES[0].value;
}

// 将用户输入解析为接口接受的尺寸字符串
function parseSize(v) {
  v = v.replace(/\s+/g, "");
  let m = v.match(/^(\d+):(\d+)$/); // 比例 16:9
  if (m) {
    const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
    if (!w || !h) return null;
    const scale = 1792 / Math.max(w, h);
    return Math.round(w * scale) + "x" + Math.round(h * scale);
  }
  m = v.match(/^(\d+)[xX*×](\d+)$/); // 直接宽x高 1024x768
  if (m) {
    const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
    if (!w || !h) return null;
    return w + "x" + h;
  }
  return null;
}

// ---------- 加载态与结果渲染 ----------
function setBtnLoading(btn, loading, text) {
  if (loading) {
    btn.dataset.orig = btn.textContent;
    btn.textContent = text;
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.orig || btn.textContent;
    btn.disabled = false;
  }
}

function showLoading(imgEl, skelEl, textEl, text) {
  imgEl.classList.add("hidden");
  skelEl.classList.remove("hidden");
  if (textEl && text) textEl.textContent = text;
}

function markGenerated(record, imgEl, skelEl, metaEl) {
  api().get_image_data(record.file_path).then((dataUrl) => {
    imgEl.src = dataUrl;
    skelEl.classList.add("hidden");
    imgEl.classList.remove("hidden");
  }).catch(() => {
    skelEl.classList.add("hidden");
    imgEl.classList.remove("hidden");
  });
  metaEl.innerHTML =
    `<strong>${esc(record.model)}</strong> · ${esc(sizeLabel(record.size))}<br>` +
    `<span class="meta-prompt" title="${esc(record.prompt)}">${esc(record.prompt)}</span>`;
}

// ---------- Tab 切换 ----------
function switchTab(name) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  const nav = document.querySelector(`.nav-item[data-tab="${name}"]`);
  if (nav) nav.classList.add("active");
  $("tab-" + name).classList.add("active");
}

// ---------- 清空功能（仅清空页面内容，不删除文件） ----------
function clearGenerate() {
  $("genPrompt").value = "";
  $("genResult").classList.add("hidden");
  $("genImg").src = "";
  $("genMeta").innerHTML = "";
  const btns = $("genSizes").querySelectorAll(".seg-btn");
  btns.forEach((b) => b.classList.remove("active"));
  if (btns[0]) btns[0].classList.add("active");
  const cBtn = $("genSizes").querySelector(".seg-custom");
  if (cBtn) cBtn.textContent = "自定义…";
  sizeState.gen.custom = null;
}

function clearEdit() {
  clearEditSource();
  clearRefSource();
  $("editPrompt").value = "";
  $("editResult").classList.add("hidden");
  $("editImg").src = "";
  $("editMeta").innerHTML = "";
  $("editSize").value = "auto";
}

function clearBatchCard(card) {
  const { promptEl, resultWrap, imgEl, metaEl } = newBatchCardRefs(card);
  promptEl.value = "";
  imgEl.src = "";
  resultWrap.classList.add("hidden");
  metaEl.innerHTML = "";
}

$("genClearBtn").addEventListener("click", clearGenerate);
$("editClearBtn").addEventListener("click", clearEdit);

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    switchTab(btn.dataset.tab);
    if (btn.dataset.tab === "gallery") refreshGallery();
  });
});

// ---------- 基础生图 ----------
$("genBtn").addEventListener("click", async () => {
  const prompt = $("genPrompt").value.trim();
  if (!prompt) { alert("请先输入提示词"); return; }
  const model = $("genModel").value;
  const size = currentSize("genSizes", "gen");
  const quality = $("genQuality").value;
  setBtnLoading($("genBtn"), true, "生成中…");
  $("genResult").classList.remove("hidden");
  showLoading($("genImg"), $("genSkeleton"), $("genSkeletonText"), "正在生成图片，请稍候…");
  $("genMeta").innerHTML = "";
  try {
    const rec = await api().generate(prompt, model, size, quality);
    markGenerated(rec, $("genImg"), $("genSkeleton"), $("genMeta"));
  } catch (e) {
    $("genSkeleton").classList.add("hidden");
    $("genImg").classList.add("hidden");
    $("genMeta").innerHTML = `<span style="color:var(--danger)">生成失败：${esc(e)}</span>`;
  } finally {
    setBtnLoading($("genBtn"), false);
    $("genResult").scrollIntoView({ behavior: "smooth" });
  }
});

// ---------- 历史图库 ----------
async function refreshGallery(reset = true) {
  if (reset) { gallery.offset = 0; $("galGrid").innerHTML = ""; }
  const model = $("galModel").value;
  const kind = $("galKind").value;
  const keyword = $("galKeyword").value.trim();
  try {
    const rows = await api().get_history(gallery.limit, gallery.offset, model, kind, keyword);
    const total = await api().get_total(model, kind, keyword);
    $("galCount").textContent = `共 ${total} 张`;
    renderGalleryCards(rows);
    gallery.offset += rows.length;
    $("galMore").style.display = gallery.offset < total ? "" : "none";
  } catch (e) {
    alert("读取图库失败：" + e);
  }
}

function renderGalleryCards(rows) {
  rows.forEach((r) => {
    const card = document.createElement("div");
    card.className = "gal-card";
    card.innerHTML =
      `<div class="gal-thumb-wrap"><img class="gal-thumb" alt="" /></div>
       <div class="gal-card-body">
         <p class="gal-prompt" title="${esc(r.prompt)}">${esc(r.prompt)}</p>
         <div class="gal-tags">
           <span class="tag">${esc(r.model)}</span>
           <span class="tag kind">${r.kind === "img2img" ? "图生图" : "文生图"}</span>
           ${r.size ? `<span class="tag">${esc(sizeLabel(r.size))}</span>` : ""}
         </div>
       </div>`;
    card.addEventListener("click", () => openLightbox(r));
    $("galGrid").appendChild(card);
    const img = card.querySelector(".gal-thumb");
    api().get_thumbnail(r.file_path, r.thumb_path).then((dataUrl) => {
      if (dataUrl) img.src = dataUrl;
    }).catch(() => {});
  });
}

$("galRefresh").addEventListener("click", () => refreshGallery(true));
$("galMore").addEventListener("click", () => refreshGallery(false));
$("galKeyword").addEventListener("keydown", (e) => { if (e.key === "Enter") refreshGallery(true); });

function fillGalleryModelSelect() {
  const sel = $("galModel");
  sel.innerHTML = `<option value="">全部模型</option>` +
    MODELS.map((m) => `<option value="${m}">${m}</option>`).join("");
}

// ---------- Lightbox（放大查看） ----------
const lb = { scale: 1, tx: 0, ty: 0, dragging: false, moved: false, sx: 0, sy: 0, ox: 0, oy: 0 };

function lbApply() {
  $("lightboxImg").style.transform = `translate(${lb.tx}px, ${lb.ty}px) scale(${lb.scale})`;
}

function lbReset() {
  lb.scale = 1; lb.tx = 0; lb.ty = 0;
  $("lightboxStage").classList.remove("zoomed");
  lbApply();
}

function closeLightbox() {
  $("lightbox").classList.add("hidden");
}

function openLightbox(r) {
  lightboxRecord = r;
  lightboxId = r.id;
  $("lightboxPrompt").textContent = r.prompt;
  $("lightboxPrompt").title = r.prompt;
  const img = $("lightboxImg");
  img.src = "";
  lbReset();
  api().get_image_data(r.file_path).then((dataUrl) => {
    img.src = dataUrl;
  }).catch(() => {});
  $("lightbox").classList.remove("hidden");
}

// 点击图片：在 适配 与 2 倍放大 之间切换（若本次是拖动后的松手，则忽略，避免误退出放大）
$("lightboxImg").addEventListener("click", (e) => {
  e.stopPropagation();
  if (lb.moved) { lb.moved = false; return; }
  if (lb.scale === 1) {
    lb.scale = 2;
    $("lightboxStage").classList.add("zoomed");
  } else {
    lbReset();
  }
  lbApply();
});

// 滚轮缩放（1x ~ 4x）
$("lightboxStage").addEventListener("wheel", (e) => {
  e.preventDefault();
  const delta = e.deltaY < 0 ? 0.25 : -0.25;
  lb.scale = Math.min(4, Math.max(1, lb.scale + delta));
  if (lb.scale === 1) { lb.tx = 0; lb.ty = 0; lbReset(); }
  else { $("lightboxStage").classList.add("zoomed"); lbApply(); }
}, { passive: false });

// 拖动平移
$("lightboxImg").addEventListener("pointerdown", (e) => {
  if (lb.scale === 1) return;
  lb.dragging = true;
  lb.moved = false;
  lb.sx = e.clientX; lb.sy = e.clientY;
  lb.ox = lb.tx; lb.oy = lb.ty;
  try { $("lightboxImg").setPointerCapture(e.pointerId); } catch (_) {}
  e.preventDefault();
});
$("lightboxImg").addEventListener("pointermove", (e) => {
  if (!lb.dragging) return;
  const dx = e.clientX - lb.sx;
  const dy = e.clientY - lb.sy;
  if (Math.abs(dx) > 5 || Math.abs(dy) > 5) lb.moved = true;
  lb.tx = lb.ox + dx;
  lb.ty = lb.oy + dy;
  lbApply();
});
const lbEndDrag = () => { lb.dragging = false; };
$("lightboxImg").addEventListener("pointerup", lbEndDrag);
$("lightboxImg").addEventListener("pointercancel", lbEndDrag);

// 点击空白关闭（背景或舞台空白区，按钮区不触发）
$("lightbox").addEventListener("click", (e) => {
  if (e.target === $("lightbox") || e.target === $("lightboxStage")) closeLightbox();
});
$("lightboxStage").addEventListener("click", (e) => {
  if (e.target === $("lightboxStage")) closeLightbox();
});

$("lightboxOpenFolder").addEventListener("click", () => {
  api().open_image_folder();
});
$("lightboxDelete").addEventListener("click", async () => {
  if (!lightboxId) return;
  if (!confirm("确定删除这张图片及其记录？")) return;
  await api().delete_image(lightboxId);
  closeLightbox();
  refreshGallery(true);
});
$("lightboxUseEdit").addEventListener("click", async () => {
  if (!lightboxRecord) return;
  await setEditSource(lightboxRecord.file_path);
  closeLightbox();
  switchTab("edit");
});

// ---------- 批量生成（卡片式） ----------
function renderBatchCards(n) {
  const wrap = $("batchCards");
  wrap.innerHTML = "";
  for (let i = 0; i < n; i++) {
    const card = document.createElement("div");
    card.className = "batch-card";
    card.dataset.idx = i;
    card.innerHTML = `
      <div class="batch-card-form">
        <div class="batch-card-head">
          <span class="batch-card-no">${i + 1}</span>
          <div class="batch-card-actions">
            <button class="btn primary batch-gen-btn">生成</button>
            <button class="btn batch-clear-btn">清空</button>
          </div>
        </div>
        <textarea class="textarea batch-prompt" rows="4" placeholder="输入提示词…"></textarea>
        <div class="batch-card-controls">
          <label class="b-field">
            <span class="b-label">模型</span>
            <select class="select b-model"></select>
          </label>
          <label class="b-field">
            <span class="b-label">比例</span>
            <select class="select b-size"></select>
          </label>
          <label class="b-field">
            <span class="b-label">画质</span>
            <select class="select b-quality"></select>
          </label>
        </div>
      </div>
      <div class="batch-result hidden">
        <div class="skeleton batch-skeleton">
          <div class="skeleton-shimmer"></div>
          <div class="skeleton-spinner"></div>
          <div class="skeleton-text">正在生成…</div>
        </div>
        <img class="batch-img hidden" alt="" />
        <div class="batch-meta meta-text"></div>
      </div>`;
    fillModelSelect(card.querySelector(".b-model"));
    fillSizeSelect(card.querySelector(".b-size"));
    fillQualitySelect(card.querySelector(".b-quality"));
    card.querySelector(".batch-gen-btn").addEventListener("click", () => generateOneCard(card));
    card.querySelector(".batch-clear-btn").addEventListener("click", () => clearBatchCard(card));
    wrap.appendChild(card);
  }
}

function newBatchCardRefs(card) {
  return {
    promptEl: card.querySelector(".batch-prompt"),
    modelEl: card.querySelector(".b-model"),
    sizeEl: card.querySelector(".b-size"),
    qualityEl: card.querySelector(".b-quality"),
    btn: card.querySelector(".batch-gen-btn"),
    resultWrap: card.querySelector(".batch-result"),
    imgEl: card.querySelector(".batch-img"),
    skelEl: card.querySelector(".batch-skeleton"),
    textEl: card.querySelector(".batch-skeleton .skeleton-text"),
    metaEl: card.querySelector(".batch-meta"),
  };
}

async function generateOneCard(card) {
  const { promptEl, modelEl, sizeEl, qualityEl, btn, resultWrap, imgEl, skelEl, textEl, metaEl } =
    newBatchCardRefs(card);
  const prompt = promptEl.value.trim();
  const idx = parseInt(card.dataset.idx, 10) + 1;
  if (!prompt) { alert(`第 ${idx} 个框的提示词为空`); return; }
  const model = modelEl.value;
  const size = sizeEl.value;
  const quality = qualityEl.value;
  setBtnLoading(btn, true, "生成中…");
  resultWrap.classList.remove("hidden");
  showLoading(imgEl, skelEl, textEl, "正在生成…");
  metaEl.innerHTML = "";
  try {
    const rec = await api().generate(prompt, model, size, quality);
    markGenerated(rec, imgEl, skelEl, metaEl);
  } catch (e) {
    skelEl.classList.add("hidden");
    imgEl.classList.add("hidden");
    metaEl.innerHTML = `<span style="color:var(--danger)">失败：${esc(e)}</span>`;
  } finally {
    setBtnLoading(btn, false);
  }
}

$("batchConcurrency").addEventListener("change", () => {
  renderBatchCards(parseInt($("batchConcurrency").value, 10));
});

$("batchAllBtn").addEventListener("click", () => {
  const cards = [...$("batchCards").querySelectorAll(".batch-card")];
  const nonEmpty = cards.filter((c) => c.querySelector(".batch-prompt").value.trim());
  if (!nonEmpty.length) { alert("请至少填写一个提示词"); return; }
  // 所有非空卡片同时开始生成（前端并发触发）
  nonEmpty.forEach((c) => generateOneCard(c));
});

// ---------- 图生图编辑 ----------
async function setEditSource(path) {
  if (!path) return;
  editSourcePath = path;
  $("editPreviewWrap").classList.remove("hidden");
  const dataUrl = await api().get_image_data(path);
  if (dataUrl) $("editPreview").src = dataUrl;
  $("editBtn").disabled = false;
}

function clearEditSource() {
  editSourcePath = null;
  $("editPreview").src = "";
  $("editPreviewWrap").classList.add("hidden");
  $("editBtn").disabled = true;
}

async function setRefSource(path) {
  if (!path) return;
  editRefPath = path;
  $("refPreviewWrap").classList.remove("hidden");
  const dataUrl = await api().get_image_data(path);
  if (dataUrl) $("refPreview").src = dataUrl;
}

function clearRefSource() {
  editRefPath = null;
  $("refPreview").src = "";
  $("refPreviewWrap").classList.add("hidden");
}

$("editPickBtn").addEventListener("click", async () => {
  const path = await api().pick_image();
  if (path) await setEditSource(path);
});

$("editPickFromGal").addEventListener("click", () => switchTab("gallery"));

$("editPreviewClear").addEventListener("click", clearEditSource);

$("refPickBtn").addEventListener("click", async () => {
  const path = await api().pick_image();
  if (path) await setRefSource(path);
});

$("refPreviewClear").addEventListener("click", clearRefSource);

// ---------- 提示词工坊 ----------
async function setPromptSource(path) {
  if (!path) return;
  promptSourcePath = path;
  const wrap = $("promptPreviewWrap");
  const dataUrl = await api().get_image_data(path);
  if (dataUrl) $("promptPreview").src = dataUrl;
  wrap.classList.remove("empty");
  wrap.classList.add("has-image");
  $("promptPickBtn").textContent = "更换图片";
  $("promptClearBtn").disabled = false;
  $("promptGenerateBtn").disabled = false;
  $("promptStatus").textContent = "图片已就绪，可开始拆解";
}

function clearPromptSource() {
  promptSourcePath = null;
  const wrap = $("promptPreviewWrap");
  wrap.classList.add("empty");
  wrap.classList.remove("has-image");
  $("promptPreview").src = "";
  $("promptPickBtn").textContent = "选择图片";
  $("promptClearBtn").disabled = true;
  $("promptGenerateBtn").disabled = true;
  $("promptStatus").textContent = "等待上传图片";
  $("promptOutput").value = "";
  $("promptCopyBtn").disabled = true;
}

$("promptPickBtn").addEventListener("click", async () => {
  const path = await api().pick_image();
  if (path) await setPromptSource(path);
});

$("promptClearBtn").addEventListener("click", clearPromptSource);

$("promptGenerateBtn").addEventListener("click", async () => {
  if (!promptSourcePath) { alert("请先选择参考图"); return; }
  const btn = $("promptGenerateBtn");
  setBtnLoading(btn, true, "拆解中…");
  $("promptStatus").textContent = "正在分析画面结构与材质…";
  try {
    const prompt = await api().describe_image(
      promptSourcePath,
      "",
      $("promptType").value,
      "中文",
    );
    $("promptOutput").value = prompt;
    $("promptCopyBtn").disabled = !prompt;
    $("promptStatus").textContent = "已生成，可复制到生图";
  } catch (e) {
    $("promptStatus").textContent = "生成失败";
    alert(`提示词生成失败：${e && e.message ? e.message : e}`);
  } finally {
    setBtnLoading(btn, false);
  }
});

$("promptCopyBtn").addEventListener("click", async () => {
  const value = $("promptOutput").value.trim();
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
  } catch (e) {
    $("promptOutput").focus();
    $("promptOutput").select();
    document.execCommand("copy");
  }
  $("promptStatus").textContent = "已复制到剪贴板";
});

$("editBtn").addEventListener("click", async () => {
  if (!editSourcePath) { alert("请先选择源图片"); return; }
  const prompt = $("editPrompt").value.trim();
  if (!prompt) { alert("请填写编辑描述"); return; }
  const model = $("editModel").value;
  const size = $("editSize").value;
  setBtnLoading($("editBtn"), true, "编辑中…");
  $("editResult").classList.remove("hidden");
  showLoading($("editImg"), $("editSkeleton"), $("editSkeletonText"), "正在编辑图片，请稍候…");
  $("editMeta").innerHTML = "";
  try {
    const rec = editRefPath
      ? await api().reference_edit(editSourcePath, editRefPath, prompt, model, size)
      : await api().edit(editSourcePath, prompt, model, size);
    markGenerated(rec, $("editImg"), $("editSkeleton"), $("editMeta"));
  } catch (e) {
    $("editSkeleton").classList.add("hidden");
    $("editImg").classList.add("hidden");
    $("editMeta").innerHTML = `<span style="color:var(--danger)">编辑失败：${esc(e)}</span>`;
  } finally {
    setBtnLoading($("editBtn"), false);
    $("editResult").scrollIntoView({ behavior: "smooth" });
  }
});

// ---------- 初始化 ----------
window.addEventListener("pywebviewready", () => {
  setApiReady();
  fillModelSelect($("genModel"));
  fillModelSelect($("editModel"));
  fillQualitySelect($("genQuality"));
  fillGalleryModelSelect();
  fillEditSizeSelect($("editSize"));
  initSizes("genSizes", "gen");
  renderBatchCards(3);
  refreshGallery(true);
});
