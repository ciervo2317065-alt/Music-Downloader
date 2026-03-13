#!/usr/bin/env bash
# Install dependencies
npm install

# Download yt-dlp binary
mkdir -p bin
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o bin/yt-dlp
chmod +x bin/yt-dlp
