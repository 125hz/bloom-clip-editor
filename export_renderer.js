// export_renderer.js - Handles exporting
const { ipcRenderer } = require("electron");

let allow120 = false;
let projectDuration = 0; // in seconds

const tabs = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');
const sizeSlider = document.getElementById('size-slider');
const targetSizeInput = document.getElementById('target-mb-input');
const estSizeDisplay = document.getElementById('est-size-display');
const durationDisplay = document.getElementById('duration-display');
const footerStats = document.querySelector('.footer-stats');

// BITRATES must match main.js for accurate estimation
const BITRATES_MBPS = {
    normal: 6.0 + 0.192,
    smooth: 10.0 + 0.192,
    hq: 18.0 + 0.320
};

ipcRenderer.on("export-presets-init", (_e, data) => {
    allow120 = !!data?.allow120;
    projectDuration = Number(data?.duration) || 1;

    const smooth = document.getElementById("preset-smooth");
    const hq = document.getElementById("preset-hq");
    
    if (!allow120) {
        if (smooth) smooth.classList.add("disabled");
        if (hq) hq.classList.add("disabled");
    }

    // Format Duration
    const m = Math.floor(projectDuration / 60);
    const s = Math.floor(projectDuration % 60);
    durationDisplay.textContent = `${m}:${s.toString().padStart(2, '0')}`;

    updateUI('slider');
});

// --- LOGARITHMIC SLIDER LOGIC ---
// Maps 0-100 input to 5-1000 MB output
function getSliderMB(val) {
    const minMB = 5;
    const maxMB = 1000;
    const b = Math.log(maxMB / minMB) / 100;
    return minMB * Math.exp(b * val);
}

// Maps 5-1000 MB back to 0-100 input
function setSliderPos(mb) {
    const minMB = 5;
    const maxMB = 1000;
    // Clamp mb
    if (mb < minMB) mb = minMB;
    if (mb > maxMB) mb = maxMB;
    
    const b = Math.log(maxMB / minMB) / 100;
    return Math.log(mb / minMB) / b;
}

const limitToggle = document.getElementById('limit-toggle');
const limitControls = document.getElementById('limit-controls');

// Initialize slider to ~50MB
sizeSlider.value = setSliderPos(50);

// Global state for CRF
let currentCRF = 18;

// Event Listeners
sizeSlider.addEventListener('input', () => updateUI('slider'));
targetSizeInput.addEventListener('input', () => updateUI('input'));
limitToggle.addEventListener('change', () => updateUI('toggle'));

const customInputs = ['cw', 'ch', 'cfps'];
customInputs.forEach(id => {
    document.getElementById(id).addEventListener('input', () => updateUI('custom-settings'));
});


// Listen for CRF changes via delegation
estSizeDisplay.addEventListener('input', (e) => {
    if (e.target.id === 'crf-input') {
        currentCRF = Number(e.target.value) || 18;
        updateUI('crf'); // Re-calc size
    }
});

// Heuristic Size Estimation
function estimateCRFSizeMB(w, h, fps, crf, duration) {
    const basePixels = 1920 * 1080;
    const baseFPS = 60;
    const baseCRF = 23;
    const baseBitrate = 6.0;

    const pixels = w * h;
    const pixelFactor = pixels / basePixels;
    const fpsFactor = fps / baseFPS;
    
    const crfFactor = Math.pow(2, (baseCRF - crf) / 6);

    const safetyFactor = 2.0; 
    const estMbps = baseBitrate * pixelFactor * fpsFactor * crfFactor * safetyFactor;
    
    return (estMbps * duration) / 8;
}

// --- TABS ---
tabs.forEach(btn => {
    btn.addEventListener('click', () => {
        tabs.forEach(b => b.classList.remove('active'));
        tabContents.forEach(c => c.classList.remove('active'));
        
        btn.classList.add('active');
        document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
        
        // Re-run updateUI to ensure correct state (e.g. preset cards size)
        updateUI('tab');
    });
});

function updateUI(source) {
    const activeTab = document.querySelector('.tab-btn.active').dataset.tab;
    const limitEnabled = limitToggle.checked;
    
    // Toggle Controls Visibility/State
    if (limitEnabled) {
        limitControls.style.opacity = '1';
        limitControls.style.pointerEvents = 'auto';
    } else {
        limitControls.style.opacity = '0.3';
        limitControls.style.pointerEvents = 'none';
    }

    let currentMB = 50;
    
    if (limitEnabled) {
        if (source === 'slider') {
            const sliderVal = Number(sizeSlider.value);
            currentMB = getSliderMB(sliderVal);
            if (document.activeElement !== targetSizeInput) {
                 targetSizeInput.value = currentMB < 100 ? currentMB.toFixed(1) : Math.round(currentMB);
            }
        } else if (source === 'input') {
            currentMB = Number(targetSizeInput.value) || 5;
            sizeSlider.value = setSliderPos(currentMB);
        } else {
            currentMB = Number(targetSizeInput.value) || 50;
        }
    }
    
    if (activeTab === 'custom') {
        estSizeDisplay.parentElement.style.visibility = 'visible';
        
        if (limitEnabled) {
             let displayMB = currentMB;
             const txt = displayMB < 100 ? Number(displayMB).toFixed(1) : Math.round(displayMB);
             
             // Calculate Bitrate
             let bitrateStr = "";
             if (projectDuration > 0) {
                 const mbps = (displayMB * 8) / projectDuration;
                 bitrateStr = ` <span style="opacity:0.6; font-size:0.9em;">(${mbps.toFixed(1)} Mbps)</span>`;
             }
             estSizeDisplay.innerHTML = `~${txt} MB${bitrateStr}`;
        } else {
             // Limit disabled -> CRF mode (Estimated Size)
             const w = Number(document.getElementById("cw").value) || 1920;
             const h = Number(document.getElementById("ch").value) || 1080;
             const fps = Number(document.getElementById("cfps").value) || 60;
             
             const estMB = estimateCRFSizeMB(w, h, fps, currentCRF, projectDuration);
             const txt = estMB < 100 ? estMB.toFixed(1) : Math.round(estMB);
             
             const inputStyle = "background:transparent; border:none; border-bottom:1px solid rgba(255,255,255,0.2); color:var(--accent-color); font-weight:700; width:40px; text-align:center; padding:0 2px; outline:none; font-family:inherit; font-size:inherit;";
             
             if (source === 'crf') {
                 const sizeText = estSizeDisplay.childNodes[0];
                 if (sizeText && sizeText.nodeType === Node.TEXT_NODE) {
                     sizeText.textContent = `~${txt} MB (CRF `;
                 } else {
                     estSizeDisplay.innerHTML = `~${txt} MB (CRF <input id="crf-input" type="number" value="${currentCRF}" min="0" max="51" step="1" style="${inputStyle}">)`;
                     document.getElementById('crf-input').focus();
                 }
             } else {
                 estSizeDisplay.innerHTML = `~${txt} MB (CRF <input id="crf-input" type="number" value="${currentCRF}" min="0" max="51" step="1" style="${inputStyle}">)`;
             }
        }
    } else {
        estSizeDisplay.parentElement.style.visibility = 'hidden';
    }
    
    updatePresetCard("preset-normal", BITRATES_MBPS.normal);
    updatePresetCard("preset-smooth", BITRATES_MBPS.smooth);
    updatePresetCard("preset-hq", BITRATES_MBPS.hq);
    
    const discordMB = Math.min(9.0, (projectDuration * 50.0 * 0.125));
    updatePresetCard("preset-discord", null, discordMB);
}

// updatePresetCard - Updates a preset card's estimated size
function updatePresetCard(id, rateMbps, fixedMB) {
    const el = document.querySelector(`#${id} .preset-size`);
    if (!el) return;
    
    let mb = fixedMB;
    if (rateMbps) {
        // duration * Mbps / 8 = MB
        mb = (projectDuration * rateMbps) / 8;
    }
    
    const txt = mb < 100 ? mb.toFixed(1) : Math.round(mb);
    el.textContent = `~${txt} MB`;
}

// sendPreset - Sends a preset to the main process
function sendPreset(preset, width, height, fps, targetSizeBytes = 0, crf = null) {
    ipcRenderer.send("export-preset-selected", { 
        preset, width, height, fps, targetSizeBytes, crf
    });
}

// --- PRESET CLICK LISTENERS ---
document.getElementById("preset-normal").addEventListener("click", () => {
    sendPreset("normal", 1920, 1080, 60);
});

document.getElementById("preset-smooth").addEventListener("click", () => {
    if (!allow120) return;
    sendPreset("smooth", 1920, 1080, 120);
});

document.getElementById("preset-hq").addEventListener("click", () => {
    if (!allow120) return;
    sendPreset("hq", 2560, 1440, 120);
});

document.getElementById("preset-discord").addEventListener("click", () => {
    sendPreset("discord", 1280, 720, 30);
});

// Custom Export
document.getElementById("export-custom").addEventListener("click", () => {
    const w = Number(document.getElementById("cw").value) || 1920;
    const h = Number(document.getElementById("ch").value) || 1080;
    const fps = Number(document.getElementById("cfps").value) || 60;
    
    let targetBytes = 0;
    let customCRF = null;
    
    if (limitToggle.checked) {
        const mb = Number(targetSizeInput.value) || 50;
        targetBytes = mb * 1024 * 1024;
    } else {
        customCRF = currentCRF;
    }

    sendPreset("custom", w, h, fps, targetBytes, customCRF);
});

// Cancel
document.getElementById("cancel").addEventListener("click", () => {
    ipcRenderer.send("export-preset-selected", null);
});
