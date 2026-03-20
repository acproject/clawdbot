#!/bin/bash

while true; do
  if ! pgrep -f openclaw > /dev/null; then
    echo "⚠️ OpenClaw 未运行，正在重启..."
    /path/to/start_openclaw.sh
  fi
  sleep 30
done

# 尽量使用launchctl 调用 com.openclaw.agent.plist
