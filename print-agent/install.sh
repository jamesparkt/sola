#!/usr/bin/env bash
# GCC print-agent 리눅스 설치 — gcc-node 에서: sudo ./install.sh [프린터IP]
# 여러 번 돌려도 안전하다. config.json 이 이미 있으면 건드리지 않는다.
set -euo pipefail

PRINTER_IP="${1:-192.168.45.176}"
QUEUE=GCC_Brother
SRC="$(cd "$(dirname "$0")" && pwd)"
APP=/opt/gcc-print-agent
ETC=/etc/gcc-print-agent

[ "$(id -u)" = 0 ] || { echo "sudo 로 실행해 주세요: sudo $0"; exit 1; }

echo "== 1. 패키지 설치 (CUPS, ipptool, pdfinfo, Node.js)"
apt-get update -q
apt-get install -y -q cups cups-client cups-filters cups-ipp-utils poppler-utils nodejs
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || { echo "Node.js 18 이상이 필요합니다 (현재 $(node -v))"; exit 1; }
systemctl enable --now cups

echo "== 2. 프린터 등록 ($PRINTER_IP, 드라이버 없이 IPP Everywhere)"
if ! ipptool -T 5 "ipp://$PRINTER_IP/ipp/print" "$SRC/ipp/get-printer.test" >/dev/null 2>&1; then
  echo "프린터($PRINTER_IP)에 연결할 수 없습니다. 전원·와이파이·IP를 확인해 주세요."
  echo "IP가 바뀌었으면: sudo $0 새IP"
  exit 1
fi
lpadmin -p "$QUEUE" -E -v "ipp://$PRINTER_IP/ipp/print" -m everywhere \
  -D "Brother DCP-T720DW" -L "GCC 사무실"
# 기본값: 주보 기준 — A4, 짧은 쪽 넘김 양면, 용지에 맞춤. (에이전트는 작업마다 단면/양면을 직접 지정한다)
lpadmin -p "$QUEUE" -o media-default=iso_a4_210x297mm \
  -o sides-default=two-sided-short-edge -o print-scaling-default=fit \
  -o printer-error-policy=retry-job
lpadmin -d "$QUEUE"
cupsenable "$QUEUE"; cupsaccept "$QUEUE"

echo "== 3. 에이전트 설치 ($APP)"
id gcc-print >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin gcc-print
mkdir -p "$APP/ipp" "$ETC"
install -m 644 "$SRC/agent.js" "$APP/agent.js"
install -m 644 "$SRC"/ipp/*.test "$APP/ipp/"
if [ ! -f "$ETC/config.json" ]; then
  install -m 640 -o root -g gcc-print "$SRC/config.example.json" "$ETC/config.json"
  sed -i "s#ipp://192.168.45.176/ipp/print#ipp://$PRINTER_IP/ipp/print#" "$ETC/config.json"
  NEW_CONFIG=1
else
  sed -i -E "s#ipp://[0-9.]+/ipp/print#ipp://$PRINTER_IP/ipp/print#" "$ETC/config.json"
fi

echo "== 4. 부팅 시 자동 시작 (systemd)"
install -m 644 "$SRC/gcc-print-agent.service" /etc/systemd/system/gcc-print-agent.service
systemctl daemon-reload
systemctl enable gcc-print-agent

if grep -q '여기에' "$ETC/config.json"; then
  echo
  echo "!! $ETC/config.json 에 토큰이 아직 비어 있습니다."
  echo "   sudo nano $ETC/config.json  으로 채운 뒤:  sudo systemctl restart gcc-print-agent"
else
  systemctl restart gcc-print-agent
  sleep 3
  systemctl --no-pager status gcc-print-agent | head -5
fi

echo
echo "== 5. 시험 인쇄 (CUPS 시험 페이지 1장, 단면)"
lp -d "$QUEUE" -t "GCC 리눅스 프린터 시험" -o sides=one-sided /usr/share/cups/data/testprint
echo "완료. 로그 보기: journalctl -u gcc-print-agent -f"
