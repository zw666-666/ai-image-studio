# AI Image Studio（AI 生图与提示词工坊）

一个面向个人创作的桌面与 Android 生图工具，串联文生图、参考图编辑、图片转提示词和生成历史管理。

> 本仓库用于展示项目实现，**不包含任何可用的个人 API Key**。克隆代码后，图像生成与视觉识别功能需要你自行配置并承担相应服务商账号及调用费用。

## 功能

- 文生图、参考图编辑和批量生成
- 使用视觉模型把图片整理为可继续编辑的提示词
- 本地历史图库、缩略图和生成记录
- 上游异常重试及备用模型回退
- Windows 桌面端：PyWebView + Python + HTML/JavaScript
- Android 端：Capacitor + Java 前台服务，支持长任务通知及保存生成图片

## 技术结构

- 桌面端由 Python 提供业务能力，PyWebView 将 Python API 暴露给 Web 界面。
- 本地图像和历史记录由应用保存；项目不提供云端账户或代付 API 服务。
- Android 端复用 Web UI，并由 Java 服务执行较长时间的生图任务。
- 图像生成与视觉理解通过配置的外部 API 完成；项目不包含模型权重或本地推理引擎。

## Windows 开发运行

需要 Python 3.12（项目当前开发/打包环境）：

1. 创建并激活虚拟环境。
2. 安装依赖：pip install -r requirements.txt
3. 按应用的本地配置流程填写你自己的图像和视觉 API 参数。
4. 启动：python app.py

API Key 只应保存在自己的本机配置中，不要写进 Python、JavaScript、配置模板、截图或提交记录。

## Android 构建

Android 工程位于 android/artgen-mobile。使用 Android Studio/Android SDK，并按工程配置安装 Node.js 依赖、同步 Capacitor 资源后构建。

构建参数模板见 android/artgen-mobile/android/local.properties.example。复制为本机的 local.properties，填写本机 Android SDK 路径和自己的 API 参数。local.properties 已被 Git 忽略，不要强行添加到版本控制。

**安全提醒：Android 构建会将本地配置中的 API 参数注入应用 BuildConfig。生成的 APK 可能被分析并提取其中的 Key。不要发布或上传使用你个人 API Key 构建的 APK；要分发给其他人，应让使用者配置自己的 Key，或将调用改为由你控制的服务端代理。**

## 密钥与文件安全

- 仓库源码不携带个人 Key，其他人克隆仓库无法直接使用你的 API 额度。
- .gitignore 排除了本地密钥、local.properties、数据库、验收记录、依赖目录、打包目录和 APK/EXE。
- 不要把 API Key 粘贴到 README、源码、Issue、截图或 GitHub Actions 日志。
- 如果密钥曾经提交到 Git，即使之后删除文件，旧提交里仍可能保留；应立即在对应服务商处撤销并重新生成。

## 主要目录

- app.py：桌面应用入口
- backend.py：图像生成、提示词、历史记录等 Python 逻辑
- web/：桌面端 HTML、CSS 和 JavaScript
- android/artgen-mobile/android/app/src/main/java/：Android Java 代码
- android/artgen-mobile/www/：Android 使用的 Web 资源
- ArtGen.spec、setup.iss：Windows 打包配置
