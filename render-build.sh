#!/usr/bin/env bash
set -e

# Install dependencies
npm install

# Download latest yt-dlp binary
mkdir -p bin
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o bin/yt-dlp
chmod +x bin/yt-dlp

echo "yt-dlp version:"
./bin/yt-dlp --version
