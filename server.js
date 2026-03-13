const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Job tracking for progress
const jobs = new Map();

// ── Cobalt API helper ──
const COBALT_API = 'https://api.cobalt.tools';

function cobaltRequest(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(COBALT_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        try { resolve(JSON.parse(chunks)); }
        catch { reject(new Error('Invalid response from download service')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(data);
    req.end();
  });
}

// Download a URL and pipe/save to destination
function downloadUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadUrl(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed with status ${res.statusCode}`));
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Download timeout')); });
  });
}

// ── YouTube oEmbed for video info ──
function getVideoInfo(url) {
  return new Promise((resolve, reject) => {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    https.get(oembedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error('Video not found');
          resolve(JSON.parse(data));
        } catch { reject(new Error('Could not fetch video info')); }
      });
    }).on('error', reject);
  });
}

function sanitizeFilename(title) {
  return (title || 'video').replace(/[^\w\s\-().]/g, '').trim().substring(0, 100) || 'video';
}

// Clean up old jobs after 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.created > 10 * 60 * 1000) {
      if (job.tmpDir) fs.rm(job.tmpDir, { recursive: true, force: true }, () => {});
      jobs.delete(id);
    }
  }
}, 60000);

// ── GET /api/info?url=... ──
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    const info = await getVideoInfo(url);

    // Standard quality options for YouTube
    const videoFormats = [
      { itag: '1080', quality: '1080p', height: 1080 },
      { itag: '720', quality: '720p', height: 720 },
      { itag: '480', quality: '480p', height: 480 },
      { itag: '360', quality: '360p', height: 360 },
    ];

    res.json({
      title: info.title,
      duration: '',
      thumbnail: info.thumbnail_url,
      author: info.author_name,
      videoFormats
    });
  } catch (err) {
    console.error('Info error:', err.message);
    res.status(500).json({ error: 'Could not fetch video info. Check the URL and try again.' });
  }
});

// ── POST /api/download/start ──
app.post('/api/download/start', async (req, res) => {
  const { url, format, itag } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const jobId = crypto.randomBytes(8).toString('hex');
  const tmpDir = path.join(os.tmpdir(), `ytconv_${jobId}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const job = {
    id: jobId,
    status: 'starting',
    percent: 0,
    speed: '',
    eta: '',
    stage: 'Fetching video info...',
    tmpDir,
    filePath: null,
    filename: null,
    contentType: null,
    error: null,
    created: Date.now()
  };
  jobs.set(jobId, job);
  res.json({ jobId });

  // Run download in background
  (async () => {
    try {
      // Get video title
      const info = await getVideoInfo(url);
      const title = sanitizeFilename(info.title);

      job.stage = 'Requesting download...';
      job.percent = 10;

      // Request download from Cobalt API
      const cobaltBody = { url };
      if (format === 'mp3') {
        cobaltBody.downloadMode = 'audio';
        cobaltBody.audioFormat = 'mp3';
        job.filename = `${title}.mp3`;
        job.contentType = 'audio/mpeg';
      } else {
        cobaltBody.downloadMode = 'auto';
        cobaltBody.videoQuality = itag || '720';
        job.filename = `${title}.mp4`;
        job.contentType = 'video/mp4';
      }

      const cobaltRes = await cobaltRequest(cobaltBody);
      console.log('Cobalt response:', JSON.stringify(cobaltRes));

      if (cobaltRes.status === 'error') {
        throw new Error(cobaltRes.error?.code || cobaltRes.text || 'Download service error');
      }

      const downloadLink = cobaltRes.url;
      if (!downloadLink) throw new Error('No download URL received');

      // Download the file
      job.stage = 'Downloading...';
      job.percent = 25;
      job.status = 'downloading';

      const ext = format === 'mp3' ? '.mp3' : '.mp4';
      const filePath = path.join(tmpDir, `output${ext}`);
      const writeStream = fs.createWriteStream(filePath);

      const stream = await downloadUrl(downloadLink);
      const totalSize = parseInt(stream.headers['content-length']) || 0;
      let downloaded = 0;

      stream.on('data', (chunk) => {
        downloaded += chunk.length;
        if (totalSize > 0) {
          job.percent = 25 + Math.round((downloaded / totalSize) * 70);
          const mbDown = (downloaded / 1024 / 1024).toFixed(1);
          const mbTotal = (totalSize / 1024 / 1024).toFixed(1);
          job.speed = `${mbDown}/${mbTotal} MB`;
        } else {
          const mbDown = (downloaded / 1024 / 1024).toFixed(1);
          job.speed = `${mbDown} MB`;
          job.percent = Math.min(90, 25 + Math.round(downloaded / 100000));
        }
      });

      stream.pipe(writeStream);

      await new Promise((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        stream.on('error', reject);
      });

      job.filePath = filePath;
      job.status = 'done';
      job.percent = 100;
      job.stage = 'Ready to download!';

    } catch (err) {
      console.error(`Job ${jobId} error:`, err.message);
      job.status = 'error';
      job.error = err.message;
      job.stage = 'Download failed';
    }
  })();
});

// ── GET /api/download/progress/:jobId ── (SSE)
app.get('/api/download/progress/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const interval = setInterval(() => {
    const data = JSON.stringify({
      status: job.status,
      percent: Math.round(job.percent * 10) / 10,
      speed: job.speed,
      eta: job.eta,
      stage: job.stage,
      error: job.error
    });
    res.write(`data: ${data}\n\n`);

    if (job.status === 'done' || job.status === 'error') {
      clearInterval(interval);
      res.end();
    }
  }, 300);

  req.on('close', () => clearInterval(interval));
});

// ── GET /api/download/file/:jobId ──
app.get('/api/download/file/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'done') return res.status(400).json({ error: 'File not ready' });

  const stat = fs.statSync(job.filePath);
  res.setHeader('Content-Disposition', `attachment; filename="${job.filename}"`);
  res.setHeader('Content-Type', job.contentType);
  res.setHeader('Content-Length', stat.size);

  const fileStream = fs.createReadStream(job.filePath);
  fileStream.pipe(res);

  const cleanup = () => {
    if (job.tmpDir) fs.rm(job.tmpDir, { recursive: true, force: true }, () => {});
    jobs.delete(job.id);
  };
  fileStream.on('end', cleanup);
  fileStream.on('error', () => { cleanup(); if (!res.headersSent) res.status(500).end(); });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🎬 YouTube Converter running at http://localhost:${PORT}\n`);
});
