#!/data/data/com.termux/files/usr/bin/bash
# xq24-tick — 由 termux-job-scheduler 每小时唤醒一次
#
# 为什么用「1 小时闹钟 + 脚本自己判断」而不是直接定时：
#   termux-job-scheduler 只能设「周期」（最小 15 分钟），不能设「每天 9 点」。
#   所以挂一个 1 小时的闹钟，到点才真抓，不到点秒退（不启浏览器，几乎不耗电）。
#   ⚠️ 代价：1 小时只有 1 次机会，被 Doze 压掉一次就丢一档（15 分钟时有 4 次机会）。
#      靠「最新 20 条 + 按 id 合并」兜底，丢一档不会漏帖，只是延迟。
#
# 抓取时刻表：
#   交易日（有成交的工作日）：9,10,11,12,13,14,15,19,23 点各一次
#   非交易日：                12 点、23 点各一次
#
# 「是不是交易日」不维护节假日表，直接问行情：取上证指数最后成交日期，
# 等于今天就说明今天开市。调休、节假日都能自动识别。
# 唯一例外是 9 点——开盘前当天还没成交，只能按星期判断（节假日会多跑一次，无害）。
set -uo pipefail

REPO="$HOME/xueqiu-24h"
LOG="$HOME/.local/share/xq24-tick.log"
STAMP="$HOME/.local/share/xq24-lastrun"
mkdir -p "$(dirname "$LOG")"

BIN=/data/data/com.termux/files/usr/bin
NOW_HOUR="${XQ24_TEST_HOUR:-$($BIN/date +%H)}"
TODAY=$($BIN/date +%F)
KEY="$TODAY-$NOW_HOUR"

# 同一小时只跑一次（1 小时闹钟正常只响 1 次；这行防的是补跑/手动重跑重复抓）
if [ -f "$STAMP" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$KEY" ]; then
  exit 0
fi

# 取上证指数最后成交日期（新浪，GBK）。失败返回空。
last_trade_date() {
  "$BIN/node" -e '
    (async () => {
      try {
        const r = await fetch("https://hq.sinajs.cn/list=sh000001", {
          headers: { Referer: "https://finance.sina.com.cn", "User-Agent": "Mozilla/5.0" },
        });
        const t = new TextDecoder("gbk").decode(Buffer.from(await r.arrayBuffer()));
        const m = t.match(/20\d{2}-\d{2}-\d{2}/);
        process.stdout.write(m ? m[0] : "");
      } catch { process.stdout.write(""); }
    })();
  ' 2>/dev/null
}

is_trading_day() {
  local d
  d=$(last_trade_date)
  if [ -n "$d" ]; then
    [ "$d" = "$TODAY" ]
  else
    [ "$($BIN/date +%u)" -le 5 ]   # 接口挂了就退回周一~周五，宁可多抓
  fi
}

ALLOWED=0
case "$NOW_HOUR" in
  12|23)
    ALLOWED=1 ;;                    # 每天固定两次，不分交易日
  09)
    [ "$($BIN/date +%u)" -le 5 ] && ALLOWED=1 ;;   # 开盘前无法用成交日期判断
  10|11|13|14|15|19)
    is_trading_day && ALLOWED=1 ;;
esac

[ "$ALLOWED" = "1" ] || exit 0

echo "$KEY" > "$STAMP"

# 日志超过 1MB 就轮转
if [ -f "$LOG" ] && [ "$("$BIN/stat" -c %s "$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  mv -f "$LOG" "$LOG.1"
fi

{
  echo "=== $($BIN/date '+%F %T')  时段=$NOW_HOUR 点 ==="
  "$BIN/node" "$REPO/scripts/crawl_xueqiu_deep.js" 2>&1

  # 抓完立刻把数据推到 GitHub（token 现读，不落盘）
  cd "$REPO" || exit 0
  git add data/xueqiu/ 2>/dev/null
  if git diff --cached --quiet 2>/dev/null; then
    echo "  （数据无变化，不提交）"
  else
    git -c user.name="termux-bot" -c user.email="termux@local" commit -q -m "data: 雪球抓取 $($BIN/date +%F) $NOW_HOUR 点" || true
    TOKEN=$("$BIN/node" -e 'const fs=require("fs");try{const c=JSON.parse(fs.readFileSync(process.env.HOME+"/.config/opencode/opencode.json","utf8"));process.stdout.write(c?.mcp?.servers?.github?.headers?.Authorization?.replace(/^Bearer /,"")||"")}catch(e){}')
    if [ -n "$TOKEN" ]; then
      git -c rebase.autoStash=true pull -q --rebase 2>&1 | tail -2
      if git push -q "https://x-access-token:$TOKEN@github.com/bym0122/xueqiu-24h.git" HEAD:main 2>&1; then
        echo "  → 已推送 GitHub"
      else
        echo "  → 推送失败（下次再试）"
      fi
    else
      echo "  → 找不到 token，未推送"
    fi
  fi
} >> "$LOG" 2>&1
