let currentFormat = 'mp3';
let currentItag = null;
let videoFormats = [];
let currentUrl = '';
let currentVideoId = '';

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
    currentVideoId = data.videoId;
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

  videoFormats.forEach((f, i) => {
    const btn = document.createElement('button');
    btn.className = 'quality-btn' + (i === 0 ? ' selected' : '');
    btn.textContent = f.quality;
    if (i === 0) currentItag = f.itag;

    btn.addEventListener('click', () => {
      document.querySelectorAll('.quality-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      currentItag = f.itag;
      document.getElementById('downloadBtnText').textContent = `Download MP4 (${f.quality})`;
    });
    container.appendChild(btn);
  });

  if (videoFormats.length > 0) {
    document.getElementById('downloadBtnText').textContent = `Download MP4 (${videoFormats[0].quality})`;
  }
}

// ── Download services (multiple fallbacks) ──
const DOWNLOAD_SERVICES = {
  mp3: [
    (id) => `https://cnvmp3.com/mp3/${id}`,
    (id) => `https://y2meta.tube/watch?v=${id}`,
    (id) => `https://ytmp3.cc/en/youtube-to-mp3/?url=https://www.youtube.com/watch?v=${id}`,
  ],
  mp4: [
    (id, q) => `https://y2meta.tube/watch?v=${id}`,
    (id, q) => `https://10downloader.com/download?v=https://www.youtube.com/watch?v=${id}`,
    (id, q) => `https://ssyoutube.com/watch?v=${id}`,
  ]
};

async function startDownload() {
  if (!currentVideoId) return;

  const progressArea = document.getElementById('progressArea');
  const progressFill = document.getElementById('progressFill');
  const progressPercent = document.getElementById('progressPercent');
  const progressText = document.getElementById('progressText');
  const progressSpeed = document.getElementById('progressSpeed');

  progressArea.classList.remove('hidden');
  progressFill.style.width = '100%';
  progressFill.style.background = '';
  progressPercent.textContent = '';
  progressText.textContent = 'Opening download page...';
  progressSpeed.textContent = 'A new tab will open with your download';

  const services = DOWNLOAD_SERVICES[currentFormat] || DOWNLOAD_SERVICES.mp4;
  const quality = currentItag || '720';
  const downloadUrl = services[0](currentVideoId, quality);

  // Open download service in new tab
  window.open(downloadUrl, '_blank');

  progressText.textContent = 'Download page opened!';
  progressSpeed.textContent = 'Complete the download in the new tab';

  setTimeout(resetProgress, 5000);
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
