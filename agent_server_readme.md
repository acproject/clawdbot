# 创建 launchd 配置

~/Library/LaunchAgents/com.openclaw.agent.plist

# 创建日志目录

mkdir -p ~/openclaw/logs

# 赋予执行权限

chmod +x ~/openclaw/start_openclaw.sh

# 加载服务

launchctl load ~/Library/LaunchAgents/com.openclaw.agent.plist

# 查看状态

launchctl list | grep openclaw

# 停止服务

launchctl unload ~/Library/LaunchAgents/com.openclaw.agent.plist

# 重启服务

launchctl unload ~/Library/LaunchAgents/com.openclaw.agent.plist
launchctl load ~/Library/LaunchAgents/com.openclaw.agent.plist

# 查看日志

tail -f ~/openclaw/logs/out.log
tail -f ~/openclaw/logs/error.log

# 限制重启频率（防止疯狂 crash）

<key>ThrottleInterval</key>
<integer>10</integer>

# 只在失败时重启（更优雅）

<key>KeepAlive</key>
<dict>
<key>SuccessfulExit</key>
<false/>
</dict>
