# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=[],
    datas=[('web', 'web'), ('app_icon.ico', '.')],
    hiddenimports=[],
    hookspath=['C:/Users/张威/AppData/Local/Programs/Python/Python312/Lib/site-packages/webview/__pyinstaller', 'C:/Users/张威/AppData/Local/Programs/Python/Python312/Lib/site-packages/pythonnet/_pyinstaller'],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['PyQt5', 'PyQt5_sip', 'PyQt6', 'PySide2', 'PySide6', 'cefpython3', 'webview.platforms.qt', 'webview.platforms.gtk', 'webview.platforms.cef', 'webview.platforms.cocoa', 'webview.platforms.android', 'webview.platforms.mshtml'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='image生图助手',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='app_icon.ico',
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='image生图助手',
)
