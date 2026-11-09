#!/data/data/com.termux/files/usr/bin/bash
# xq24-tick — 由 termux-job-scheduler 每 15 分钟唤醒一次
#
# 为什么用「闹钟 + 脚本自己判断」而不是直接定时：
#   termux-job-scheduler 只能设「周期」（最小 15 分钟），不能设「每天 9 点」。
#   所以挂一个 15 分钟的闹钟，到点才真抓，不到点秒退（不启浏览器，几乎不耗电）。
#
# 两个任务，各自有自己的时刻表：
#
#   ① 微博（weibo_tick）—— 06–23 点，每 30 分钟一次
#      匿名接口每次只回最新 10 条、翻不了页，跑得越密漏得越少。
#      本机能抓（chromium 拿 visitor cookie 后从页面上下文 fetch），见下面注释。
#
#   ② 雪球（下面「交易日判断」那段）—— 交易日 9,10,11,12,13,14,15,19,23 点；非交易日 12、23 点
#      靠「最新 20 条 + 按 id 合并」兜底，1 小时 1 次足够。
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

# 日志超过 1MB 就轮转
rotate_log() {
  if [ -f "$LOG" ] && [ "$("$BIN/stat" -c %s "$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
    mv -f "$LOG" "$LOG.1"
  fi
}

# GitHub token 现读，不落盘
gh_token() {
  "$BIN/node" -e 'const fs=require("fs");try{const c=JSON.parse(fs.readFileSync(process.env.HOME+"/.config/opencode/opencode.json","utf8"));process.stdout.write(c?.mcp?.servers?.github?.headers?.Authorization?.replace(/^Bearer /,"")||"")}catch(e){}'
}

# 提交 + 推送。任何一步失败都不留半成品状态（历史上 pull --rebase 撞冲突没 abort，
# 仓库带着未合并文件，之后每次 commit/push 全失败）。
push_all() {
  local token
  cd "$REPO" || return 0
  token=$(gh_token)
  if [ -z "$token" ]; then
    echo "  → 找不到 token，未推送" >> "$LOG"
    return 0
  fi
  git fetch -q origin main 2>>"$LOG" || { echo "  → fetch 失败，本轮不推" >> "$LOG"; return 0; }
  if ! git merge -q --no-edit origin/main >>"$LOG" 2>&1; then
    echo "  → merge 有冲突，已 abort，本轮不推（下轮再试）" >> "$LOG"
    git merge --abort 2>/dev/null
    return 0
  fi
  # http.version=HTTP/1.1：实测 HTTP/2 连 github.com 会卡到 133s 超时，1.1 秒过
  if git -c http.version=HTTP/1.1 push -q "https://x-access-token:$token@github.com/bym0122/xueqiu-24h.git" HEAD:main 2>>"$LOG"; then
    echo "  → 已推送 GitHub" >> "$LOG"
  else
    echo "  → 推送失败（下次再试）" >> "$LOG"
  fi
}

# ---------------------------------------------------------------
# 微博：本机自己抓（2026-11-09 实测更正）
#
# 以前的结论「本机抓不了微博、只能靠 GH Action」是错的。curl / node fetch 直连
# m.weibo.cn 确实一律 432，但那是**客户端指纹**被拦（不是 IP、也不是 TUN 层 RST）：
#   curl -s -w '%{http_code}' https://m.weibo.cn/api/...  → 432，178ms 就回，连接是通的
#   chromium 打开 m.weibo.cn 拿到 visitor cookie（SUBP / _T_WM）后，从页面上下文
#   fetch 同一个接口 → 200，正常出帖子。scripts/crawl_weibo_local.js 就是干这个的，
#   2026-11-09 11:2x 本机实测两个号都跑通。
#
# 所以微博不再走「本机调 API 触发 GH Action」，直接本地抓，好处：
#   1) 不用等 GH 排队，抓完立刻能看
#   2) 不受 GH 把 schedule 降频到 4–8 小时的影响
#   3) 少一层跨仓库写入竞争（GH 那个 cron 已停，只留 workflow_dispatch 备用）
# ---------------------------------------------------------------
WEIBO_STAMP="$HOME/.local/share/weibo-tick-last"
WEIBO_PROFILE="$PREFIX/tmp/opencode/cr-weibo-local"

weibo_tick() {
  local hh mm slot key
  # XQ24_TEST_* 只给手动测试用，正常运行不设
  hh="${XQ24_TEST_HOUR:-$($BIN/date +%H)}"; mm="${XQ24_TEST_MIN:-$($BIN/date +%M)}"
  # 只在他会发帖的时段跑（实测 05–23 点），夜里跑纯属浪费电
  case "$hh" in
    0[5-9]|1[0-9]|2[0-3]) ;;
    *) return 0 ;;
  esac
  # 每 30 分钟一档：00–14 分 = :00 档，30–44 分 = :30 档
  if [ "$((10#$mm))" -lt 15 ]; then
    slot="00"
  elif [ "$((10#$mm))" -ge 30 ] && [ "$((10#$mm))" -lt 45 ]; then
    slot="30"
  else
    return 0
  fi
  key="$TODAY-$hh:$slot"
  if [ -f "$WEIBO_STAMP" ] && [ "$(cat "$WEIBO_STAMP" 2>/dev/null)" = "$key" ]; then
    return 0
  fi

  rotate_log
  echo "=== $($BIN/date '+%F %T')  微博 $slot 分档 ===" >> "$LOG"

  if ( cd "$REPO" && "$BIN/node" scripts/crawl_weibo_local.js ) >> "$LOG" 2>&1; then
    echo "$key" > "$WEIBO_STAMP"
    git -C "$REPO" add data/weibo/ 2>/dev/null
    if ! git -C "$REPO" diff --cached --quiet 2>/dev/null; then
      git -C "$REPO" -c user.name="termux-bot" -c user.email="termux@local" commit -q \
        -m "data: 微博抓取 $TODAY $hh:$slot（本机）" || true
      push_all
    else
      echo "  （无新增，不提交）" >> "$LOG"
    fi
  else
    # 失败(多半是 visitor cookie 失效)就清掉 profile，下一档从零重来
    echo "  → 抓取失败，清 profile，下一档重试" >> "$LOG"
    rm -rf "$WEIBO_PROFILE"
  fi
}

weibo_tick

# ---------------------------------------------------------------
# 雪球：同一小时只跑一次（15 分钟闹钟会响 4 次，这里去重）
# ---------------------------------------------------------------
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

rotate_log

{
  echo "=== $($BIN/date '+%F %T')  时段=$NOW_HOUR 点 ==="
  "$BIN/node" "$REPO/scripts/crawl_xueqiu_deep.js" 2>&1

  git -C "$REPO" add data/xueqiu/ 2>/dev/null
  if git -C "$REPO" diff --cached --quiet 2>/dev/null; then
    echo "  （雪球数据无变化，不提交）"
  else
    git -C "$REPO" -c user.name="termux-bot" -c user.email="termux@local" commit -q \
      -m "data: 雪球抓取 $TODAY $NOW_HOUR 点" || true
  fi
  # 雪球没变化时也别直接返回：微博可能攒了本地提交没推上去
  push_all
} >> "$LOG" 2>&1
