# -*- coding: utf-8 -*-
"""
图标生成脚本：把 icon_source.png 处理成多尺寸圆角透明图标。

用法：
  1. 替换 icon_source.png 为你的图标原图（任意尺寸，尽量接近正方形）
  2. 改 RADIUS_RATIO 调整圆角
  3. 运行本脚本生成 app_icon.ico
  4. 重新打包 exe / 安装包
"""
import os
from PIL import Image, ImageDraw

# ============================================================
# ★ 圆角参数：改这里 ★
# 0.0 = 直角（会露白），0.15 = 小圆角，0.225 = 贴近 Windows 11，0.30 = 更圆
RADIUS_RATIO = 0.225
# ============================================================

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "icon_source.png")
DST = os.path.join(HERE, "app_icon.ico")

im = Image.open(SRC).convert("RGBA")
w, h = im.size
# 居中裁剪为正方形
side = min(w, h)
left = (w - side) // 2
top = (h - side) // 2
im = im.crop((left, top, left + side, top + side))

# 缩放到 512 母版
S = 512
im = im.resize((S, S), Image.LANCZOS)

# 套圆角透明，消除桌面图标四角露白
mask = Image.new("L", (S, S), 0)
d = ImageDraw.Draw(mask)
radius = int(S * RADIUS_RATIO)
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=radius, fill=255)
im.putalpha(mask)

im.save(DST, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("完成：圆角比例 =", RADIUS_RATIO, "，半径 =", radius, "px（512px 母版）")