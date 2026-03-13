const express = require('express');
const cors = require('cors');
const YTDlpWrap = require('yt-dlp-wrap').default;
const ffmpegPath = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// yt-dlp binary path
const BIN_DIR = path.join(__dirname, 'bin');
const BIN_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
let ytDlp;

// Job tracking for progress
const jobs = new Map();

async function initYtDlp() {
  if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
  if (!fs.existsSync(BIN_PATH)) {
    console.log('Downloading yt-dlp binary (one-time setup)...');
    await YTDlpWrap.downloadFromGithub(BIN_PATH);
    console.log('yt-dlp downloaded!');
  } else {
    console.log('yt-dlp binary found.');
  }
  ytDlp = new YTDlpWrap(BIN_PATH);

  // Test yt-dlp works
  try {
    const version = await ytDlp.execPromise(['--version'], SPAWN_OPTS);
    console.log('yt-dlp version:', version.trim());
    console.log('Node.js path:', process.execPath);
    console.log('ffmpeg path:', ffmpegPath);
  } catch (e) {
    console.error('yt-dlp test failed:', e.message);
  }

  // Write YouTube cookies from env variable (if set)
  if (process.env.YOUTUBE_COOKIES) {
    const cookiePath = path.join(__dirname, 'cookies.txt');
    try {
      const decoded = Buffer.from(process.env.YOUTUBE_COOKIES, 'base64').toString('utf-8');
      fs.writeFileSync(cookiePath, decoded);
      console.log('YouTube cookies loaded from environment variable.');
    } catch (e) {
      console.error('Failed to write cookies:', e.message);
    }
  }
}

// Path to cookies file (if it exists)
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

// Spawn options — ensure yt-dlp can find Node.js for JS challenge solving
const nodeDir = path.dirname(process.execPath);
const spawnEnv = { ...process.env, PATH: `${nodeDir}:${process.env.PATH || ''}` };
const SPAWN_OPTS = { env: spawnEnv };

// Common yt-dlp flags to bypass cloud IP restrictions
function getBaseArgs() {
  const args = [
    '--no-playlist',
    '--no-check-certificates',
    '--no-warnings',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    '--extractor-args', 'youtube:player_client=web_creator,mweb',
    '--sleep-requests', '1',
  ];
  if (fs.existsSync(COOKIES_PATH)) {
    args.push('--cookies', COOKIES_PATH);
  }
  return args;
}

function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
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
    const info = JSON.parse(await ytDlp.execPromise([url, ...getBaseArgs(), '--dump-json'], SPAWN_OPTS));
    const seen = new Set();
    const videoFormats = (info.formats || [])
      .filter(f => f.vcodec && f.vcodec !== 'none' && f.height)
      .map(f => ({ itag: f.format_id, quality: `${f.height}p`, height: f.height }))
      .filter(f => { if (seen.has(f.quality)) return false; seen.add(f.quality); return true; })
      .sort((a, b) => b.height - a.height)
      .slice(0, 5);

    res.json({
      title: info.title,
      duration: formatDuration(info.duration),
      thumbnail: info.thumbnail,
      author: info.uploader || info.channel,
      videoFormats
    });
  } catch (err) {
    console.error('Info error:', err.message, err.stderr || '');
    res.status(500).json({ error: 'Could not fetch video info: ' + (err.message || 'Unknown error') });
  }
});

// ── POST /api/download/start ──
// Starts a download job, returns jobId for progress tracking
app.post('/api/download/start', async (req, res) => {
  const { url, format, itag } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const jobId = crypto.randomBytes(8).toString('hex');
  const tmpDir = path.join(os.tmpdir(), `ytconv_${jobId}`);
  const tmpTemplate = path.join(tmpDir, 'output.%(ext)s');

  fs.mkdirSync(tmpDir, { recursive: true });

  const job = {
    id: jobId,
    status: 'starting',      // starting | downloading | converting | done | error
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
      const info = JSON.parse(await ytDlp.execPromise([url, ...getBaseArgs(), '--dump-json'], SPAWN_OPTS));
      const title = sanitizeFilename(info.title);

      let args;
      if (format === 'mp3') {
        job.filename = `${title}.mp3`;
        job.contentType = 'audio/mpeg';
        args = [
          url, ...getBaseArgs(),
          '-x', '--audio-format', 'mp3', '--audio-quality', '192K',
          '--ffmpeg-location', ffmpegPath,
          '--newline',
          '-o', tmpTemplate
        ];
      } else {
        job.filename = `${title}.mp4`;
        job.contentType = 'video/mp4';
        const fmt = itag
          ? `${itag}+bestaudio/bestvideo+bestaudio/best`
          : 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best';
        args = [
          url, ...getBaseArgs(),
          '-f', fmt,
          '--merge-output-format', 'mp4',
          '--postprocessor-args', 'Merger+ffmpeg:-c:v copy -c:a aac -b:a 192k',
          '--ffmpeg-location', ffmpegPath,
          '--newline',
          '-o', tmpTemplate
        ];
      }

      job.status = 'downloading';
      job.stage = 'Downloading...';

      // Use exec to track progress events
      const proc = ytDlp.exec(args, SPAWN_OPTS);

      proc.on('ytDlpEvent', (type, data) => {
        if (type === 'download') {
          const percentMatch = data.match(/([\d.]+)%/);
          if (percentMatch) {
            job.percent = Math.min(parseFloat(percentMatch[1]), 100);
          }
          const speedMatch = data.match(/at\s+([\d.]+\S+)/);
          if (speedMatch) job.speed = speedMatch[1];
          const etaMatch = data.match(/ETA\s+(\S+)/);
          if (etaMatch) job.eta = etaMatch[1];
          job.status = 'downloading';
          job.stage = 'Downloading...';
        }
        if (type === 'Merger' || type === 'ExtractAudio' || type === 'ffmpeg') {
          job.status = 'converting';
          job.stage = format === 'mp3' ? 'Converting to MP3...' : 'Merging video & audio...';
          job.percent = 99;
        }
      });

      await new Promise((resolve, reject) => {
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`yt-dlp exited with code ${code}`));
        });
        proc.on('error', reject);
      });

      // Find the output file
      const files = fs.readdirSync(tmpDir);
      const ext = format === 'mp3' ? '.mp3' : '.mp4';
      const outputFile = files.find(f => f.endsWith(ext)) || files[0];
      if (!outputFile) throw new Error('No output file produced');

      job.filePath = path.join(tmpDir, outputFile);
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

// ── GET /api/download/file/:jobId ── (serve the completed file)
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
initYtDlp()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n🎬 YouTube Converter running at http://localhost:${PORT}\n`);
    });
  })
  .catch(err => { console.error('Failed to initialize:', err); process.exit(1); });
