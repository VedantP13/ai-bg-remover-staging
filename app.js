// AI Background Remover — IMG.LY primary + optional MediaPipe fallback (ES2019-safe)

const el = (id) => document.getElementById(id);
const $ = {
fileInput: el('file-input'),
btnChoose: el('btn-choose'),
fileMeta: el('file-meta'),
btnAI: el('btn-ai'),
aiProg: el('ai-progress'),
aiBar: el('ai-progress-bar'),
aiStatus: el('ai-status'),
badgeModel: el('badge-model'),
badgeFallback: el('badge-fallback'),
dbgLoad: el('dbg-load'),
dbgInfer: el('dbg-infer'),
dbgFb: el('dbg-fb'),
toolKeep: el('tool-keep'),
toolRemove: el('tool-remove'),
brushSize: el('brush-size'),
brushSizeVal: el('brush-size-val'),
feather: el('feather'),
featherVal: el('feather-val'),
undo: el('undo'),
redo: el('redo'),
toggleMatte: el('toggle-matte'),
download: el('download'),
canvasOrig: el('canvas-original'),
canvasRes: el('canvas-result'),
canvasMatte: el('canvas-matte'),
canvasBrush: el('canvas-brush'),
resultWrap: el('result-wrap'),
};

const state = {
image: null,
imgBitmap: null,
tool: 'keep',
brushSize: 24,
feather: 0,
isDrawing: false,
history: [],
histIndex: -1,
aiMask: null, // Float32Array [0..1]
refineKeep: null, // Float32Array delta
refineRemove: null, // Float32Array delta
finalMask: null, // Float32Array [0..1]
modelReady: false,
usedFallback: false,
timings: { load: 0, infer: 0 },
matteOn: false,
imglyRemover: null, // primary (IMG.LY)
mpSegmenter: null, // optional fallback (MediaPipe)
};

const ctxO = $.canvasOrig.getContext('2d');
const ctxR = $.canvasRes.getContext('2d');
const ctxM = $.canvasMatte.getContext('2d');
const ctxB = $.canvasBrush.getContext('2d');

// ---------- Layout/render ----------

function fitCanvasToImage(w, h) {
const preview = document.querySelector('.preview');
const split = document.querySelector('.split');
const maxW = (preview.clientWidth - 40) / 2;
const maxH = split.clientHeight - 60;
const scale = Math.min(maxW / w, maxH / h, 1);
const cw = Math.max(1, Math.round(w * scale));
const ch = Math.max(1, Math.round(h * scale));
[$.canvasOrig, $.canvasRes, $.canvasMatte, $.canvasBrush].forEach(function(c){
c.width = cw; c.height = ch;
c.style.width = ${cw}px; c.style.height = ${ch}px;
});
}

function drawOriginal() {
if (!state.image) return;
ctxO.clearRect(0, 0, $.canvasOrig.width, $.canvasOrig.height);
ctxO.drawImage(state.image, 0, 0, $.canvasOrig.width, $.canvasOrig.height);
}

function composeResult() {
if (!state.image || !state.finalMask) return;
const w = $.canvasRes.width, h = $.canvasRes.height;

ctxR.clearRect(0, 0, w, h);
ctxR.drawImage(state.image, 0, 0, w, h);
const img = ctxR.getImageData(0, 0, w, h);
const data = img.data;
for (let i = 0; i < w * h; i++) {
data[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, state.finalMask[i])) * 255);
}
ctxR.putImageData(img, 0, 0);

$.canvasMatte.hidden = !state.matteOn;
if (state.matteOn) {
const matte = ctxM.getImageData(0, 0, w, h);
const mdata = matte.data;
for (let i = 0; i < w * h; i++) {
const a = 1 - Math.max(0, Math.min(1, state.finalMask[i]));
mdata[i * 4 + 0] = 255;
mdata[i * 4 + 1] = 0;
mdata[i * 4 + 2] = 0;
mdata[i * 4 + 3] = Math.round(a * 128);
}
ctxM.putImageData(matte, 0, 0);
}
}

// Small-radius feather (box-blur style)
function featherMask(mask, w, h, radius) {
if (!radius || radius <= 0) return mask;
const r = Math.min(2, Math.max(0, radius));
const passes = Math.ceil(r * 2);
const out = new Float32Array(mask);
const tmp = new Float32Array(mask);

for (let p = 0; p < passes; p++) {
// Horizontal
for (let y = 0; y < h; y++) {
let acc = 0, cnt = 0;
for (let x = 0; x < w; x++) {
const i = y * w + x;
acc += out[i]; cnt++;
if (x >= 1) { acc -= out[y * w + (x - 1)]; cnt--; }
tmp[i] = acc / Math.max(1, cnt);
}
}
// Vertical
for (let x = 0; x < w; x++) {
let acc = 0, cnt = 0;
for (let y = 0; y < h; y++) {
const i = y * w + x;
acc += tmp[i]; cnt++;
if (y >= 1) { acc -= tmp[(y - 1) * w + x]; cnt--; }
out[i] = acc / Math.max(1, cnt);
}
}
}
return out;
}

function rebuildFinalMask() {
const w = $.canvasRes.width, h = $.canvasRes.height;
if (!state.aiMask) return;

const N = w * h;
const m = new Float32Array(N);
for (let i = 0; i < N; i++) {
let v = state.aiMask[i];
if (state.refineKeep) v += state.refineKeep[i] || 0;
if (state.refineRemove) v -= state.refineRemove[i] || 0;
m[i] = Math.max(0, Math.min(1, v));
}
state.finalMask = featherMask(m, w, h, state.feather);
composeResult();
}

// ---------- Refinement ----------

function paintRefine(clientX, clientY) {
const w = $.canvasRes.width, h = $.canvasRes.height;
if (w === 0 || h === 0) return;

const rect = $.canvasBrush.getBoundingClientRect();
const bx = Math.round(clientX - rect.left);
const by = Math.round(clientY - rect.top);
const r = Math.max(1, state.brushSize / 2);
const r2 = r * r;
const target = state.tool === 'keep' ? 'refineKeep' : 'refineRemove';
if (!state[target]) state[target] = new Float32Array(w * h);

for (let j = -r; j <= r; j++) {
for (let i = -r; i <= r; i++) {
const px = bx + i, py = by + j;
if (px < 0 || py < 0 || px >= w || py >= h) continue;
const d2 = i * i + j * j;
if (d2 <= r2) {
const idx = py * w + px;
const t = 1 - Math.sqrt(d2) / r; // soft falloff
state[target][idx] = Math.max(state[target][idx] || 0, t * 0.9);
}
}
}

// Visual ring
ctxB.clearRect(0, 0, w, h);
ctxB.beginPath();
ctxB.arc(bx, by, r, 0, Math.PI * 2);
ctxB.strokeStyle = state.tool === 'keep' ? '#34d399' : '#f87171';
ctxB.lineWidth = 2;
ctxB.stroke();

rebuildFinalMask();
}

function pushHistory() {
const snapshot = {
keep: state.refineKeep ? new Float32Array(state.refineKeep) : null,
remove: state.refineRemove ? new Float32Array(state.refineRemove) : null,
feather: state.feather
};
state.history = state.history.slice(0, state.histIndex + 1);
state.history.push(snapshot);
state.histIndex = state.history.length - 1;
}

function applyHistory(idx) {
const snap = state.history[idx];
state.refineKeep = snap.keep ? new Float32Array(snap.keep) : null;
state.refineRemove = snap.remove ? new Float32Array(snap.remove) : null;
state.feather = (snap.feather !== undefined && snap.feather !== null) ? snap.feather : 0;
$.feather.value = state.feather;
$.featherVal.textContent = String(state.feather);
rebuildFinalMask();
}

// ---------- Image loading ----------

function loadImage(file) {
return new Promise(function(resolve, reject) {
const url = URL.createObjectURL(file);
const img = new Image();
img.onload = function() { resolve(img); };
img.onerror = reject;
img.src = url;
});
}

function alphaToFloat32(imgData) {
const data = imgData.data, w = imgData.width, h = imgData.height;
const mask = new Float32Array(w * h);
for (let i = 0; i < w * h; i++) {
mask[i] = data[i * 4 + 3] / 255;
}
return mask;
}

// ---------- AI: Primary (IMG.LY) + Optional Fallback (MediaPipe) ----------

async function runPrimaryAI(imageBitmap, onProgress) {
if (!state.imglyRemover) throw new Error('Primary model not initialized');
const t0 = performance.now();
if (typeof onProgress === 'function') onProgress(10, 'Loading model…');

if (typeof onProgress === 'function') onProgress(40, 'Analyzing…');
const resultCanvas = await state.imglyRemover.removeBackground(imageBitmap, {
progress: function(p) {
const pct = Math.max(40, Math.min(70, Math.round(40 + p * 30)));
if (typeof onProgress === 'function') onProgress(pct, 'Analyzing…');
}
});

if (typeof onProgress === 'function') onProgress(75, 'Refining edges…');

const w = $.canvasRes.width, h = $.canvasRes.height;
const buf = document.createElement('canvas');
buf.width = w; buf.height = h;
const bctx = buf.getContext('2d');
bctx.drawImage(resultCanvas, 0, 0, w, h);
const img = bctx.getImageData(0, 0, w, h);
const mask = alphaToFloat32(img);

const t1 = performance.now();
state.timings.infer = Math.round(t1 - t0);

// Heuristic confidence
let sum = 0;
for (let i = 0; i < w * h; i++) sum += mask[i];
const mean = sum / (w * h);
const confidence = mean > 0.01 ? 0.9 : 0.3;
return { mask: mask, confidence: confidence };
}

async function runFallback(imageBitmap) {
if (!state.mpSegmenter) throw new Error('Fallback model not initialized');

const w = $.canvasRes.width, h = $.canvasRes.height;
const off = document.createElement('canvas');
off.width = w; off.height = h;
off.getContext('2d').drawImage(imageBitmap, 0, 0);

const result = await state.mpSegmenter.segment(off);

const mask = new Float32Array(w * h);
if (result && result.confidenceMasks && result.confidenceMasks.length > 0) {
const m = result.confidenceMasks; // ImageData-like
for (let i = 0; i < w * h; i++) mask[i] = m.data[i * 4] / 255;
} else if (result && result.categoryMask) {
const m = result.categoryMask;
for (let i = 0; i < w * h; i++) mask[i] = (m.data[i * 4] > 127) ? 1 : 0;
} else {
for (let i = 0; i < w * h; i++) mask[i] = 0;
}
return { mask: mask, confidence: 0.6 };
}

// ---------- Main AI flow ----------

async function doAI() {
if (!state.image) return;
$.btnAI.disabled = true;
$.aiStatus.textContent = 'Starting…';
$.aiBar.style.width = '0%';

drawOriginal();

const off = document.createElement('canvas');
off.width = $.canvasRes.width; off.height = $.canvasRes.height;
off.getContext('2d').drawImage(state.image, 0, 0, off.width, off.height);
const bitmap = await createImageBitmap(off);
state.imgBitmap = bitmap;

let result = null;
let primaryFailed = false;

try {
result = await runPrimaryAI(bitmap, function(p, label) {
$.aiBar.style.width = ${p}%;
$.aiStatus.textContent = label || 'Processing…';
});
} catch (e) {
console.warn('Primary AI failed', e);
primaryFailed = true;
}

if (!result || result.confidence < 0.55) {
if (state.mpSegmenter) {
try {
$.aiStatus.textContent = 'Primary low confidence. Using fallback…';
state.usedFallback = true;
$.badgeFallback.hidden = false;
result = await runFallback(bitmap);
$.dbgFb.textContent = 'Yes';
} catch (e) {
console.error('Fallback failed:', e);
$.aiStatus.textContent = primaryFailed
? 'All AI paths failed. Retry or reload.'
: 'Fallback failed. Primary result was low-confidence.';
$.btnAI.disabled = false;
return;
}
} else if (primaryFailed) {
$.aiStatus.textContent = 'Primary failed and fallback unavailable.';
$.btnAI.disabled = false;
return;
} else {
state.usedFallback = false;
$.dbgFb.textContent = 'No (fallback unavailable)';
}
} else {
state.usedFallback = false;
$.dbgFb.textContent = 'No';
}

state.aiMask = result.mask;
rebuildFinalMask();

$.aiBar.style.width = '100%';
$.aiStatus.textContent = state.usedFallback ? 'Fallback result ready' : 'AI result ready';
$.btnAI.disabled = false;
$.dbgInfer.textContent = ${state.timings.infer};
}

// ---------- Events ----------

function bindEvents() {
// Upload
if ($.btnChoose && $.fileInput) {
$.btnChoose.addEventListener('click', function(){ $.fileInput.click(); });
}
const upArea = document.getElementById('upload-area');
if (upArea) {
upArea.addEventListener('dragover', function(e){ e.preventDefault(); upArea.classList.add('drag'); });
upArea.addEventListener('dragleave', function(){ upArea.classList.remove('drag'); });
upArea.addEventListener('drop', async function(e){
e.preventDefault(); upArea.classList.remove('drag');
const files = e.dataTransfer && e.dataTransfer.files;
const f = files && files;
if (f) await handleFile(f);
});
}
if ($.fileInput) {
$.fileInput.addEventListener('change', async function(e){
const files = e.target && e.target.files;
const f = files && files;
if (f) await handleFile(f);
});
}

// AI
if ($.btnAI) $.btnAI.addEventListener('click', doAI);

// Tools
if ($.toolKeep) $.toolKeep.addEventListener('click', function(){
state.tool = 'keep';
$.toolKeep.classList.add('active'); if ($.toolRemove) $.toolRemove.classList.remove('active');
});
if ($.toolRemove) $.toolRemove.addEventListener('click', function(){
state.tool = 'remove';
$.toolRemove.classList.add('active'); if ($.toolKeep) $.toolKeep.classList.remove('active');
});
if ($.brushSize) $.brushSize.addEventListener('input', function(e){
state.brushSize = Number(e.target.value);
if ($.brushSizeVal) $.brushSizeVal.textContent = String(state.brushSize);
});
if ($.feather) $.feather.addEventListener('input', function(e){
state.feather = Number(e.target.value);
if ($.featherVal) $.featherVal.textContent = String(state.feather);
rebuildFinalMask();
});

// Brush drawing
if ($.canvasBrush) {
$.canvasBrush.addEventListener('pointerdown', function(e){
if (!state.aiMask) return;
state.isDrawing = true; pushHistory(); paintRefine(e.clientX, e.clientY);
});
$.canvasBrush.addEventListener('pointermove', function(e){
if (state.isDrawing) paintRefine(e.clientX, e.clientY);
});
}
window.addEventListener('pointerup', function(){
state.isDrawing = false;
ctxB.clearRect(0, 0, $.canvasBrush.width, $.canvasBrush.height);
});

// Undo/Redo
if ($.undo) $.undo.addEventListener('click', function(){
if (state.histIndex > 0) { state.histIndex--; applyHistory(state.histIndex); }
});
if ($.redo) $.redo.addEventListener('click', function(){
if (state.histIndex < state.history.length - 1) { state.histIndex++; applyHistory(state.histIndex); }
});

// Edge inspect
if ($.toggleMatte) $.toggleMatte.addEventListener('click', function(){
state.matteOn = !state.matteOn; composeResult();
});

// Download
if ($.download) $.download.addEventListener('click', function(){
if ($.canvasRes.width === 0 || $.canvasRes.height === 0) return;
const url = $.canvasRes.toDataURL('image/png');
const a = document.createElement('a');
a.href = url; a.download = 'cutout.png'; a.click();
});

// Resize
window.addEventListener('resize', function(){
if (state.image) {
fitCanvasToImage(state.image.naturalWidth, state.image.naturalHeight);
drawOriginal();
rebuildFinalMask();
}
});
}

async function handleFile(file) {
const img = await loadImage(file);
state.image = img;
state.usedFallback = false;
state.refineKeep = null; state.refineRemove = null;
state.history = []; state.histIndex = -1;
state.aiMask = null; state.finalMask = null;

if ($.fileMeta) $.fileMeta.textContent = ${file.name} — ${img.naturalWidth}×${img.naturalHeight};
fitCanvasToImage(img.naturalWidth, img.naturalHeight);
drawOriginal();

if ($.btnAI) $.btnAI.disabled = !state.modelReady;
if ($.aiStatus) $.aiStatus.textContent = state.modelReady ? 'Model ready' : 'Model preparing…';
}

// ---------- Preload models ----------

async function preloadPrimaryImgly() {
if (!window.backgroundRemoval) throw new Error('IMG.LY background-removal library not found. Include its script tag.');
const remover = await window.backgroundRemoval.createBackgroundRemoval({ debug: false });
// Warmup
const tiny = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(32, 32) : document.createElement('canvas');
tiny.width = 32; tiny.height = 32;
const tctx = tiny.getContext('2d');
tctx.fillStyle = '#000'; tctx.fillRect(0, 0, 32, 32);
await remover.removeBackground(tiny);
state.imglyRemover = remover;
}

async function preloadFallbackMediaPipe() {
try {
const visionNS = window && (window.vision || window.Vision);
if (!visionNS) return;
const ImageSegmenter = visionNS.ImageSegmenter;
const ImageSegmenterModelFiles = visionNS.ImageSegmenterModelFiles;
if (!ImageSegmenter || !ImageSegmenterModelFiles) return;
state.mpSegmenter = await ImageSegmenter.createFromModelPath(
ImageSegmenterModelFiles.selfieSegmentation
);
} catch (e) {
console.warn('MediaPipe fallback not available:', e);
}
}

async function preloadModel() {
const t0 = performance.now();
if ($.badgeModel) $.badgeModel.textContent = 'Model: Loading…';
if ($.aiStatus) $.aiStatus.textContent = 'Model preparing…';

try {
await preloadPrimaryImgly();
} catch (e) {
console.error('Primary model preload failed:', e);
}

await preloadFallbackMediaPipe();

const t1 = performance.now();
state.timings.load = Math.round(t1 - t0);

state.modelReady = !!state.imglyRemover;
if ($.dbgLoad) $.dbgLoad.textContent = ${state.timings.load};
if ($.badgeModel) $.badgeModel.textContent = state.modelReady ? 'Model: Ready' : 'Model: Not Ready';
if ($.aiStatus) $.aiStatus.textContent = state.modelReady ? 'Model ready' : 'Model not ready';
if ($.btnAI) $.btnAI.disabled = !state.modelReady;
}

function init() {
try {
bindEvents();
} catch (e) {
console.error('Bind events failed:', e);
}
preloadModel().catch(function(e){ console.error('Preload failed:', e); });
}

init();
