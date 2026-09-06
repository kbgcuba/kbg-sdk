#!/usr/bin/env node
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID, createHmac } from 'crypto';

const PORT = Number(process.env.PORT || 8787);
const SECRET = process.env.KBG_SDK_SECRET || '';
const jobs = new Map();
const liveCache = new Map();
let liveClient = null;
let liveClientKey = '';
let lastElsewhereAt = 0;
const watching = new Set();

function ticketOk(ticket) {
  if (!SECRET) return true;
  const parts = String(ticket || '').split('.');
  if (parts.length !== 2) return false;
  const ts = Number(parts[0]);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 180) return false;
  const expect = createHmac('sha256', SECRET).update(String(Math.floor(ts))).digest('hex');
  return parts[1] === expect;
}

function liveSnapshot() {
  const rows = [];
  for (const row of liveCache.values()) {
    const status = String(row.status || 'processing').toLowerCase();
    if (['completed', 'failed', 'canceled', 'cancelled'].includes(status)) continue;
    rows.push({
      id: row.id,
      status,
      percent: Math.max(0, Math.min(99, Math.round(Number(row.percent) || 0))),
      mode: row.mode || 't2v',
      startedAt: row.startedAt || Math.floor(Date.now() / 1000)
    });
  }
  return rows;
}

async function followWorkflow(client, id) {
  if (!id || watching.has(id) || !client || !client.workflows) return;
  watching.add(id);
  try {
    if (typeof client.workflows.streamEvents === 'function') {
      for await (const ev of client.workflows.streamEvents(id)) {
        const data = (ev && ev.data) || ev || {};
        const raw = data.progress ?? data.percent ?? data.progressPercent ?? ev.progress ?? ev.percent;
        const pct = asPct(raw);
        if (pct) rememberLive(id, { percent: pct, status: 'processing' });
        const name = String(ev.event || ev.type || data.type || data.event || '');
        if (/complet|fail|cancel/i.test(name)) {
          liveCache.delete(id);
          break;
        }
      }
    } else if (typeof client.workflows.events === 'function') {
      const evs = await client.workflows.events(id);
      (Array.isArray(evs) ? evs : []).forEach(function (ev) {
        const data = (ev && ev.data) || ev || {};
        const pct = asPct(data.progress ?? data.percent ?? data.progressPercent);
        if (pct) rememberLive(id, { percent: pct, status: 'processing' });
      });
    }
  } catch (e) {}
  watching.delete(id);
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-KBG-Secret'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!SECRET) return true;
  return req.headers['x-kbg-secret'] === SECRET;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Download failed ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return dest;
}

function asPct(n) {
  n = Number(n);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n <= 1) n = n * 100;
  return Math.max(0, Math.min(99, n));
}
function jobPercent(p) {
  if (!p) return 0;
  let best = 0;
  const take = function (n) { const v = asPct(n); if (v > best) best = v; };
  try { take(p.progress); } catch (e) {}
  take(p.percent);
  take(p.externalProgress);
  take(p.progressPercent);
  const jobsArr = p.jobs || [];
  for (const j of jobsArr) {
    if (!j) continue;
    try { take(j.progress); } catch (e) {}
    take(j.percent);
    take(j.externalProgress);
    take(j.progressPercent);
    if (j.stepCount) take((Number(j.step || 0) / Number(j.stepCount)) * 100);
  }
  try {
    const dump = JSON.stringify(p);
    const re = /"(?:external)?[Pp]rogress(?:Percent)?"\s*:\s*([0-9.]+)/g;
    let m;
    while ((m = re.exec(dump))) take(m[1]);
  } catch (e) {}
  return Math.round(best);
}

function modeFromModel(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('ref2') || m.includes('r2v')) return 'r2v';
  if (m.includes('i2v')) return 'i2v';
  if (m.includes('flf')) return 'flf2v';
  if (m.includes('t2v')) return 't2v';
  return 't2v';
}

function rememberLive(id, patch) {
  const prev = liveCache.get(id) || { id, percent: 0, status: 'processing', mode: 't2v', startedAt: Math.floor(Date.now()/1000) };
  const created = Number(patch && patch.startedAt) || 0;
  const startedAt = Math.min(prev.startedAt || Date.now()/1000, created || prev.startedAt || Math.floor(Date.now()/1000));
  const next = Object.assign({}, prev, patch, { id, startedAt: Math.floor(startedAt) });
  if (Number(next.percent) < Number(prev.percent || 0) && Number(next.percent) < 1) {
    next.percent = prev.percent;
  } else {
    next.percent = Math.max(Number(prev.percent || 0), Number(next.percent || 0));
  }
  liveCache.set(id, next);
}

function attachProject(p) {
  if (!p) return;
  const id = String(p.id || p.projectId || '');
  if (!id) return;
  const model = p.modelId || p.model || (p.params && p.params.modelId) || '';
  const jobsArr = [];
  try { Array.from(p.jobs || []).forEach(function (j) { jobsArr.push(j); }); } catch (e) {}
  const snap = {
    progress: p.progress,
    percent: p.percent,
    externalProgress: p.externalProgress,
    jobs: jobsArr.map(function (j) {
      return {
        progress: j && (j.progress ?? j.externalProgress),
        percent: j && j.percent,
        externalProgress: j && j.externalProgress,
        step: j && j.step,
        stepCount: j && j.stepCount
      };
    })
  };
  let created = 0;
  try {
    const raw = p.createdAt || p.startedAt || p.created || p.created_at;
    created = raw ? Math.floor(new Date(raw).getTime()/1000) : 0;
  } catch (e) {}
  rememberLive(id, {
    status: String(p.status || 'processing').toLowerCase(),
    percent: Math.max(jobPercent(p), jobPercent(snap)),
    mode: modeFromModel(model),
    startedAt: created || undefined
  });
  if (p._kbgLive) return;
  p._kbgLive = true;
  if (typeof p.on === 'function') {
    p.on('progress', (info) => {
      const raw = Number(info?.progress ?? info?.percent ?? info ?? 0);
      const pct = raw > 0 && raw <= 1 ? raw * 100 : raw;
      rememberLive(id, { percent: pct, status: 'processing' });
    });
    p.on('completed', () => liveCache.delete(id));
    p.on('failed', () => liveCache.delete(id));
  }
}

async function listLiveJobs(apiKey) {
  try {
    if (!liveClient || liveClientKey !== apiKey) {
      const { SogniClient } = await import('@sogni-ai/sogni-client');
      liveClient = await SogniClient.createInstance({
        appId: 'kbg-video-generator',
        appSource: 'kbg-video-generator',
        network: 'fast',
        apiKey
      });
      liveClientKey = apiKey;
      if (liveClient.projects && typeof liveClient.projects.on === 'function') {
        liveClient.projects.on('projectsSynced', (info) => {
          const extra = [].concat(info?.active || [], info?.recoveredActive || []);
          extra.forEach(attachProject);
        });
      }
    }
    try {
      if (liveClient.projects && typeof liveClient.projects.sync === 'function') {
        await liveClient.projects.sync();
      }
    } catch (e) {}
    const tracked = (liveClient.projects && liveClient.projects.trackedProjects) || [];
    tracked.forEach(attachProject);
    try {
      if (liveClient.projects && typeof liveClient.projects.listProjectsElsewhere === 'function') {
        const elsewhere = await liveClient.projects.listProjectsElsewhere();
        (elsewhere || []).forEach(attachProject);
      }
    } catch (e) {}
  } catch (e) {}
  for (const [id, job] of jobs) {
    if (!job || job.status === 'completed' || job.status === 'failed') {
      liveCache.delete(id);
      continue;
    }
    rememberLive(id, {
      status: job.status || 'processing',
      percent: Number(job.percent || 0),
      mode: 'r2v'
    });
  }
  const rows = [];
  for (const row of liveCache.values()) {
    const status = String(row.status || 'processing').toLowerCase();
    if (['completed', 'failed', 'canceled', 'cancelled'].includes(status)) continue;
    rows.push({
      id: row.id,
      status,
      percent: Math.max(0, Math.min(99, Math.round(Number(row.percent) || 0))),
      mode: row.mode || 't2v',
      startedAt: row.startedAt || Math.floor(Date.now()/1000)
    });
  }
  return rows;
}

async function runJob(id, input) {
  const job = jobs.get(id);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbg-r2v-'));
  try {
    const images = [];
    const videos = [];
    const audios = [];
    for (const [i, url] of (input.images || []).entries()) {
      images.push(await download(url, path.join(dir, 'img' + i)));
    }
    for (const [i, url] of (input.videos || []).entries()) {
      videos.push(await download(url, path.join(dir, 'vid' + i)));
    }
    for (const [i, url] of (input.audios || []).entries()) {
      audios.push(await download(url, path.join(dir, 'aud' + i)));
    }
    const { SogniClient } = await import('@sogni-ai/sogni-client');
    const sogni = await SogniClient.createInstance({
      appId: 'kbg-video-generator',
      network: 'fast',
      apiKey: input.apiKey
    });
    const params = {
      type: 'video',
      network: 'fast',
      modelId: 'minimax-h3-ref2va-fp8_r2v',
      positivePrompt: input.prompt,
      duration: Number(input.duration) || 5,
      width: Number(input.width) || 768,
      height: Number(input.height) || 1344,
      numberOfMedia: 1
    };
    if (images[0]) params.referenceImage = fs.readFileSync(images[0]);
    if (images.length > 1) params.contextImages = images.slice(1).map((p) => fs.readFileSync(p));
    if (videos[0]) params.referenceVideo = fs.readFileSync(videos[0]);
    if (videos.length > 1) params.referenceVideos = videos.slice(1).map((p) => fs.readFileSync(p));
    if (audios[0]) params.referenceAudio = fs.readFileSync(audios[0]);
    if (audios.length > 1) params.referenceAudios = audios.slice(1).map((p) => fs.readFileSync(p));
    job.status = 'processing';
    job.percent = 1;
    const project = await sogni.projects.create(params);
    job.projectId = project.id;
    if (project && typeof project.on === 'function') {
      project.on('progress', (info) => {
        const raw = Number(info?.progress ?? info?.percent ?? info ?? 0);
        const p = raw > 0 && raw <= 1 ? raw * 100 : raw;
        if (p > 1) {
          job.percent = Math.max(1, Math.min(95, p));
          rememberLive(id, { percent: job.percent, status: 'processing', mode: 'r2v' });
        }
      });
    }
    const urls = await project.waitForCompletion();
    const list = Array.isArray(urls) ? urls : (urls ? [urls] : []);
    job.status = 'completed';
    job.percent = 100;
    job.urls = list;
    job.video_url = list[0] || '';
  } catch (err) {
    job.status = 'failed';
    job.error = String(err && err.message ? err.message : err);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, version: '2.6.91.184' });
  }
  if (req.method === 'GET' && url.pathname === '/version') {
    return send(res, 200, { ok: true, version: '2.6.91.184' });
  }
  if (req.method === 'GET' && url.pathname === '/live/sse') {
    if (!ticketOk(url.searchParams.get('ticket') || '')) return send(res, 401, { error: 'Unauthorized' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    const push = function () {
      try {
        res.write('data: ' + JSON.stringify({ jobs: liveSnapshot(), workers: 0 }) + '\n\n');
      } catch (e) {}
    };
    push();
    const iv = setInterval(push, 1000);
    req.on('close', function () { clearInterval(iv); });
    return;
  }
  if (!authorized(req)) return send(res, 401, { error: 'Unauthorized' });
  if (req.method === 'POST' && url.pathname === '/live') {
    try {
      const input = await readBody(req);
      if (!input.apiKey) return send(res, 400, { error: 'apiKey required' });
      const list = await listLiveJobs(input.apiKey);
      const ids = Array.isArray(input.ids) ? input.ids : [];
      ids.slice(0, 8).forEach((id) => followWorkflow(liveClient, String(id || '')));
      let workers = 0;
      try {
        if (liveClient && liveClient.projects && typeof liveClient.projects.getAvailableModels === 'function') {
          const models = await liveClient.projects.getAvailableModels('fast');
          (models || []).forEach(function (m) {
            const media = String((m && m.media) || '').toLowerCase();
            if (media === 'video') workers += Number(m.workerCount || 0) || 0;
          });
        }
      } catch (e) {}
      return send(res, 200, { ok: true, jobs: list, workers: workers });
    } catch (err) {
      return send(res, 200, { ok: false, jobs: [], error: String(err.message || err) });
    }
  }
  if (req.method === 'POST' && url.pathname === '/r2v') {
    try {
      const input = await readBody(req);
      if (!input.apiKey || !input.prompt) return send(res, 400, { error: 'apiKey and prompt required' });
      const id = 'sdk-' + randomUUID();
      jobs.set(id, { status: 'queued', percent: 1 });
      runJob(id, input);
      return send(res, 200, { id, status: 'queued' });
    } catch (err) {
      return send(res, 400, { error: String(err.message || err) });
    }
  }
  const match = url.pathname.match(/^\/(?:r2v|job)\/(.+)$/);
  if (req.method === 'GET' && match) {
    const job = jobs.get(match[1]);
    if (!job) return send(res, 404, { error: 'Unknown job' });
    return send(res, 200, job);
  }
  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('KBG Sogni SDK server on ' + PORT);
});
