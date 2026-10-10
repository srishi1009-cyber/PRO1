"use strict";

/* ============================================================
   RISHI MUSIC — 100% WORKING ENGINE
   - Memory-safe Blob URLs (Prevents 1-second freeze on Song 3)
   - Strict daily tracking (Song plays once per day only)
   - Auto-resets daily cycle only when ALL songs have finished
   - Complete AirPods / Bluetooth hardware control
   ============================================================ */

/* 1. SERVICE WORKER REGISTRATION */
if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
        navigator.serviceWorker.register("./sw.js").catch(function (err) {
            console.error("[Rishi Music] SW Registration Failed:", err);
        });
    });
}

/* 2. INDEXEDDB PERSISTENCE */
const DB_NAME = "RishiMusicDB_v2";
const DB_VERSION = 1;
const STORE_NAME = "permanent_tracks";
let db = null;

function initDB() {
    return new Promise(function (resolve, reject) {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = function (e) {
            const database = e.target.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                database.createObjectStore(STORE_NAME, { keyPath: "id" });
            }
        };
        request.onsuccess = function () {
            db = request.result;
            resolve(db);
        };
        request.onerror = function () {
            reject(request.error);
        };
    });
}

function getAllTracksFromDB() {
    return new Promise(function (resolve, reject) {
        if (!db) return resolve([]);
        const tx = db.transaction([STORE_NAME], "readonly");
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
    });
}

function saveTrackToDB(track) {
    return new Promise(function (resolve, reject) {
        if (!db) return resolve();
        const tx = db.transaction([STORE_NAME], "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(track);
        req.onsuccess = function () { resolve(); };
        req.onerror = function () { reject(req.error); };
    });
}

function removeTrackFromDB(id) {
    return new Promise(function (resolve, reject) {
        if (!db) return resolve();
        const tx = db.transaction([STORE_NAME], "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const req = store.delete(id);
        req.onsuccess = function () { resolve(); };
        req.onerror = function () { reject(req.error); };
    });
}

function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
        const reader = new FileReader();
        reader.onload = function () { resolve(reader.result); };
        reader.onerror = function (err) { reject(err); };
        reader.readAsDataURL(file);
    });
}

// Convert Base64 back to lightweight Binary Blob URL for hardware decoding
function base64ToBlobUrl(base64) {
    const parts = base64.split(";base64,");
    const contentType = parts[0].replace("data:", "");
    const raw = window.atob(parts[1]);
    const rawLength = raw.length;
    const uInt8Array = new Uint8Array(rawLength);
    for (let i = 0; i < rawLength; ++i) {
        uInt8Array[i] = raw.charCodeAt(i);
    }
    const blob = new Blob([uInt8Array], { type: contentType });
    return URL.createObjectURL(blob);
}

/* 3. APPLICATION STATE */
let tracks = [];
let currentTrackIndex = -1;
let currentBlobUrl = null;
let playHistory = [];
let userManuallyPaused = false;
let isSwitchingSong = false;
let activeEditingTrackId = null;
let deferredPrompt = null;

/* 4. DOM ELEMENTS */
const audio = document.getElementById("audioEl");
const tracksContainer = document.getElementById("tracksContainer");
const searchInput = document.getElementById("searchInput");
const directorFilter = document.getElementById("directorFilter");
const importBtn = document.getElementById("importBtn");
const fileSelector = document.getElementById("fileSelector");
const mainPlayBtn = document.getElementById("mainPlayBtn");
const mainPlayIcon = document.getElementById("mainPlayIcon");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const progressBar = document.getElementById("progressBar");
const currentTimeEl = document.getElementById("currentTime");
const durationEl = document.getElementById("duration");
const dockTitle = document.getElementById("dockTitle");
const dockSubtitle = document.getElementById("dockSubtitle");
const installBar = document.getElementById("installBar");
const installTriggerBtn = document.getElementById("installTriggerBtn");
const editModal = document.getElementById("editModal");
const editTitleInput = document.getElementById("editTitleInput");
const editDirectorInput = document.getElementById("editDirectorInput");
const cancelEditBtn = document.getElementById("cancelEditBtn");
const saveEditBtn = document.getElementById("saveEditBtn");

/* 5. STRICT DAILY ROTATION STORAGE */
function getTodayDateString() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function getDailyLog() {
    const today = getTodayDateString();
    try {
        const raw = localStorage.getItem("rishi_daily_plays_v2");
        let parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || parsed.date !== today || !Array.isArray(parsed.playedIds)) {
            parsed = { date: today, playedIds: [] };
            localStorage.setItem("rishi_daily_plays_v2", JSON.stringify(parsed));
        }
        return parsed;
    } catch (e) {
        return { date: today, playedIds: [] };
    }
}

function saveDailyLog(log) {
    try {
        localStorage.setItem("rishi_daily_plays_v2", JSON.stringify(log));
    } catch (e) {
        console.warn("Storage error:", e);
    }
}

function markSongAsPlayed(songId) {
    const log = getDailyLog();
    if (!log.playedIds.includes(songId)) {
        log.playedIds.push(songId);
    }
    saveDailyLog(log);
    renderTracks();
}

function getNextUnplayedIndex() {
    if (tracks.length === 0) return -1;
    if (tracks.length === 1) return 0;

    let log = getDailyLog();

    // Find all tracks that have NOT been played today
    let unplayed = [];
    tracks.forEach(function (t, idx) {
        if (!log.playedIds.includes(t.id) && idx !== currentTrackIndex) {
            unplayed.push(idx);
        }
    });

    // If all songs are finished, reset daily cycle so they can replay
    if (unplayed.length === 0) {
        log.playedIds = [];
        saveDailyLog(log);
        tracks.forEach(function (_, idx) {
            if (idx !== currentTrackIndex) {
                unplayed.push(idx);
            }
        });
    }

    if (unplayed.length === 0) return 0;

    // Pick random song from remaining unplayed pool
    const rand = Math.floor(Math.random() * unplayed.length);
    return unplayed[rand];
}

/* 6. AIRPODS & HARDWARE MEDIA SESSION */
function updateMediaSession(track) {
    if (!("mediaSession" in navigator) || !track) return;
    try {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: track.title,
            artist: track.director,
            album: "Rishi Music"
        });

        navigator.mediaSession.setActionHandler("play", function () {
            userManuallyPaused = false;
            playCurrentTrack();
        });

        navigator.mediaSession.setActionHandler("pause", function () {
            pauseCurrentTrack();
        });

        navigator.mediaSession.setActionHandler("nexttrack", function () {
            userManuallyPaused = false;
            advanceToNextTrack();
        });

        navigator.mediaSession.setActionHandler("previoustrack", function () {
            userManuallyPaused = false;
            playPreviousTrack();
        });

        navigator.mediaSession.setActionHandler("seekto", function (e) {
            if (e.seekTime && Number.isFinite(e.seekTime)) {
                audio.currentTime = e.seekTime;
            }
        });
    } catch (e) {
        console.warn("MediaSession error:", e);
    }
}

/* 7. PLAYBACK ENGINE — NO STALLING */
function loadTrackSource(index) {
    if (index < 0 || index >= tracks.length) return false;

    currentTrackIndex = index;
    const track = tracks[currentTrackIndex];

    // Revoke previous blob URL to prevent memory leaks and decoder stalls
    if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
        currentBlobUrl = null;
    }

    // Convert to Binary Blob URL
    currentBlobUrl = base64ToBlobUrl(track.audioData);

    // Reset audio state cleanly
    audio.pause();
    audio.currentTime = 0;
    audio.src = currentBlobUrl;
    audio.load();

    // Update UI elements
    dockTitle.textContent = track.title;
    dockSubtitle.textContent = track.director;
    currentTimeEl.textContent = "0:00";
    durationEl.textContent = "0:00";
    progressBar.value = 0;

    updateMediaSession(track);
    renderTracks();
    return true;
}

function playCurrentTrack() {
    if (currentTrackIndex === -1 && tracks.length > 0) {
        const firstIdx = getNextUnplayedIndex();
        loadTrackSource(firstIdx !== -1 ? firstIdx : 0);
    }

    const track = tracks[currentTrackIndex];
    if (!track) return;

    userManuallyPaused = false;

    // Use direct play promise handling
    const playPromise = audio.play();
    if (playPromise !== undefined) {
        playPromise.then(function () {
            setPlayIconState(true);
            if ("mediaSession" in navigator) {
                navigator.mediaSession.playbackState = "playing";
            }
            renderTracks();
        }).catch(function (error) {
            console.warn("Autoplay deferred:", error);
            setPlayIconState(false);
        });
    }
}

function pauseCurrentTrack() {
    userManuallyPaused = true;
    audio.pause();
    setPlayIconState(false);
    if ("mediaSession" in navigator) {
        navigator.mediaSession.playbackState = "paused";
    }
    renderTracks();
}

function advanceToNextTrack() {
    if (isSwitchingSong || tracks.length === 0) return;
    isSwitchingSong = true;
    userManuallyPaused = false;

    if (currentTrackIndex !== -1) {
        playHistory.push(currentTrackIndex);
        if (playHistory.length > 50) playHistory.shift();
    }

    const nextIndex = getNextUnplayedIndex();
    if (nextIndex === -1) {
        isSwitchingSong = false;
        return;
    }

    loadTrackSource(nextIndex);

    // Give browser audio pipeline 60ms to allocate hardware buffer
    setTimeout(function () {
        playCurrentTrack();
        isSwitchingSong = false;
    }, 60);
}

function playPreviousTrack() {
    if (tracks.length === 0) return;
    userManuallyPaused = false;

    if (audio.currentTime > 3) {
        audio.currentTime = 0;
        playCurrentTrack();
        return;
    }

    if (playHistory.length > 0) {
        const prevIdx = playHistory.pop();
        loadTrackSource(prevIdx);
        setTimeout(playCurrentTrack, 60);
    } else {
        audio.currentTime = 0;
        playCurrentTrack();
    }
}

/* 8. NATIVE AUDIO EVENT LISTENERS */
// Mark song as played and advance to next track
audio.addEventListener("ended", function () {
    if (userManuallyPaused || isSwitchingSong) return;

    const currentTrack = tracks[currentTrackIndex];
    if (currentTrack) {
        markSongAsPlayed(currentTrack.id);
    }

    advanceToNextTrack();
});

// Failsafe auto-skip if a bad file stalls at 0:01
audio.addEventListener("error", function () {
    if (userManuallyPaused || isSwitchingSong) return;
    console.warn("Audio stream interrupted, auto-advancing to next song.");
    setTimeout(advanceToNextTrack, 300);
});

audio.addEventListener("timeupdate", function () {
    if (!audio.duration) return;
    progressBar.value = (audio.currentTime / audio.duration) * 100;
    currentTimeEl.textContent = formatTime(audio.currentTime);
    durationEl.textContent = formatTime(audio.duration);
});

progressBar.addEventListener("input", function () {
    if (audio.duration) {
        audio.currentTime = (Number(progressBar.value) / 100) * audio.duration;
    }
});

function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ":" + String(s).padStart(2, "0");
}

function setPlayIconState(isPlaying) {
    if (!mainPlayIcon) return;
    if (isPlaying) {
        mainPlayIcon.innerHTML = `<rect x="6" y="4" width="4" height="16" fill="#ffffff"></rect><rect x="14" y="4" width="4" height="16" fill="#ffffff"></rect>`;
    } else {
        mainPlayIcon.innerHTML = `<polygon points="6,4 20,12 6,20" fill="#ffffff"></polygon>`;
    }
}

/* 9. UI RENDERING */
function renderTracks() {
    if (!tracksContainer) return;
    const query = String(searchInput.value || "").trim().toLowerCase();
    const filter = directorFilter.value || "ALL";
    const log = getDailyLog();

    tracksContainer.innerHTML = "";

    if (tracks.length === 0) {
        tracksContainer.innerHTML = `
            <div class="empty-state">
                Your library is empty.<br>
                Click <strong>+ Import Track</strong> above to add songs.
            </div>
        `;
        updateDirectorDropdown();
        return;
    }

    tracks.forEach(function (track, idx) {
        const matchesSearch = track.title.toLowerCase().includes(query) || track.director.toLowerCase().includes(query);
        const matchesDirector = filter === "ALL" || track.director === filter;
        if (!matchesSearch || !matchesDirector) return;

        const isCurrent = idx === currentTrackIndex;
        const isPlaying = isCurrent && !audio.paused;
        const isPlayedToday = log.playedIds.includes(track.id);

        const card = document.createElement("div");
        card.className = "track-card" + (isCurrent ? " active" : "") + (isPlayedToday ? " played-today" : "");

        card.innerHTML = `
            <div class="track-main">
                <span class="music-glyph">♬</span>
                <div class="track-text">
                    <div class="track-name">${track.title}</div>
                    <div class="track-sub">
                        ${track.director}
                        ${isPlayedToday ? '<span class="daily-status"> Played Today</span>' : ""}
                    </div>
                </div>
            </div>
            <div class="track-actions">
                <button class="edit-btn" data-action="edit" data-id="${track.id}">Edit</button>
                <button class="delete-btn" data-action="delete" data-id="${track.id}">🗑</button>
                <button class="card-play-btn" data-action="play" data-idx="${idx}">
                    ${isPlaying ? '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>' : '<svg viewBox="0 0 24 24"><polygon points="6,4 20,12 6,20"></polygon></svg>'}
                </button>
            </div>
        `;

        tracksContainer.appendChild(card);
    });

    updateDirectorDropdown();
}

function updateDirectorDropdown() {
    const cur = directorFilter.value || "ALL";
    const dirs = Array.from(new Set(tracks.map(function (t) { return t.director; }))).filter(Boolean).sort();
    directorFilter.innerHTML = '<option value="ALL">ALL DIRECTORS</option>';
    dirs.forEach(function (d) {
        const opt = document.createElement("option");
        opt.value = d;
        opt.textContent = d;
        directorFilter.appendChild(opt);
    });
    directorFilter.value = Array.from(directorFilter.options).some(function (o) { return o.value === cur; }) ? cur : "ALL";
}

/* 10. CARD CLICKS, EDIT & DELETE */
tracksContainer.addEventListener("click", function (e) {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    e.stopPropagation();

    const action = btn.dataset.action;

    if (action === "play") {
        const idx = Number(btn.dataset.idx);
        const selected = tracks[idx];
        const log = getDailyLog();

        if (log.playedIds.includes(selected.id) && idx !== currentTrackIndex) {
            const ok = confirm(`"${selected.title}" has already been played today.\nDo you want to replay it anyway?`);
            if (!ok) return;
        }

        if (idx === currentTrackIndex) {
            if (audio.paused) playCurrentTrack();
            else pauseCurrentTrack();
        } else {
            loadTrackSource(idx);
            setTimeout(playCurrentTrack, 50);
        }
    } else if (action === "edit") {
        const track = tracks.find(function (t) { return t.id === btn.dataset.id; });
        if (!track) return;
        activeEditingTrackId = track.id;
        editTitleInput.value = track.title;
        editDirectorInput.value = track.director;
        editModal.classList.add("open");
    } else if (action === "delete") {
        const track = tracks.find(function (t) { return t.id === btn.dataset.id; });
        if (!track || !confirm(`Delete "${track.title}"?`)) return;

        removeTrackFromDB(track.id).then(function () {
            const idx = tracks.indexOf(track);
            if (idx === currentTrackIndex) {
                audio.pause();
                currentTrackIndex = -1;
                dockTitle.textContent = "No track playing";
                dockSubtitle.textContent = "Select a song from your library";
                setPlayIconState(false);
            }
            tracks.splice(idx, 1);
            renderTracks();
        });
    }
});

cancelEditBtn.addEventListener("click", function () {
    editModal.classList.remove("open");
    activeEditingTrackId = null;
});

saveEditBtn.addEventListener("click", function () {
    if (!activeEditingTrackId) return;
    const track = tracks.find(function (t) { return t.id === activeEditingTrackId; });
    if (!track) return;

    const t = editTitleInput.value.trim();
    const d = editDirectorInput.value.trim();
    if (!t) return alert("Title cannot be empty.");

    track.title = t;
    track.director = d || "UNKNOWN DIRECTOR";

    saveTrackToDB(track).then(function () {
        if (tracks[currentTrackIndex]?.id === track.id) {
            dockTitle.textContent = track.title;
            dockSubtitle.textContent = track.director;
        }
        editModal.classList.remove("open");
        activeEditingTrackId = null;
        renderTracks();
    });
});

/* 11. IMPORT TRACKS */
importBtn.addEventListener("click", function () { fileSelector.click(); });

fileSelector.addEventListener("change", async function (e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    importBtn.disabled = true;
    importBtn.textContent = "Saving audio...";

    for (const f of files) {
        try {
            const base64 = await fileToBase64(f);
            const track = {
                id: "track_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
                title: f.name.replace(/\.[^.]+$/, ""),
                director: "UNKNOWN DIRECTOR",
                audioData: base64
            };
            await saveTrackToDB(track);
            tracks.push(track);
        } catch (err) {
            console.error("Import error:", err);
        }
    }

    importBtn.disabled = false;
    importBtn.textContent = "+ Import Track";
    fileSelector.value = "";
    renderTracks();
});

/* 12. BOTTOM PLAYER CONTROLS */
mainPlayBtn.addEventListener("click", function () {
    if (audio.paused) playCurrentTrack();
    else pauseCurrentTrack();
});
prevBtn.addEventListener("click", playPreviousTrack);
nextBtn.addEventListener("click", advanceToNextTrack);
searchInput.addEventListener("input", renderTracks);
directorFilter.addEventListener("change", renderTracks);

/* 13. PWA INSTALL BANNER */
window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (installBar) installBar.style.display = "flex";
});

installTriggerBtn.addEventListener("click", async function () {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const res = await deferredPrompt.userChoice;
    if (res.outcome === "accepted" && installBar) {
        installBar.style.display = "none";
    }
    deferredPrompt = null;
});

/* INITIALIZE */
initDB().then(async function () {
    tracks = await getAllTracksFromDB();
    renderTracks();
});