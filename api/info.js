const https = require('https');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0' }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject);
  });
}

function extractVideoId(url) {
  const m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

  try {
    // Use YouTube oEmbed API (public, works everywhere)
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const result = await httpsGet(oembedUrl);

    if (result.status !== 200) throw new Error('Video not found');
    const info = JSON.parse(result.data);

    res.json({
      title: info.title,
      thumbnail: info.thumbnail_url,
      author: info.author_name,
      videoId,
      duration: '',
      videoFormats: [
        { itag: '1080', quality: '1080p', height: 1080 },
        { itag: '720', quality: '720p', height: 720 },
        { itag: '480', quality: '480p', height: 480 },
        { itag: '360', quality: '360p', height: 360 },
      ]
    });
  } catch (err) {
    console.error('Info error:', err.message);
    res.status(500).json({ error: 'Could not fetch video info.' });
  }
};
