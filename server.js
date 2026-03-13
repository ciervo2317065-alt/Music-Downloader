const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const ffmpegPath = require('ffmpeg-static');
const { execFile } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const jobs = new Map();

// ── Piped API (free YouTube proxy) ──
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.r4fo.com',
  'https://pipedapi.leptons.xyz',
];

function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function httpsGet(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0' }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpsGet(res.headers.location, timeout).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function downloadToFile(url, filePath) {
  return new Promise((resolve, reject) => {
    const follow = (downloadUrl) => {
      const client = https;
      const req = client.get(downloadUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          follow(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const totalSize = parseInt(res.headers['content-length']) || 0;
        const ws = fs.createWriteStream(filePath);
        let downloaded = 0;
        res.on('data', (chunk) => { downloaded += chunk.length; });
        res.pipe(ws);
        ws.on('finish', () => resolve({ totalSize, downloaded }));
        ws.on('error', reject);
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(300000, () => { req.destroy(); reject(new Error('Download timeout')); });
    };
    follow(url);
  });
}

async function getPipedStreams(videoId) {
  const errors = [];
  for (const instance of PIPED_INSTANCES) {
    try {
      const url = `${instance}/streams/${videoId}`;
      console.log(`Trying Piped: ${url}`);
      const res = await httpsGet(url, 15000);
      if (res.status === 200) {
        const info = JSON.parse(res.data);
        if (info.title) {
          console.log(`Piped success: ${instance}`);
          return info;
        }
      }
    } catch (err) {
      errors.push(`${instance}: ${err.message}`);
    }
  }
  throw new Error('All download servers are currently unavailable. Try again later.');
}

function sanitizeFilename(title) {
  return (title || 'video').replace(/[^\w\s\-().]/g, '').trim().substring(0, 100) || 'video';
}

function formatDuration(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Merge video + audio with ffmpeg
function mergeWithFfmpeg(videoPath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', videoPath,
      '-i', audioPath,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-y',
      outputPath
    ];
    execFile(ffmpegPath, args, { timeout: 300000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`FFmpeg failed: ${err.message}`));
      else resolve();
    });
  });
}

// Convert audio to MP3 with ffmpeg
function convertToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', inputPath,
      '-vn',
      '-ab', '192k',
      '-ar', '44100',
      '-y',
      outputPath
    ];
    execFile(ffmpegPath, args, { timeout: 300000 }, (err) => {
      if (err) reject(new Error(`FFmpeg failed: ${err.message}`));
      else resolve();
    });
  });
}

// Clean up old jobs
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

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

  try {
    const info = await getPipedStreams(videoId);

    // Get available video qualities from Piped streams
    const seen = new Set();
    const videoFormats = (info.videoStreams || [])
      .filter(s => s.videoOnly && s.format === 'MPEG_4')
      .map(s => ({ itag: s.quality, quality: s.quality, height: parseInt(s.quality) || 0 }))
      .filter(f => { if (seen.has(f.quality)) return false; seen.add(f.quality); return true; })
      .sort((a, b) => b.height - a.height)
      .slice(0, 5);

    // Fallback if no MPEG_4 formats found
    if (videoFormats.length === 0) {
      const webmFormats = (info.videoStreams || [])
        .filter(s => s.videoOnly)
        .map(s => ({ itag: s.quality, quality: s.quality, height: parseInt(s.quality) || 0 }))
        .filter(f => { if (seen.has(f.quality)) return false; seen.add(f.quality); return true; })
        .sort((a, b) => b.height - a.height)
        .slice(0, 5);
      videoFormats.push(...webmFormats);
    }

    res.json({
      title: info.title,
      duration: formatDuration(info.duration),
      thumbnail: info.thumbnailUrl,
      author: info.uploader,
      videoFormats
    });
  } catch (err) {
    console.error('Info error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/download/start ──
app.post('/api/download/start', async (req, res) => {
  const { url, format, itag } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

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

  (async () => {
    try {
      const info = await getPipedStreams(videoId);
      const title = sanitizeFilename(info.title);

      if (format === 'mp3') {
        job.filename = `${title}.mp3`;
        job.contentType = 'audio/mpeg';

        // Find best audio stream
        const audioStream = (info.audioStreams || [])
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
        if (!audioStream) throw new Error('No audio stream found');

        job.stage = 'Downloading audio...';
        job.status = 'downloading';
        job.percent = 15;

        const audioTmp = path.join(tmpDir, 'audio_raw');
        await downloadToFile(audioStream.url, audioTmp);

        job.stage = 'Converting to MP3...';
        job.status = 'converting';
        job.percent = 75;

        const mp3Path = path.join(tmpDir, 'output.mp3');
        await convertToMp3(audioTmp, mp3Path);

        job.filePath = mp3Path;

      } else {
        job.filename = `${title}.mp4`;
        job.contentType = 'video/mp4';

        // Find video stream matching requested quality
        const targetQuality = itag || '720p';
        let videoStream = (info.videoStreams || [])
          .filter(s => s.videoOnly)
          .find(s => s.quality === targetQuality);
        // Fallback to best available
        if (!videoStream) {
          videoStream = (info.videoStreams || [])
            .filter(s => s.videoOnly)
            .sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0))[0];
        }
        if (!videoStream) throw new Error('No video stream found');

        // Best audio stream
        const audioStream = (info.audioStreams || [])
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
        if (!audioStream) throw new Error('No audio stream found');

        // Download video
        job.stage = 'Downloading video...';
        job.status = 'downloading';
        job.percent = 10;

        const videoTmp = path.join(tmpDir, 'video_raw');
        await downloadToFile(videoStream.url, videoTmp);
        job.percent = 45;

        // Download audio
        job.stage = 'Downloading audio...';
        const audioTmp = path.join(tmpDir, 'audio_raw');
        await downloadToFile(audioStream.url, audioTmp);
        job.percent = 70;

        // Merge
        job.stage = 'Merging video & audio...';
        job.status = 'converting';
        job.percent = 85;

        const mp4Path = path.join(tmpDir, 'output.mp4');
        await mergeWithFfmpeg(videoTmp, audioTmp, mp4Path);

        job.filePath = mp4Path;
      }

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
