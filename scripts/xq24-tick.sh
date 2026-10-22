#!/data/data/com.termux/files/usr/bin/bash
# xq24-tick — 每 15 分钟被 termux-job-scheduler 调用一次
# 作用：抓雪球两位作者的最新页 + 原创翻页，按 id 合并进当天 JSON。
#
# 为什么需要它：
#   雪球匿名接口 /v4/statuses/user_timeline.json 只能拿第 1 页（约 20 条），
#   第 2 页返回「请登录雪球查看更多内容」。所以「抓全」唯一靠谱的办法是
#   高频轮询 + 按 id 合并：两次轮询之间作者发帖 <20 条，就不会漏。
#   实测第 1 页约覆盖 7–10 小时，15 分钟一次有 25 倍以上余量。
set -uo pipefail

REPO="$HOME/xueqiu-24h"
LOG="$HOME/.local/share/xq24-tick.log"
mkdir -p "$(dirname "$LOG")"

# 日志超过 1MB 就轮转
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  mv -f "$LOG" "$LOG.1"
fi

{
  echo "=== $(date '+%F %T') ==="
  node "$REPO/scripts/crawl_xueqiu_deep.js" 2>&1
} >> "$LOG" 2>&1
