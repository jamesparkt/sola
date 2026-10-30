# GCC print-agent (리눅스판)

노션 **GCC 프린트 큐**를 15초마다 확인해서, `대기중` 행의 PDF(첨부 또는 드라이브 파일)를 받아
사무실 **Brother DCP-T720DW**로 인쇄하고, 슬랙 **#클로드**에 시작·경고·완료·실패를 알린다.
예전 윈도우 미니PC의 `C:\gcc\print-agent` 를 gcc-node(리눅스)로 옮긴 것이다.

| 윈도우판 | 리눅스판 |
|---|---|
| SumatraPDF + 윈도우 드라이버 | CUPS + IPP Everywhere (드라이버 설치 없음) |
| 시작프로그램 `start-agent.bat` | systemd `gcc-print-agent` (재부팅 시 자동 시작, 죽으면 10초 뒤 재시작) |
| `config.json` 옆에 두기 | `/etc/gcc-print-agent/config.json` (권한 640) |

## 설치 (gcc-node 에서, 한 번만)

```bash
git clone -b ccr-a2e60fb3-eww7dm https://github.com/jamesparkt/sola.git
cd sola/print-agent
sudo ./install.sh              # 프린터 IP가 바뀌었으면: sudo ./install.sh 192.168.45.xxx
```

스크립트가 하는 일: CUPS·Node 설치 → 프린터를 `GCC_Brother` 로 등록(기본값 A4·짧은 쪽 넘김 양면·용지에 맞춤)
→ 에이전트를 `/opt/gcc-print-agent` 에 설치 → 부팅 시 자동 시작 등록 → CUPS 시험 페이지 1장.

## 토큰 넣기

```bash
sudo nano /etc/gcc-print-agent/config.json
sudo systemctl restart gcc-print-agent
```

- `notionToken` — 노션 → 설정 → 연결 → 통합 만들기(내부). 그다음 **GCC 프린트 큐** DB 페이지 `•••` → 연결 → 그 통합 추가.
- `slackBotToken` — 슬랙 앱(권한 `chat:write`)의 `xoxb-` 토큰. **#클로드는 비공개 채널이라** 채널에서 `/invite @앱이름` 필요.
  (봇 대신 수신 웹후크를 쓰려면 `slackWebhookUrl` 만 채우면 된다.)
- `driveProxyUrl` / `driveProxyKey` — GAS **GCC 프린트 파일 프록시** → 배포 관리의 웹앱 주소, 프로젝트 설정 → 스크립트 속성 `PROXY_KEY`.

## 동작 규칙

- `양면` 꺼짐 → 단면. 켜짐 → `넘김` 이 `위로 넘김`이면 짧은 쪽(주보·가로형), `옆으로 넘김`이면 긴 쪽(세로형).
  `넘김` 이 비어 있으면 PDF가 가로면 위로, 세로면 옆으로 넘긴다.
- 완료는 CUPS가 프린터로부터 작업 완료를 받은 시점(`job-state=completed`)에 기록한다.
- 인쇄 중 프린터 경고(용지 없음·걸림·덮개 열림·잉크)는 5초마다 IPP로 확인해 ⚠️ 로 알리고, 풀리면 🔄.
- 에이전트가 인쇄 도중 재시작되면 그 행은 다시 찍지 않고 `오류`로 남긴다(중복 인쇄 방지). 재시도는 상태를 `대기중`으로.

## 점검

```bash
systemctl status gcc-print-agent      # 돌고 있는지
journalctl -u gcc-print-agent -f      # 실시간 로그
lpstat -p GCC_Brother -l              # 프린터 상태
```
