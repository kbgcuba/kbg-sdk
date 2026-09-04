#!/usr/bin/env node
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

const PORT = Number(process.env.PORT || 8787);
const SECRET = process.env.KBG_SDK_SECRET || '';
const jobs = new Map();

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
    job.percent = 12;
    const project = await sogni.projects.create(params);
    job.projectId = project.id;
    if (project && typeof project.on === 'function') {
      project.on('progress', (info) => {
        const p = Number(info?.progress ?? info?.percent ?? 0);
        job.percent = Math.max(12, Math.min(95, p));
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
    return send(res, 200, { ok: true, version: '2.6.91.154' });
  }
  if (req.method === 'GET' && url.pathname === '/version') {
    return send(res, 200, { ok: true, version: '2.6.91.154' });
  }
  if (!authorized(req)) return send(res, 401, { error: 'Unauthorized' });
  if (req.method === 'POST' && url.pathname === '/r2v') {
    try {
      const input = await readBody(req);
      if (!input.apiKey || !input.prompt) return send(res, 400, { error: 'apiKey and prompt required' });
      const id = 'sdk-' + randomUUID();
      jobs.set(id, { status: 'queued', percent: 5 });
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
