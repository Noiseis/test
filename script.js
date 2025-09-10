// --- MODULE IMPORTS ---
// We now import the libraries directly. This is the modern, reliable way.
import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v0.25.1/full/pyodide.mjs";
import { FFmpeg } from "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/ffmpeg.js";

// --- GLOBAL VARIABLES ---
let pyodide = null;
let ffmpeg = null;
let previewLibrary = [];
let currentVideoData = {};
let selectedFormatId = null;
let currentlyPlayingAudio = null;
let toastTimeout;

// --- DOM ELEMENTS ---
const urlInput = document.getElementById('urlInput');
const extractButton = document.querySelector('.input-container button');
const detailsContainer = document.getElementById('detailsContainer');
const skeletonLoader = document.getElementById('skeletonLoader');
const detailsContent = document.getElementById('detailsContent');
const downloadsList = document.getElementById('downloadsList');

// --- INITIALIZATION ---
async function initialize() {
    showToast('🔥 Initializing engines, please wait...');
    extractButton.disabled = true;
    extractButton.textContent = 'Loading...';

    try {
        // --- Pyodide Initialization ---
        pyodide = await loadPyodide();
        await pyodide.loadPackage("micropip");
        await pyodide.runPythonAsync(`
            import micropip
            await micropip.install('yt-dlp')
        `);
        console.log("Pyodide and yt-dlp loaded.");

        // --- FFmpeg Initialization ---
        // The imported FFmpeg class is now used directly. No need to wait.
        ffmpeg = new FFmpeg();
        ffmpeg.on('log', ({ message }) => { console.log(message); });
        await ffmpeg.load();
        console.log("FFmpeg loaded.");

        showToast('✅ Engines ready!', 'success');
    } catch (err) {
        console.error("Engine loading failed:", err);
        showToast(`❌ Engine failed to load: ${err.message}`, 'error');
    } finally {
        extractButton.disabled = false;
        extractButton.textContent = 'Extract';
    }
}

// --- CORE FUNCTIONS ---
async function fetchVideoInfo() {
    const url = urlInput.value.trim();
    if (!url) {
        showToast('⚠️ Please paste a valid YouTube URL.', 'error');
        return;
    }

    showToast('⏳ Fetching video details...');
    detailsContent.style.display = 'none';
    skeletonLoader.style.display = 'flex';
    detailsContainer.style.display = 'flex';
    extractButton.disabled = true;
    extractButton.textContent = 'Fetching...';

    try {
        pyodide.globals.set("video_url", url);
        const results = await pyodide.runPythonAsync(`
            import yt_dlp
            import json

            ydl_opts = {'quiet': True}
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(video_url, download=False)
                formats = [
                    {
                        'format_id': f['format_id'],
                        'ext': f['ext'],
                        'abr': f.get('abr'),
                        'url': f['url'],
                        'filesize': f.get('filesize') or f.get('filesize_approx')
                    }
                    for f in info.get('formats', [])
                    if f.get('vcodec') == 'none' and f.get('acodec') != 'none' and f.get('abr')
                ]
                json.dumps({
                    "title": info.get("title"),
                    "thumbnail": info.get("thumbnail"),
                    "artist": info.get("uploader"),
                    "audio_formats": formats
                })
        `);

        const data = JSON.parse(results);
        currentVideoData = data;
        displayVideoDetails(data);

    } catch (err) {
        console.error(err);
        showToast(`❌ Error fetching info. Check console for details.`, 'error');
        detailsContainer.style.display = 'none';
    } finally {
        extractButton.disabled = false;
        extractButton.textContent = 'Extract';
    }
}

async function startPreview() {
    if (!currentVideoData.audio_formats || !selectedFormatId) {
        showToast('⚠️ Please select a quality first.', 'error');
        return;
    }

    const selectedFormat = currentVideoData.audio_formats.find(f => f.format_id === selectedFormatId);
    if (!selectedFormat) {
        showToast('❌ Could not find selected format.', 'error');
        return;
    }

    const previewButton = document.getElementById('previewButton');
    const progressContainer = document.getElementById('progressContainer');
    const progressFill = document.getElementById('progressFill');

    previewButton.disabled = true;
    previewButton.innerHTML = 'Downloading...';
    progressContainer.style.display = 'block';
    progressFill.style.width = '0%';

    try {
        const corsProxyUrl = `https://corsproxy.io/?${encodeURIComponent(selectedFormat.url)}`;
        const response = await fetch(corsProxyUrl);
        if (!response.ok) throw new Error(`Download failed with status: ${response.status}`);
        const data = await response.arrayBuffer();
        progressFill.style.width = '50%';

        previewButton.innerHTML = 'Converting to MP3...';
        const inputFileName = `input.${selectedFormat.ext}`;
        const outputFileName = 'output.mp3';
        
        await ffmpeg.writeFile(inputFileName, new Uint8Array(data));
        await ffmpeg.exec(['-i', inputFileName, '-acodec', 'libmp3lame', '-b:a', '192k', outputFileName]);
        const outputData = await ffmpeg.readFile(outputFileName);
        progressFill.style.width = '100%';

        const blob = new Blob([outputData.buffer], { type: 'audio/mpeg' });
        previewLibrary.push({
            metadata: {
                title: currentVideoData.title,
                artist: currentVideoData.artist,
                thumbnail: currentVideoData.thumbnail
            },
            blob: blob
        });
        renderPreviewLibrary();
        showToast('✅ Preview loaded!', 'success');
        
        urlInput.value = "";
        detailsContainer.style.display = 'none';

    } catch (err) {
        console.error(err);
        showToast(`❌ Error: ${err.message}`, 'error');
    } finally {
        previewButton.disabled = false;
        previewButton.innerHTML = 'Preview';
        progressContainer.style.display = 'none';
    }
}

// --- UI HELPER FUNCTIONS ---
function displayVideoDetails(data) {
    document.getElementById('thumbnail').src = data.thumbnail;
    document.getElementById('videoTitle').textContent = data.title;
    document.getElementById('videoArtist').textContent = data.artist;

    const qualityButtonsContainer = document.getElementById('qualityButtons');
    qualityButtonsContainer.innerHTML = '';
    
    if (data.audio_formats.length > 0) {
        selectedFormatId = data.audio_formats[0].format_id;
    } else {
        showToast('⚠️ No audio-only formats found for this video.', 'error');
    }

    data.audio_formats.forEach((format, index) => {
        const button = document.createElement('button');
        button.className = `quality-button ${index === 0 ? 'selected' : ''}`;
        button.dataset.formatId = format.format_id;
        const size = format.filesize ? ` - ${formatBytes(format.filesize)}` : '';
        button.textContent = `${Math.round(format.abr)}kbps (${format.ext})${size}`;
        button.onclick = () => selectQuality(button);
        qualityButtonsContainer.appendChild(button);
    });

    skeletonLoader.style.display = 'none';
    detailsContent.style.display = 'flex';
}

function selectQuality(buttonElement) {
    document.querySelectorAll('.quality-button').forEach(btn => btn.classList.remove('selected'));
    buttonElement.classList.add('selected');
    selectedFormatId = buttonElement.dataset.formatId;
}

function renderPreviewLibrary() {
    downloadsList.innerHTML = '';
    if (previewLibrary.length === 0) {
        downloadsList.innerHTML = '<p>No previews loaded yet.</p>';
        return;
    }
    previewLibrary.forEach((item, index) => {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'download-item';
        const playerId = `player-${index}`;
        const audioBlobUrl = URL.createObjectURL(item.blob);

        itemDiv.innerHTML = `
            <img src="${item.metadata.thumbnail}" alt="thumbnail" class="thumbnail-small">
            <div class="item-info">
                <strong>${item.metadata.title}</strong>
                <p>${item.metadata.artist}</p>
                <div class="custom-audio-player" id="${playerId}">
                    <audio src="${audioBlobUrl}" preload="metadata"></audio>
                    <button class="play-pause-btn">
                        <svg viewBox="0 0 24 24" fill="currentColor" class="play-icon"><path d="M8 5v14l11-7z"/></svg>
                        <svg viewBox="0 0 24 24" fill="currentColor" class="pause-icon" style="display:none;"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
                    </button>
                    <span class="time-current">0:00</span>
                    <input type="range" class="progress-bar" value="0" max="100">
                    <span class="time-duration">0:00</span>
                </div>
            </div>
            <div class="item-controls">
                <button onclick="downloadPreview(${index})">Download</button>
                <button onclick="deletePreview(${index})">Delete</button>
            </div>
        `;
        downloadsList.appendChild(itemDiv);
        initializePlayer(playerId);
    });
}

function initializePlayer(playerId) {
    const player = document.getElementById(playerId);
    const audio = player.querySelector('audio');
    const playPauseBtn = player.querySelector('.play-pause-btn');
    const playIcon = player.querySelector('.play-icon');
    const pauseIcon = player.querySelector('.pause-icon');
    const progressBar = player.querySelector('.progress-bar');
    const currentTimeEl = player.querySelector('.time-current');
    const durationEl = player.querySelector('.time-duration');
    
    playPauseBtn.onclick = () => {
        if (audio.paused) {
            if (currentlyPlayingAudio && currentlyPlayingAudio !== audio) currentlyPlayingAudio.pause();
            audio.play();
            currentlyPlayingAudio = audio;
        } else {
            audio.pause();
            currentlyPlayingAudio = null;
        }
    };
    audio.onplay = () => { playIcon.style.display = 'none'; pauseIcon.style.display = 'block'; };
    audio.onpause = () => { playIcon.style.display = 'block'; pauseIcon.style.display = 'none'; };
    audio.onloadedmetadata = () => { progressBar.max = audio.duration; durationEl.textContent = formatTime(audio.duration); };
    audio.ontimeupdate = () => { progressBar.value = audio.currentTime; currentTimeEl.textContent = formatTime(audio.currentTime); };
    progressBar.oninput = () => { audio.currentTime = progressBar.value; };
    audio.onended = () => { currentlyPlayingAudio = null; };
}

function downloadPreview(index) {
    const item = previewLibrary[index];
    const link = document.createElement('a');
    link.href = URL.createObjectURL(item.blob);
    link.download = `${item.metadata.title}.mp3`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast("✅ Download started!", "success");
}

function deletePreview(index) {
    if (confirm('Are you sure you want to remove this preview?')) {
        previewLibrary.splice(index, 1);
        renderPreviewLibrary();
    }
}

function showToast(message, type = 'info') {
    const toast = document.getElementById('toastNotification');
    toast.textContent = message;
    toast.className = '';
    toast.classList.add(type, 'show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('show'), 5000);
}

function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
}

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Make functions globally available for HTML onclick attributes
window.fetchVideoInfo = fetchVideoInfo;
window.startPreview = startPreview;
window.deletePreview = deletePreview;
window.downloadPreview = downloadPreview;

// Start the application
initialize();