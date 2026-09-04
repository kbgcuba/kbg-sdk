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

async function runImageJob(id, input) {
  const job = jobs.get(id);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbg-img-'));
  try {
    const images = [];
    for (const [i, url] of (input.images || []).entries()) {
      images.push(await download(url, path.join(dir, 'img' + i)));
    }
    const { SogniClient } = await import('@sogni-ai/sogni-client');
    const sogni = await SogniClient.createInstance({
      appId: 'kbg-video-generator',
      network: 'fast',
      apiKey: input.apiKey
    });
    const family = String(input.family || 'beast');
    const isDream = family === 'dream';
    const isBeast = family !== 'dream' && family !== 'epic';
    const looks = {
      photo: { style: 'photorealistic, highly detailed, natural skin, real-world lighting', pony: 'source_photo, realistic', neg: 'illustration, cartoon, anime, 3d render' },
      cinematic: { style: 'cinematic film still, shallow depth of field, anamorphic, movie lighting, film grain', pony: 'source_photo, cinematic', neg: 'snapshot, overexposed flash' },
      analog: { style: 'analog film photo, 35mm, faded film, Kodachrome, grainy, vignette, found footage', pony: 'source_photo, analog film', neg: 'digital sharp, HDR' },
      editorial: { style: 'editorial fashion photography, studio lighting, magazine cover, sharp wardrobe', pony: 'source_photo, editorial', neg: 'candid snapshot' },
      anime: { style: 'anime artwork, studio anime, key visual, vibrant, clean lineart', pony: 'source_anime', neg: 'photoreal, photo, 3d' },
      cartoon: { style: 'cartoon illustration, bold shapes, clean colors, stylized characters', pony: 'source_cartoon', neg: 'photoreal, photo' },
      digital: { style: 'digital concept art, artstation, highly detailed illustration', pony: 'source_anime, concept art', neg: 'photo, snapshot' },
      fantasy: { style: 'fantasy painting, painterly, epic lighting, illustrated', pony: 'source_anime, fantasy art', neg: 'photo, snapshot' },
      render: { style: 'professional 3d render, octane, subsurface scattering, studio product lighting', pony: '3d render', neg: 'photo grain, sketch' },
      comic: { style: 'comic book panel, inked lines, flat colors, graphic novel', pony: 'source_cartoon, comic', neg: 'photo, photoreal' }
    };
    const look = looks[String(input.look || 'photo')] || looks.photo;
    let prompt = String(input.prompt || '');
    if (isDream) prompt = 'score_9, score_8_up, score_7_up, ' + look.pony + ', ' + prompt;
    const loraLooks = {
      photo:      { ids: ['krea2-filter-bypass-2','krea2-realism','krea2-detail-enhancer'], w: [1, 1, 1] },
      cinematic:  { ids: ['krea2-filter-bypass-2','krea2-realism','krea2-amateur'], w: [1, 0.8, -1.5] },
      analog:     { ids: ['krea2-filter-bypass-2','krea2-realism','krea2-amateur'], w: [1, 0.5, 1.5] },
      editorial:  { ids: ['krea2-filter-bypass-2','krea2-realism','krea2-candid'], w: [1, 1, -3] },
      anime:      { ids: ['krea2-filter-bypass-2','krea2-realism'], w: [1, -1] },
      cartoon:    { ids: ['krea2-filter-bypass-2','krea2-realism'], w: [1, -1] },
      digital:    { ids: ['krea2-filter-bypass-2','krea2-realism'], w: [1, -0.5] },
      fantasy:    { ids: ['krea2-filter-bypass-2','krea2-realism'], w: [1, -0.8] },
      render:     { ids: ['krea2-filter-bypass-2','krea2-realism','krea2-detail-enhancer'], w: [1, 0.3, 1] },
      comic:      { ids: ['krea2-filter-bypass-2','krea2-realism'], w: [1, -1] }
    };
    const pack = loraLooks[String(input.look || 'photo')] || loraLooks.photo;
    const params = {
      type: 'image',
      network: 'fast',
      modelId: isDream ? 'coreml-realDream_sdxlPony11' : (isBeast ? 'dark_beast_krea2_fp8' : 'coreml-epicrealismXL_vxiiAbea2t'),
      positivePrompt: prompt,
      stylePrompt: look.style,
      numberOfMedia: 1,
      width: Number(input.width) || 1024,
      height: Number(input.height) || 1024,
      steps: isBeast ? 20 : 40,
      guidance: isDream ? 6 : 4.5,
      sampler: 'dpmpp_2m',
      scheduler: 'simple',
      outputFormat: 'jpg',
      disableNSFWFilter: true
    };
    if (isBeast) {
      params.loras = pack.ids;
      params.loraStrengths = pack.w;
      params.guidance = 1;
    }
    if (isDream) {
      params.negativePrompt = look.neg + ', malformation, bad anatomy, bad hands, missing fingers, watermark, text, jpeg artifacts';
    } else if (!isBeast) {
      params.negativePrompt = 'malformation, bad anatomy, watermark';
    }
    if (images[0]) params.startingImage = fs.readFileSync(images[0]);
    if (images.length >= 1 && isBeast) {
      params.modelId = 'dark_beast_krea2_identity_edit_v1_2';
      params.steps = 10;
      params.steps = 20;
      params.contextImages = images.slice(0, 2).map((p) => fs.readFileSync(p));
      delete params.sampler;
      delete params.negativePrompt;
    } else if (images.length >= 2 && !isBeast) {
      params.modelId = isDream ? 'coreml-realDream_sdxlPony11' : 'coreml-epicrealismXL_vxiiAbea2t';
      params.startingImage = fs.readFileSync(images[0]);
    }
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
    job.image_url = list[0] || '';
    job.kind = 'image';
  } catch (err) {
    job.status = 'failed';
    job.error = String(err && err.message ? err.message : err);
  }
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
    return send(res, 200, { ok: true });
  }
  if (!authorized(req)) return send(res, 401, { error: 'Unauthorized' });
  if (req.method === 'POST' && url.pathname === '/image') {
    try {
      const input = await readBody(req);
      if (!input.apiKey || !input.prompt) return send(res, 400, { error: 'apiKey and prompt required' });
      const id = 'sdk-' + randomUUID();
      jobs.set(id, { status: 'queued', percent: 5, kind: 'image' });
      runImageJob(id, input);
      return send(res, 200, { id, status: 'queued', kind: 'image' });
    } catch (err) {
      return send(res, 400, { error: String(err.message || err) });
    }
  }
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
  const match = url.pathname.match(/^\/(?:r2v|image|job)\/(.+)$/);
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
