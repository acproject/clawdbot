#!/bin/bash

echo "🔧 配置 macOS 为永不休眠（服务器模式）..."

# 1. 关闭所有睡眠相关功能
echo "➡️ 设置 pmset..."
sudo pmset -a sleep 0
sudo pmset -a displaysleep 0
sudo pmset -a disksleep 0
sudo pmset -a autopoweroff 0
sudo pmset -a standby 0

# 2. 禁用 App Nap（全局）
echo "➡️ 禁用 App Nap..."
defaults write NSGlobalDomain NSAppSleepDisabled -bool YES

# 3. 创建 caffeinate 守护（launchd）
echo "➡️ 创建开机防休眠守护..."

PLIST_PATH="$HOME/Library/LaunchAgents/keepawake.plist"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
"http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>keepawake</string>

    <key>ProgramArguments</key>
    <array>
      <string>/usr/bin/caffeinate</string>
      <string>-dimsu</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>
  </dict>
</plist>
EOF

# 加载服务
launchctl unload "$PLIST_PATH" 2>/dev/null
launchctl load "$PLIST_PATH"

# 4. 启动当前 caffeinate（立即生效）
echo "➡️ 启动当前防休眠进程..."
pkill caffeinate 2>/dev/null
caffeinate -dimsu &

# 5. 输出当前状态
echo "➡️ 当前电源配置："
pmset -g

echo ""
echo "✅ 完成！Mac mini 已进入『服务器模式』："
echo "   - 永不休眠"
echo "   - 防止后台降频"
echo "   - 开机自动保持唤醒"
echo ""

echo "⚠️ 建议："
echo "   - 确保机器通风良好（长时间运行）"
echo "   - 可配合 watchdog 监控 OpenClaw"