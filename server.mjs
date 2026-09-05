#!/usr/bin/env node
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

const PORT = Number(process.env.PORT || 8787);
const SECRET = process.env.KBG_SDK_SECRET || '';
const jobs = new Map();
const liveCache = new Map();
let liveClient = null;
let liveClientKey = '';
let lastElsewhereAt = 0;

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

function jobPercent(p) {
  let pct = Number(p && (p.progress ?? p.percent ?? 0));
  if (!Number.isFinite(pct)) pct = 0;
  if (pct > 0 && pct <= 1) pct = pct * 100;
  const jobsArr = (p && p.jobs) || [];
  if (!pct && jobsArr[0]) {
    const j = jobsArr[0];
    const jp = Number(j.progress ?? j.externalProgress ?? 0);
    if (jp > 0) pct = jp > 1 ? jp : jp * 100;
    else if (j.stepCount) pct = (Number(j.step || 0) / Number(j.stepCount)) * 100;
  }
  return Math.max(0, Math.min(99, Math.round(pct)));
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
  const next = Object.assign({}, prev, patch, { id, startedAt: prev.startedAt || Math.floor(Date.now()/1000) });
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
  rememberLive(id, {
    status: String(p.status || 'processing').toLowerCase(),
    percent: jobPercent(p),
    mode: modeFromModel(model)
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
    if (Date.now() - lastElsewhereAt > 15000) {
      lastElsewhereAt = Date.now();
      try {
        if (liveClient.projects && typeof liveClient.projects.listProjectsElsewhere === 'function') {
          const elsewhere = await liveClient.projects.listProjectsElsewhere();
          (elsewhere || []).forEach(attachProject);
        }
      } catch (e) {}
    }
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
    return send(res, 200, { ok: true, version: '2.6.91.158' });
  }
  if (req.method === 'GET' && url.pathname === '/version') {
    return send(res, 200, { ok: true, version: '2.6.91.158' });
  }
  if (!authorized(req)) return send(res, 401, { error: 'Unauthorized' });
  if (req.method === 'POST' && url.pathname === '/live') {
    try {
      const input = await readBody(req);
      if (!input.apiKey) return send(res, 400, { error: 'apiKey required' });
      const list = await listLiveJobs(input.apiKey);
      return send(res, 200, { ok: true, jobs: list });
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
