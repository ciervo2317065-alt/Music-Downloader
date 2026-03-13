let currentFormat = 'mp3';
let currentItag = null;
let videoFormats = [];
let currentUrl = '';

// ── Fetch video info ──
async function fetchInfo() {
  const urlInput = document.getElementById('urlInput');
  const url = urlInput.value.trim();
  const errorEl = document.getElementById('inputError');
  const fetchBtn = document.getElementById('fetchBtn');
  const btnText = fetchBtn.querySelector('.btn-text');
  const btnSpinner = fetchBtn.querySelector('.btn-spinner');

  errorEl.classList.add('hidden');

  if (!url) { showError('Please paste a YouTube URL first.'); return; }
  if (!url.includes('youtube.com/') && !url.includes('youtu.be/')) {
    showError("Looks like that's not a YouTube URL. Try again!");
    return;
  }

  btnText.classList.add('hidden');
  btnSpinner.classList.remove('hidden');
  fetchBtn.disabled = true;
  document.getElementById('previewCard').classList.add('hidden');

  try {
    const res = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to fetch video info');

    currentUrl = url;
    videoFormats = data.videoFormats || [];

    document.getElementById('thumbnail').src = data.thumbnail || '';
    document.getElementById('duration').textContent = data.duration || '';
    document.getElementById('author').textContent = data.author || '';
    document.getElementById('videoTitle').textContent = data.title || '';

    selectFormat('mp3');
    document.getElementById('previewCard').classList.remove('hidden');

  } catch (err) {
    showError(err.message);
  } finally {
    btnText.classList.remove('hidden');
    btnSpinner.classList.add('hidden');
    fetchBtn.disabled = false;
  }
}

function showError(msg) {
  const el = document.getElementById('inputError');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ── Format selection ──
function selectFormat(format) {
  currentFormat = format;
  document.getElementById('tab-mp3').classList.toggle('active', format === 'mp3');
  document.getElementById('tab-mp4').classList.toggle('active', format === 'mp4');

  const qualitySection = document.getElementById('qualitySection');
  const downloadBtnText = document.getElementById('downloadBtnText');

  if (format === 'mp4') {
    qualitySection.classList.remove('hidden');
    renderQualityBtns();
    downloadBtnText.textContent = 'Download MP4';
  } else {
    qualitySection.classList.add('hidden');
    currentItag = null;
    downloadBtnText.textContent = 'Download MP3';
  }
  resetProgress();
}

function renderQualityBtns() {
  const container = document.getElementById('qualityBtns');
  container.innerHTML = '';

  if (!videoFormats.length) {
    container.innerHTML = '<span style="font-size:0.8rem;color:#64748b">No qualities found</span>';
    return;
  }

  videoFormats.forEach((f, i) => {
    const btn = document.createElement('button');
    btn.className = 'quality-btn' + (i === 0 ? ' selected' : '');
    btn.textContent = f.quality || `Format ${f.itag}`;
    btn.dataset.itag = f.itag;
    if (i === 0) currentItag = f.itag;

    btn.addEventListener('click', () => {
      document.querySelectorAll('.quality-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      currentItag = parseInt(f.itag);
      document.getElementById('downloadBtnText').textContent = `Download MP4 (${f.quality})`;
    });
    container.appendChild(btn);
  });

  if (videoFormats.length > 0) {
    document.getElementById('downloadBtnText').textContent = `Download MP4 (${videoFormats[0].quality})`;
  }
}

// ── Download with real progress ──
async function startDownload() {
  if (!currentUrl) return;

  const downloadBtn = document.getElementById('downloadBtn');
  const progressArea = document.getElementById('progressArea');
  const progressFill = document.getElementById('progressFill');
  const progressPercent = document.getElementById('progressPercent');
  const progressText = document.getElementById('progressText');
  const progressSpeed = document.getElementById('progressSpeed');

  downloadBtn.disabled = true;
  progressArea.classList.remove('hidden');
  progressFill.style.width = '0%';
  progressFill.style.background = '';
  progressPercent.textContent = '0%';
  progressText.textContent = 'Starting...';
  progressSpeed.textContent = '';

  try {
    // 1. Start the download job
    const startRes = await fetch('/api/download/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: currentUrl,
        format: currentFormat,
        itag: currentItag
      })
    });
    const { jobId } = await startRes.json();
    if (!startRes.ok) throw new Error('Failed to start download');

    // 2. Listen to SSE for progress
    const done = await new Promise((resolve, reject) => {
      const evtSource = new EventSource(`/api/download/progress/${jobId}`);

      evtSource.onmessage = (event) => {
        const data = JSON.parse(event.data);

        // Update progress bar
        progressFill.style.width = `${data.percent}%`;
        progressPercent.textContent = `${Math.round(data.percent)}%`;
        progressText.textContent = data.stage;

        // Show speed & ETA
        let speedInfo = '';
        if (data.speed) speedInfo += `${data.speed}/s`;
        if (data.eta && data.eta !== 'Unknown') speedInfo += ` • ETA ${data.eta}`;
        progressSpeed.textContent = speedInfo;

        if (data.status === 'done') {
          evtSource.close();
          resolve(jobId);
        }
        if (data.status === 'error') {
          evtSource.close();
          reject(new Error(data.error || 'Download failed'));
        }
      };

      evtSource.onerror = () => {
        evtSource.close();
        reject(new Error('Connection lost'));
      };
    });

    // 3. Trigger file download
    progressText.textContent = 'Saving file...';
    const a = document.createElement('a');
    a.href = `/api/download/file/${done}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    progressFill.style.width = '100%';
    progressPercent.textContent = '100%';
    progressText.textContent = 'Download complete!';
    progressSpeed.textContent = '';

    setTimeout(resetProgress, 4000);

  } catch (err) {
    progressFill.style.background = 'linear-gradient(90deg, #ef4444, #dc2626)';
    progressFill.style.width = '100%';
    progressPercent.textContent = '';
    progressText.textContent = `Error: ${err.message}`;
    progressSpeed.textContent = '';
    setTimeout(resetProgress, 5000);
  } finally {
    downloadBtn.disabled = false;
  }
}

function resetProgress() {
  const progressArea = document.getElementById('progressArea');
  const progressFill = document.getElementById('progressFill');
  progressArea.classList.add('hidden');
  progressFill.style.width = '0%';
  progressFill.style.background = '';
}

// ── Enter key on input ──
document.getElementById('urlInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') fetchInfo();
});

// ── Auto-fetch on paste ──
document.getElementById('urlInput').addEventListener('paste', () => {
  setTimeout(() => {
    const val = document.getElementById('urlInput').value.trim();
    if (val.includes('youtube.com/') || val.includes('youtu.be/')) fetchInfo();
  }, 50);
});
