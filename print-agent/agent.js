#!/usr/bin/env node
// GCC print-agent (Linux) — 노션 GCC 프린트 큐를 폴링해 CUPS로 인쇄하고 슬랙 #클로드에 알린다.
// 외부 npm 패키지 없음. 필요한 것: Node 18+, cups-client(lp), cups-ipp-utils(ipptool), poppler-utils(pdfinfo).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const VERSION = 'linux-1.0';
const CONFIG_PATH = process.env.GCC_PRINT_CONFIG || '/etc/gcc-print-agent/config.json';
const IPP_DIR = path.join(__dirname, 'ipp');
const NOTION_VERSION = '2025-09-03';

const cfg = {
  pollSeconds: 15,
  statusSeconds: 5,
  jobTimeoutMinutes: 30,
  cupsQueue: 'GCC_Brother',
  printerUri: 'ipp://192.168.45.176/ipp/print',
  media: 'iso_a4_210x297mm',
  scaling: 'fit',
  ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')),
};
for (const k of ['notionToken', 'dataSourceId']) {
  if (!cfg[k] || String(cfg[k]).includes('여기에')) {
    console.error(`config.json 의 ${k} 가 비어 있습니다 (${CONFIG_PATH})`);
    process.exit(2);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${cmd} 실패: ${(stderr || err.message).trim()}`;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

// ---------- Slack ----------
async function slack(text) {
  try {
    if (cfg.slackWebhookUrl) {
      await fetch(cfg.slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    } else if (cfg.slackBotToken && cfg.slackChannel) {
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${cfg.slackBotToken}` },
        body: JSON.stringify({ channel: cfg.slackChannel, text }),
      });
      const j = await res.json();
      if (!j.ok) log('슬랙 오류:', j.error);
    }
  } catch (e) {
    log('슬랙 전송 실패:', e.message);
  }
}

// ---------- Notion ----------
async function notion(method, url, body) {
  const res = await fetch(`https://api.notion.com/v1${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.notionToken}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`노션 ${res.status}: ${j.message || JSON.stringify(j)}`);
  return j;
}

const queryByStatus = (status) =>
  notion('POST', `/data_sources/${cfg.dataSourceId}/query`, {
    filter: { property: '상태', select: { equals: status } },
    sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
    page_size: 20,
  }).then((j) => j.results);

function updateRow(pageId, { status, pages, error }) {
  const properties = {};
  if (status) properties['상태'] = { select: { name: status } };
  if (pages != null) properties['면수'] = { number: pages };
  if (error != null) properties['오류내용'] = { rich_text: [{ text: { content: String(error).slice(0, 1900) } }] };
  if (status === '완료' || status === '오류') properties['처리일시'] = { date: { start: new Date().toISOString() } };
  return notion('PATCH', `/pages/${pageId}`, { properties });
}

function readRow(page) {
  const p = page.properties;
  const text = (prop) => (prop?.title || prop?.rich_text || []).map((t) => t.plain_text).join('').trim();
  return {
    id: page.id,
    title: text(p['제목']) || '(제목 없음)',
    files: p['파일']?.files || [],
    driveId: text(p['드라이브파일ID']),
    copies: Math.max(1, Math.min(50, Math.round(p['부수']?.number || 1))),
    duplex: !!p['양면']?.checkbox,
    flip: p['넘김']?.select?.name || '',
  };
}

// ---------- 파일 받기 ----------
async function fetchPdf(row, dest) {
  let buf;
  if (row.files.length) {
    const f = row.files[0];
    const url = f.type === 'file' ? f.file.url : f.external.url;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`첨부 다운로드 실패 (${res.status})`);
    buf = Buffer.from(await res.arrayBuffer());
  } else if (row.driveId) {
    if (!cfg.driveProxyUrl) throw new Error('config.json 에 driveProxyUrl 이 없습니다');
    const u = new URL(cfg.driveProxyUrl);
    u.searchParams.set('key', cfg.driveProxyKey || '');
    u.searchParams.set('file', row.driveId);
    const res = await fetch(u, { redirect: 'follow' });
    const j = await res.json().catch(() => null);
    if (!j) throw new Error(`드라이브 프록시 응답 오류 (${res.status})`);
    if (!j.ok) throw new Error(`드라이브 프록시: ${j.error}`);
    buf = Buffer.from(j.b64, 'base64');
  } else {
    throw new Error('파일 첨부도 드라이브파일ID 도 없습니다');
  }
  if (buf.subarray(0, 5).toString() !== '%PDF-') throw new Error('PDF가 아닙니다');
  fs.writeFileSync(dest, buf);
}

async function pdfInfo(file) {
  const out = await run('pdfinfo', [file]);
  const pages = Number(/^Pages:\s+(\d+)/m.exec(out)?.[1] || 0);
  const m = /^Page size:\s+([\d.]+) x ([\d.]+)/m.exec(out);
  const rot = Number(/^Page rot:\s+(\d+)/m.exec(out)?.[1] || 0);
  let landscape = m ? Number(m[1]) > Number(m[2]) : false;
  if (rot % 180 === 90) landscape = !landscape;
  return { pages, landscape };
}

// ---------- IPP ----------
async function ipp(uri, test, vars = {}) {
  const args = ['-c', '-T', '10'];
  for (const [k, v] of Object.entries(vars)) args.push('-d', `${k}=${v}`);
  args.push('-d', `user=${os.userInfo().username}`, uri, path.join(IPP_DIR, test));
  const out = await run('ipptool', args).catch(() => '');
  // -c 출력: 첫 줄 속성 이름, 둘째 줄 값 (CSV, 여러 값은 따옴표 안에 쉼표로)
  const [head, values] = String(out).trim().split('\n').map(csvLine);
  const attrs = {};
  (head || []).forEach((k, i) => (attrs[k] = (values || [])[i] || ''));
  return attrs;
}

function csvLine(line) {
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') cur += '"', i++;
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') cells.push(cur), (cur = '');
    else cur += c;
  }
  cells.push(cur);
  return cells;
}

const REASONS = [
  [/media-empty|media-needed/, '용지 없음'],
  [/media-jam/, '용지 걸림'],
  [/door-open|cover-open|interlock-open/, '덮개 열림'],
  [/marker-supply-empty|toner-empty/, '잉크 없음'],
  [/marker-supply-low|toner-low/, '잉크 부족'],
  [/offline|shutdown/, '프린터 꺼짐/오프라인'],
];
async function printerProblems() {
  const a = await ipp(cfg.printerUri, 'get-printer.test');
  if (!a['printer-state']) return ['프린터 응답 없음'];
  const reasons = (a['printer-state-reasons'] || '').split(',');
  const found = new Set();
  for (const r of reasons) for (const [re, label] of REASONS) if (re.test(r) && !/-report$/.test(r)) found.add(label);
  if (!found.size && a['printer-state'] === 'stopped') found.add(`프린터 정지 (${a['printer-state-message'] || a['printer-state-reasons']})`);
  return [...found];
}

// ---------- 한 작업 처리 ----------
async function processRow(page) {
  const row = readRow(page);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gccprint-'));
  const file = path.join(tmp, 'job.pdf');
  try {
    await updateRow(row.id, { status: '인쇄중' });
    await fetchPdf(row, file);
    const info = await pdfInfo(file);
    let sides = 'one-sided';
    if (row.duplex) {
      const flip = row.flip || (info.landscape ? '위로 넘김' : '옆으로 넘김');
      sides = flip === '위로 넘김' ? 'two-sided-short-edge' : 'two-sided-long-edge';
    }
    const sheetsPerCopy = row.duplex ? Math.ceil(info.pages / 2) : info.pages;
    const faces = info.pages * row.copies;
    await updateRow(row.id, { pages: faces });

    const out = await run('lp', [
      '-d', cfg.cupsQueue,
      '-n', String(row.copies),
      '-t', row.title,
      '-o', `sides=${sides}`,
      '-o', `media=${cfg.media}`,
      '-o', `print-scaling=${cfg.scaling}`,
      '-o', 'collate=true',
      file,
    ]);
    const jobId = /request id is \S+-(\d+)/.exec(out)?.[1];
    if (!jobId) throw new Error(`CUPS 작업 번호를 못 받았습니다: ${out.trim()}`);
    const sideLabel = sides === 'one-sided' ? '단면' : sides.endsWith('short-edge') ? '양면·위로 넘김' : '양면·옆으로 넘김';
    log(`작업 ${jobId}: ${row.title} ${row.copies}부 ${sideLabel}`);
    await slack(`🖨 프린트 시작 — *${row.title}* · ${row.copies}부 · ${info.pages}쪽 · ${sideLabel} (면 ${faces}, 용지 약 ${sheetsPerCopy * row.copies}장)`);

    const result = await watchJob(jobId, row);
    if (result.ok) {
      await updateRow(row.id, { status: '완료' });
      await slack(`✅ 완료 — *${row.title}* · ${row.copies}부`);
    } else {
      throw new Error(result.error);
    }
  } catch (e) {
    log('오류:', row.title, e.message);
    await updateRow(row.id, { status: '오류', error: e.message }).catch((x) => log('노션 갱신 실패:', x.message));
    await slack(`❌ 실패 — *${row.title}*: ${e.message}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// CUPS 작업 상태를 5초마다 본다. ipp 백엔드는 프린터가 작업 완료를 보고할 때까지 작업을 붙잡고 있으므로
// job-state=completed(9) 가 실제 완료다. 그 사이 프린터 경고(용지·걸림·덮개·잉크)는 슬랙으로 알린다.
async function watchJob(jobId, row) {
  const queueUri = `ipp://localhost/printers/${cfg.cupsQueue}`;
  const deadline = Date.now() + cfg.jobTimeoutMinutes * 60000;
  let warned = '';
  while (Date.now() < deadline) {
    await sleep(cfg.statusSeconds * 1000);
    const j = await ipp(queueUri, 'get-job.test', { job_id: jobId });
    const state = j['job-state'];
    if (state === 'completed') return { ok: true };
    if (state === 'canceled' || state === 'aborted') {
      return { ok: false, error: `작업이 ${state === 'canceled' ? '취소' : '중단'}됨 (${j['job-printer-state-message'] || j['job-state-reasons'] || ''})` };
    }
    const problems = await printerProblems().catch(() => []);
    const now = problems.join(', ');
    if (now && now !== warned) await slack(`⚠️ ${now} — *${row.title}* 인쇄가 멈췄습니다. 해결하면 이어서 찍습니다.`);
    if (!now && warned) await slack(`🔄 문제 해결, 인쇄 재개 — *${row.title}*`);
    warned = now;
  }
  await run('cancel', [`${cfg.cupsQueue}-${jobId}`]).catch(() => {});
  return { ok: false, error: `${cfg.jobTimeoutMinutes}분 안에 끝나지 않아 취소했습니다` };
}

// ---------- 메인 루프 ----------
async function main() {
  log(`print-agent ${VERSION} 시작 — 큐 ${cfg.cupsQueue}, ${cfg.pollSeconds}초 폴링`);
  // 이전에 돌다 끊긴 작업은 다시 찍지 않고 오류로 남긴다(중복 인쇄 방지). 재시도는 상태를 '대기중'으로 되돌리면 된다.
  for (const p of await queryByStatus('인쇄중').catch(() => [])) {
    await updateRow(p.id, { status: '오류', error: '에이전트 재시작으로 중단됨 — 필요하면 상태를 대기중으로 되돌려 주세요' }).catch(() => {});
  }
  await slack(`🟢 print-agent 시작 (${os.hostname()}, ${VERSION})`);
  let lastErr = '';
  for (;;) {
    try {
      const rows = await queryByStatus('대기중');
      lastErr = '';
      for (const p of rows) await processRow(p);
    } catch (e) {
      log('폴링 오류:', e.message);
      if (e.message !== lastErr) await slack(`❌ print-agent 폴링 오류: ${e.message}`);
      lastErr = e.message;
    }
    await sleep(cfg.pollSeconds * 1000);
  }
}

let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    log('종료 신호', sig);
    process.exit(0);
  });
}

main().catch(async (e) => {
  log('치명적 오류:', e.message);
  await slack(`❌ print-agent 중단: ${e.message}`);
  process.exit(1);
});
