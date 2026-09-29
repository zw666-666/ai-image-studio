package com.artgen.app;

import java.util.concurrent.ConcurrentHashMap;

/** 前台服务与前端之间的结果传递。进程内单例。 */
public class GenBus {
    /** 图生图的源图片字节（通过内存传递，避开 Intent/Binder 约 1MB 大小限制）。 */
    public static volatile byte[] editImageBytes;
    /** 参考图字节（可选，参考图编辑时使用）。 */
    public static volatile byte[] editRefBytes;
    /** 生成结果缓存（taskId -> result/error JSON）。 */
    private static final ConcurrentHashMap<Integer, String> results = new ConcurrentHashMap<>();

    public static void putResult(int taskId, String json) {
        results.put(taskId, json);
    }

    /** 轮询结果；null 表示尚未完成，否则返回 JSON（成功含 dataUrl，失败含 error）。 */
    public static String pollResult(int taskId) {
        return results.get(taskId);
    }

    public static void removeResult(int taskId) {
        results.remove(taskId);
    }
}