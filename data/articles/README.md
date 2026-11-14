# data/articles/ 目录说明

## 用途
存放用户手动指定的雪球单篇帖子（含主贴 + 全部评论串），与 `data/xueqiu/<uid>/YYYY-MM-DD.json`（24h 自动抓取的帖子流）区分。

## 目录结构
```
data/articles/
  2026-11-13/
    1910783512_416681098.json
    4531216350_416467387.json
  2026-11-15/
    9493911686_416xxxxxx.json
    ...
```

## 规则
1. **文件夹 = 帖子发布日期**（不是抓取日期）。格式 `YYYY-MM-DD`（北京时区）。
2. **文件名 = `<作者uid>_<帖子id>.json`**。uid 是雪球用户 ID（纯数字），帖子 id 是链接最后一段。
3. **一个帖子 = 一个文件**。如果同一帖子被重复抓取，直接覆盖（按 id 去重）。
4. 如果某天没有指定帖子，该天文件夹可以不创建（不必空目录）。

## JSON 格式
```json
{
  "user_id": "1910783512",
  "post_id": "416681098",
  "title": "简要标题（可选，用于人类阅读）",
  "url": "https://xueqiu.com/1910783512/416681098",
  "publish_time": "2026-11-13T09:06:00+08:00",
  "crawled_at": "2026-11-13 11:30",
  "comment_count": 22,
  "posts": [
    {
      "post_id": "416681098",
      "text": "主贴正文（纯文本，换行用 \\n）",
      "created_at": "2026-11-13T09:06:00+00:00",
      "is_original": true
    }
  ],
  "comments": [
    {
      "comment_id": "...",
      "user_id": "...",
      "user_name": "评论者昵称",
      "text": "评论内容",
      "created_at": "2026-11-13T09:09:00+00:00",
      "replies": [
        {"user_name": "...", "text": "...", "created_at": "..."}
      ]
    }
  ]
}
```

## 抓取工具
```bash
xq https://xueqiu.com/<uid>/<postid>          # 人读格式
xq https://xueqiu.com/<uid>/<postid> --json   # JSON 格式（直接写入 articles/）
```

## 注意事项
- 雪球匿名接口只能抓第 1 页评论（约 20 条），深度评论需要 `--json` 后手动补
- `xq` 脚本每次约 25 秒，会临时起 headless Chromium
- 同一帖子如果之前已存过，用 `--json` 重新抓会覆盖旧文件（保留最新）
