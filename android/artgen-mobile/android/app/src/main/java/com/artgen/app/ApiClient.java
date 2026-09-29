package com.artgen.app;

import android.content.ContentValues;
import android.content.Context;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 调用 BeeAPI 生图/图生图，并把结果保存到手机相册。
 * 所有方法都在后台线程被调用（来自 WebView 的 JavascriptInterface 桥线程），
 * 因此这里直接做同步网络请求是安全的。
 */
public class ApiClient {

    private static final String BASE_URL = "https://beeapi.dev/v1";
    private static final String VISION_BASE_URL_DEFAULT = "https://ark.cn-beijing.volces.com/api/v3";
    private static final String VISION_MODEL_DEFAULT = "doubao-seed-evolving";

    private final Context context;

    static {
        // 部分移动网络优先返回 IPv6，BeeAPI 某些上游路由对该出口不稳定；
        // 优先 IPv4，并关闭压缩/连接复用以提高 Android HttpURLConnection 兼容性。
        System.setProperty("java.net.preferIPv4Stack", "true");
        System.setProperty("java.net.preferIPv6Addresses", "false");
    }

    public ApiClient(Context context) {
        this.context = context;
    }

    private static String imageApiKey() throws Exception {
        if (BuildConfig.IMAGE_API_KEY == null || BuildConfig.IMAGE_API_KEY.isEmpty()) {
            throw new Exception("未配置图片生成 API Key");
        }
        return BuildConfig.IMAGE_API_KEY;
    }

    private static String visionApiKey() throws Exception {
        if (BuildConfig.VISION_API_KEY == null || BuildConfig.VISION_API_KEY.isEmpty()) {
            throw new Exception("未配置豆包视觉 API Key");
        }
        return BuildConfig.VISION_API_KEY;
    }

    private static String visionBaseUrl() {
        return BuildConfig.VISION_BASE_URL == null || BuildConfig.VISION_BASE_URL.isEmpty()
                ? VISION_BASE_URL_DEFAULT : BuildConfig.VISION_BASE_URL;
    }

    private static String visionModel() {
        return BuildConfig.VISION_MODEL == null || BuildConfig.VISION_MODEL.isEmpty()
                ? VISION_MODEL_DEFAULT : BuildConfig.VISION_MODEL;
    }

    /** 文生图。返回给前端的 JSON 包含 dataUrl / prompt / model / size / saved。 */
    public JSONObject generate(String prompt, String model, String size, String quality) throws Exception {
        String resolvedModel = model == null || model.trim().isEmpty() ? "gpt-image-2.5" : model.trim();
        String requestedSize = size == null || size.trim().isEmpty() ? "1024x1024" : size.trim();
        JSONObject body = new JSONObject();
        body.put("model", resolvedModel);
        body.put("prompt", prompt);
        body.put("size", requestedSize);
        body.put("n", 1);
        body.put("response_format", "b64_json");
        if (quality != null && !quality.trim().isEmpty() && !"auto".equals(quality.trim())) {
            body.put("quality", quality.trim());
        }

        String safeSize = safeImageSize(requestedSize);
        JSONObject standardFallback = new JSONObject();
        standardFallback.put("model", resolvedModel);
        standardFallback.put("prompt", prompt);
        standardFallback.put("size", safeSize);
        standardFallback.put("response_format", "b64_json");
        JSONObject squareFallback = new JSONObject();
        squareFallback.put("model", resolvedModel);
        squareFallback.put("prompt", prompt);
        squareFallback.put("size", "1024x1024");
        squareFallback.put("response_format", "b64_json");
        JSONObject[] attempts = {body, standardFallback, squareFallback, squareFallback};
        String[] attemptSizes = {requestedSize, safeSize, "1024x1024", "1024x1024"};
        long[] delays = {0L, 2500L, 5000L, 10000L};

        byte[] img = null;
        String usedSize = requestedSize;
        String usedModel = resolvedModel;
        Exception lastError = null;
        for (int i = 0; i < attempts.length; i++) {
            if (delays[i] > 0L) {
                try { Thread.sleep(delays[i]); } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                }
            }
            try {
                img = postJson("/images/generations", attempts[i]);
                usedSize = attemptSizes[i];
                break;
            } catch (Exception error) {
                lastError = error;
                if (!isRetryableImageError(error)) throw error;
            }
        }
        if (img == null && !"gpt-image-2".equals(resolvedModel)) {
            JSONObject modelFallback = new JSONObject();
            modelFallback.put("model", "gpt-image-2");
            modelFallback.put("prompt", prompt);
            modelFallback.put("size", "1024x1024");
            modelFallback.put("response_format", "b64_json");
            try {
                Thread.sleep(2500L);
                img = postJson("/images/generations", modelFallback);
                usedModel = "gpt-image-2";
                usedSize = "1024x1024";
            } catch (Exception fallbackError) {
                lastError = fallbackError;
            }
        }
        if (img == null) {
            throw new Exception("上游生图服务失败（已尝试模型 " + resolvedModel
                    + " 的 4 组参数" + (!"gpt-image-2".equals(resolvedModel)
                    ? "，并降级到 gpt-image-2" : "") + "）：" + safeMessage(lastError), lastError);
        }
        return buildResult(img, prompt, usedModel, usedSize);
    }

    private static boolean isRetryableImageError(Exception error) {
        String message = safeMessage(error).toLowerCase();
        return message.contains("upstream") || message.contains("retry")
                || message.contains("tempor") || message.contains("timeout")
                || message.contains("rejected") || message.contains("未返回图片数据")
                || message.contains("502") || message.contains("503")
                || message.contains("504") || message.contains("bad gateway")
                || message.contains("cloudflare") || message.contains("origin");
    }

    private static String safeMessage(Exception error) {
        String message = error == null ? null : error.getMessage();
        return message == null || message.trim().isEmpty() ? "未知错误" : message.trim();
    }

    /** 任意尺寸按方向映射到代理服务兼容性最好的三个标准尺寸。 */
    private static String safeImageSize(String size) {
        if (size == null || "auto".equalsIgnoreCase(size.trim())) return "1024x1024";
        try {
            String[] parts = size.trim().toLowerCase().split("x", 2);
            double ratio = (double) Integer.parseInt(parts[0]) / Integer.parseInt(parts[1]);
            if (ratio > 1.15) return "1536x1024";
            if (ratio < 0.87) return "1024x1536";
        } catch (Exception ignored) {}
        return "1024x1024";
    }

    /** 图生图（编辑）。imageBytes 为选中的源图片字节，size 为空/auto 时按原图比例。 */
    public JSONObject edit(byte[] imageBytes, String prompt, String model, String size) throws Exception {
        String resolved = resolveSize(size, imageBytes);
        byte[] img = postEdits(imageBytes, null, prompt, model, resolved);
        return buildResult(img, prompt, model, resolved);
    }

    /** 参考图编辑：原图 + 参考图，参考参考图风格/特征生成新图。 */
    public JSONObject referenceEdit(byte[] imageBytes, byte[] refBytes, String prompt, String model, String size) throws Exception {
        String resolved = resolveSize(size, imageBytes);
        byte[] img = postEdits(imageBytes, refBytes, prompt, model, resolved);
        return buildResult(img, prompt, model, resolved);
    }

    /** 图片转提示词：调用豆包视觉 Responses API，仅返回文字，不生成图片。 */
    private static String sanitizeVisionPrompt(String text) {
        String[][] replacements = new String[][]{
                {"女高中生", "明确成年的东亚年轻女性"},
                {"男高中生", "明确成年的东亚年轻男性"},
                {"高中生", "明确成年的年轻人"},
                {"未成年", "成年"},
                {"学生妹", "年轻女性"},
                {"少女", "年轻女性"},
                {"少年", "年轻男性"},
                {"女孩", "年轻女性"},
                {"男孩", "年轻男性"},
                {"女学生", "年轻女性"},
                {"男学生", "年轻男性"},
                {"女生", "年轻女性"},
                {"男生", "年轻男性"},
                {"校服", "校园风制服"},
                {"学生服", "校园风制服"},
                {"可口可乐", "红色饮料品牌风格"},
                {"Coca-Cola", "红色饮料品牌风格"}
        };
        boolean changed = false;
        for (String[] pair : replacements) {
            if (text.contains(pair[0])) {
                text = text.replace(pair[0], pair[1]);
                changed = true;
            }
        }
        text = text.replace("年轻年轻", "年轻").replace("成年成年", "成年");
        text = text.replace("校园风校园风制服", "校园风制服");
        if (changed && !text.contains("18岁以上") && !text.contains("成年")) {
            text += " 人物明确设定为18岁以上成年人，避免未成年身份或性化描述。";
        }
        return text.trim();
    }

    public JSONObject describeImage(byte[] imageBytes, String promptType, String language) throws Exception {
        if (imageBytes == null || imageBytes.length == 0) throw new Exception("图片为空");
        String imageUrl = "data:" + detectMime(imageBytes) + ";base64," + Base64.encodeToString(imageBytes, Base64.NO_WRAP);
        String type = promptType == null || promptType.isEmpty() ? "通用提示词" : promptType;
        String lang = language == null || language.isEmpty() ? "中文" : language;
        String instruction = "你是一名资深的视觉提示词工程师。输入图片是唯一事实来源，请先识别画面，再把可见信息"
                + "压缩成一段可直接粘贴到文生图模型的最终提示词。\n"
                + "提示词类型：" + type + "\n输出语言：" + lang + "\n"
                + "必须按这个顺序组织信息：主体与外观；材质与形状；动作或摆放；构图、景别与视角；"
                + "环境与背景；光线与阴影；色彩；风格与用途；镜头、景深与清晰度；必要的负面约束。\n"
                + "严格规则：只写图片中能观察或合理推断的内容，不臆造品牌、文字、尺寸、镜头焦段、光圈等不可见参数；"
                + "若图片中有文字，准确描述文字内容和位置；删除同义重复和空泛形容词，不连续堆砌‘高级、高清、细腻’；"
                + "下游模型兼容规则：人物无法确认年龄时，统一使用‘成年人物’或‘年轻女性/年轻男性’，明确按18岁以上处理；"
                + "禁止输出‘女高中生、男高中生、少女、少年、未成年、学生妹’等未成年身份词，也不要把‘校服’写成真实学生身份，"
                + "改写为‘校园风制服’或‘校园风西装’；避免性化身体描写；可识别商标、品牌名和大段文字改写为通用外观描述，除非用户明确要求保留；"
                + "不要把分析过程、标题、编号、Markdown、引号或‘提示词：’写进结果；不要把不存在的物体补出来。"
                + "输出一段完整、连贯、信息密度适中的提示词，长度控制在 160 至 320 个中文字符左右。";
        JSONObject textPart = new JSONObject();
        textPart.put("type", "input_text");
        textPart.put("text", instruction);
        JSONObject imagePart = new JSONObject();
        imagePart.put("type", "input_image");
        imagePart.put("image_url", imageUrl);
        JSONArray content = new JSONArray();
        content.put(textPart);
        content.put(imagePart);
        JSONObject message = new JSONObject();
        message.put("role", "user");
        message.put("content", content);
        JSONArray input = new JSONArray();
        input.put(message);
        JSONObject body = new JSONObject();
        body.put("model", visionModel());
        body.put("input", input);

        String resp = postVisionJson("/responses", body);
        String prompt = extractResponseText(new JSONObject(resp)).trim();
        if (prompt.startsWith("提示词：")) prompt = prompt.substring(4).trim();
        if (prompt.startsWith("提示词:")) prompt = prompt.substring(4).trim();
        if (prompt.isEmpty()) throw new Exception("视觉模型没有返回提示词");
        prompt = sanitizeVisionPrompt(prompt);
        JSONObject result = new JSONObject();
        result.put("prompt", prompt);
        result.put("model", visionModel());
        return result;
    }

    /** 多图编辑：image 字段可传多个文件（原图 + 可选参考图）。 */
    private byte[] postEdits(byte[] imageBytes, byte[] refBytes, String prompt, String model, String size) throws Exception {
        String mime = detectMime(imageBytes);
        String ext = mime.equals("image/jpeg") ? "jpg" : mime.equals("image/webp") ? "webp" : "png";

        String boundary = "----ArtGen" + System.currentTimeMillis();
        HttpURLConnection conn = (HttpURLConnection) new URL(BASE_URL + "/images/edits").openConnection();
        conn.setRequestMethod("POST");
        conn.setConnectTimeout(60000);
        conn.setReadTimeout(180000);
        conn.setRequestProperty("Authorization", "Bearer " + imageApiKey());
        conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
        conn.setDoOutput(true);

        try (DataOutputStream out = new DataOutputStream(conn.getOutputStream())) {
            writeFormField(out, boundary, "model", model);
            writeFormField(out, boundary, "prompt", prompt);
            writeFormField(out, boundary, "size", size);
            writeFileField(out, boundary, "image", "source." + ext, imageBytes, mime);
            if (refBytes != null) {
                writeFileField(out, boundary, "image", "reference." + ext, refBytes, detectMime(refBytes));
            }
            out.write(("--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
            out.flush();
        }

        String resp = readResponse(conn);
        return parseImageBytes(resp);
    }

    /** size 为空或 auto 时，按原图比例映射为最接近的预设尺寸。 */
    private String resolveSize(String size, byte[] imageBytes) {
        if (size == null || size.isEmpty() || "auto".equals(size)) {
            return sizeFromImage(imageBytes);
        }
        return size;
    }

    private static String sizeFromImage(byte[] data) {
        try {
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(data, 0, data.length, o);
            int w = o.outWidth, h = o.outHeight;
            if (w <= 0 || h <= 0) return "1024x1024";
            return sizeFromRatio(w, h);
        } catch (Exception e) {
            return "1024x1024";
        }
    }

    private static String sizeFromRatio(int w, int h) {
        double[] ratios = {1.0, 1.5, 2.0 / 3.0, 4.0 / 3.0, 3.0 / 4.0, 16.0 / 9.0, 9.0 / 16.0};
        String[] sizes = {"1024x1024", "1536x1024", "1024x1536", "1280x960", "960x1280", "1792x1024", "1024x1792"};
        double r = (double) w / h;
        int best = 0;
        double bestDiff = Double.MAX_VALUE;
        for (int i = 0; i < ratios.length; i++) {
            double d = Math.abs(ratios[i] - r);
            if (d < bestDiff) { bestDiff = d; best = i; }
        }
        return sizes[best];
    }

    // ---------- 通用 ----------

    private byte[] postJson(String path, JSONObject body) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(BASE_URL + path).openConnection();
        conn.setRequestMethod("POST");
        conn.setConnectTimeout(60000);
        conn.setReadTimeout(180000);
        conn.setRequestProperty("Authorization", "Bearer " + imageApiKey());
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("Accept", "application/json");
        conn.setRequestProperty("Accept-Encoding", "identity");
        conn.setRequestProperty("Connection", "close");
        conn.setRequestProperty("User-Agent", "ArtGen-Android/1.0");
        conn.setDoOutput(true);
        byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
        conn.setFixedLengthStreamingMode(payload.length);
        try (OutputStream os = conn.getOutputStream()) {
            os.write(payload);
        }
        String resp = readResponse(conn);
        return parseImageBytes(resp);
    }

    private static String postVisionJson(String path, JSONObject body) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(visionBaseUrl() + path).openConnection();
        conn.setRequestMethod("POST");
        conn.setConnectTimeout(60000);
        conn.setReadTimeout(180000);
        conn.setRequestProperty("Authorization", "Bearer " + visionApiKey());
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("Accept", "application/json");
        conn.setRequestProperty("User-Agent", "ArtGen-Android/1.0");
        conn.setDoOutput(true);
        byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
        conn.setFixedLengthStreamingMode(payload.length);
        try (OutputStream os = conn.getOutputStream()) {
            os.write(payload);
        }
        return readResponse(conn);
    }

    private static String extractResponseText(JSONObject response) {
        String direct = response.optString("output_text", "");
        if (!direct.isEmpty()) return direct;
        JSONArray output = response.optJSONArray("output");
        if (output == null) return "";
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < output.length(); i++) {
            JSONObject item = output.optJSONObject(i);
            if (item == null) continue;
            JSONArray content = item.optJSONArray("content");
            if (content == null) continue;
            for (int j = 0; j < content.length(); j++) {
                JSONObject part = content.optJSONObject(j);
                if (part != null) {
                    String value = part.optString("text", "");
                    if (!value.isEmpty()) text.append(value);
                }
            }
        }
        return text.toString();
    }

    /** 读取响应体；非 2xx 时抛出带错误信息的异常。 */
    private static String readResponse(HttpURLConnection conn) throws Exception {
        int code = conn.getResponseCode();
        InputStream is = (code >= 200 && code < 300) ? conn.getInputStream() : conn.getErrorStream();
        String resp = is == null ? "" : new String(readFully(is), StandardCharsets.UTF_8);
        if (code >= 300) {
            throw new Exception("接口错误 " + code + (resp.isEmpty() ? "" : ": " + resp));
        }
        return resp;
    }

    /** 从接口响应中取出图片字节：优先 b64_json，其次 url 下载。 */
    private static byte[] parseImageBytes(String resp) throws Exception {
        JSONObject json = new JSONObject(resp);
        JSONObject error = json.optJSONObject("error");
        if (error != null) {
            String message = error.optString("message", "未知接口错误");
            throw new Exception("接口返回错误：" + message);
        }

        JSONArray[] arrays = {
                json.optJSONArray("data"),
                json.optJSONArray("images"),
                json.optJSONArray("output"),
                json.optJSONArray("result")
        };
        for (JSONArray items : arrays) {
            if (items == null) continue;
            for (int i = 0; i < items.length(); i++) {
                JSONObject item = items.optJSONObject(i);
                if (item == null) continue;
                byte[] image = imageBytesFromItem(item);
                if (image != null && image.length > 0) return image;
            }
        }

        JSONObject dataObject = json.optJSONObject("data");
        if (dataObject != null) {
            byte[] image = imageBytesFromItem(dataObject);
            if (image != null && image.length > 0) return image;
        }
        byte[] topLevelImage = imageBytesFromItem(json);
        if (topLevelImage != null && topLevelImage.length > 0) return topLevelImage;
        String message = json.optString("message", "");
        if (!message.isEmpty()) throw new Exception("接口返回错误：" + message);
        throw new Exception("接口未返回图片数据（响应中没有可用的 base64 或图片 URL）");
    }

    private static byte[] imageBytesFromItem(JSONObject item) throws Exception {
        String[] base64Keys = {"b64_json", "base64", "image_base64"};
        for (String key : base64Keys) {
            String b64 = item.optString(key, "");
            if (!b64.isEmpty()) {
                int comma = b64.indexOf(',');
                if (b64.startsWith("data:") && comma >= 0) b64 = b64.substring(comma + 1);
                return Base64.decode(b64, Base64.DEFAULT);
            }
        }
        String url = item.optString("url", "");
        if (url.isEmpty()) {
            JSONObject imageUrl = item.optJSONObject("image_url");
            if (imageUrl != null) url = imageUrl.optString("url", "");
        }
        if (!url.isEmpty()) return download(url);
        return null;
    }

    private static byte[] download(String urlStr) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
        conn.setConnectTimeout(60000);
        conn.setReadTimeout(180000);
        try (InputStream is = conn.getInputStream()) {
            return readFully(is);
        }
    }

    /** 生成结果：转 data URL + 保存相册，组装返回 JSON。 */
    private JSONObject buildResult(byte[] img, String prompt, String model, String size) throws Exception {
        String dataUrl = "data:" + detectMime(img) + ";base64," + Base64.encodeToString(img, Base64.NO_WRAP);
        boolean saved;
        try {
            saveToGallery(img);
            saved = true;
        } catch (Exception e) {
            saved = false;
        }
        JSONObject o = new JSONObject();
        o.put("dataUrl", dataUrl);
        o.put("prompt", prompt);
        o.put("model", model);
        o.put("size", size);
        o.put("saved", saved);
        return o;
    }

    /** 保存到系统相册 Pictures/ArtGen 目录。 */
    private String saveToGallery(byte[] data) throws Exception {
        String mime = detectMime(data);
        String ext = mime.equals("image/jpeg") ? ".jpg" : mime.equals("image/webp") ? ".webp" : ".png";
        String name = "artgen_" + System.currentTimeMillis() + ext;

        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, name);
        values.put(MediaStore.Images.Media.MIME_TYPE, mime);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            values.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/ArtGen");
            values.put(MediaStore.Images.Media.IS_PENDING, 1);
        }
        Uri uri = context.getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new Exception("无法写入相册");
        try (OutputStream os = context.getContentResolver().openOutputStream(uri)) {
            if (os == null) throw new Exception("无法写入相册");
            os.write(data);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            values.clear();
            values.put(MediaStore.Images.Media.IS_PENDING, 0);
            context.getContentResolver().update(uri, values, null, null);
        }
        return uri.toString();
    }

    // ---------- 工具 ----------

    public static String detectMime(byte[] data) {
        if (data.length >= 8 && (data[0] & 0xFF) == 0x89 && data[1] == 'P' && data[2] == 'N' && data[3] == 'G') {
            return "image/png";
        }
        if (data.length >= 3 && (data[0] & 0xFF) == 0xFF && (data[1] & 0xFF) == 0xD8 && (data[2] & 0xFF) == 0xFF) {
            return "image/jpeg";
        }
        if (data.length >= 12 && data[0] == 'R' && data[1] == 'I' && data[2] == 'F' && data[3] == 'F'
                && data[8] == 'W' && data[9] == 'E' && data[10] == 'B' && data[11] == 'P') {
            return "image/webp";
        }
        return "image/png";
    }

    public static byte[] readFully(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }

    private static void writeFormField(OutputStream out, String boundary, String name, String value) throws Exception {
        out.write(("--" + boundary + "\r\n").getBytes(StandardCharsets.UTF_8));
        out.write(("Content-Disposition: form-data; name=\"" + name + "\"\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        out.write(value.getBytes(StandardCharsets.UTF_8));
        out.write("\r\n".getBytes(StandardCharsets.UTF_8));
    }

    private static void writeFileField(OutputStream out, String boundary, String name, String filename,
                                       byte[] data, String mime) throws Exception {
        out.write(("--" + boundary + "\r\n").getBytes(StandardCharsets.UTF_8));
        out.write(("Content-Disposition: form-data; name=\"" + name + "\"; filename=\"" + filename + "\"\r\n")
                .getBytes(StandardCharsets.UTF_8));
        out.write(("Content-Type: " + mime + "\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        out.write(data);
        out.write("\r\n".getBytes(StandardCharsets.UTF_8));
    }
}
