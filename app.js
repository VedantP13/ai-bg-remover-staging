(function(){
  'use strict';

  function el(id){ return document.getElementById(id); }

  var $ = {
    fileInput: el('file-input'),
    btnChoose: el('btn-choose'),
    fileMeta: el('file-meta'),
    btnAI: el('btn-ai'),
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
    canvasBrush: el('canvas-brush')
  };

  var state = {
    image: null,
    imgBitmap: null,
    tool: 'keep',
    brushSize: 24,
    feather: 0,
    isDrawing: false,
    history: [],
    histIndex: -1,
    aiMask: null,
    refineKeep: null,
    refineRemove: null,
    finalMask: null,
    modelReady: false,
    usedFallback: false,
    timings: { load: 0, infer: 0 },
    matteOn: false,
    imglyRemover: null,
    mpSegmenter: null
  };

  var ctxO = $.canvasOrig.getContext('2d');
  var ctxR = $.canvasRes.getContext('2d');
  var ctxM = $.canvasMatte.getContext('2d');
  var ctxB = $.canvasBrush.getContext('2d');

  // ---------- Canvas and Rendering ----------

  function fitCanvasToImage(w, h) {
    var preview = document.querySelector('.preview');
    var split = document.querySelector('.split');
    var containerW = (preview && preview.clientWidth) ? preview.clientWidth : 1000;
    var containerH = (split && split.clientHeight) ? split.clientHeight : 600;
    var maxW = (containerW - 40) / 2;
    var maxH = containerH - 60;
    var scale = Math.min(maxW / w, maxH / h, 1);
    var cw = Math.max(1, Math.round(w * scale));
    var ch = Math.max(1, Math.round(h * scale));
    [$.canvasOrig, $.canvasRes, $.canvasMatte, $.canvasBrush].forEach(function(c){
      c.width = cw; c.height = ch;
      c.style.width = String(cw) + 'px';
      c.style.height = String(ch) + 'px';
    });
  }

  function drawOriginal() {
    if (!state.image) return;
    ctxO.clearRect(0, 0, $.canvasOrig.width, $.canvasOrig.height);
    ctxO.drawImage(state.image, 0, 0, $.canvasOrig.width, $.canvasOrig.height);
  }

  function composeResult() {
    if (!state.image || !state.finalMask) return;
    var w = $.canvasRes.width, h = $.canvasRes.height;

    ctxR.clearRect(0, 0, w, h);
    ctxR.drawImage(state.image, 0, 0, w, h);
    var img = ctxR.getImageData(0, 0, w, h);
    var data = img.data;
    for (var i = 0; i < w * h; i++) {
      data[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, state.finalMask[i])) * 255);
    }
    ctxR.putImageData(img, 0, 0);

    $.canvasMatte.hidden = !state.matteOn;
    if (state.matteOn) {
      var matte = ctxM.getImageData(0, 0, w, h);
      var mdata = matte.data;
      for (var j = 0; j < w * h; j++) {
        var a = 1 - Math.max(0, Math.min(1, state.finalMask[j]));
        mdata[j * 4 + 0] = 255;
        mdata[j * 4 + 1] = 0;
        mdata[j * 4 + 2] = 0;
        mdata[j * 4 + 3] = Math.round(a * 128);
      }
      ctxM.putImageData(matte, 0, 0);
    }
  }

  function featherMask(mask, w, h, radius) {
    if (!radius || radius <= 0) return mask;
    var r = Math.min(2, Math.max(0, radius));
    var passes = Math.ceil(r * 2);
    var out = new Float32Array(mask);
    var tmp = new Float32Array(mask);

    for (var p = 0; p < passes; p++) {
      for (var y = 0; y < h; y++) {
        var acc = 0, cnt = 0;
        for (var x = 0; x < w; x++) {
          var i = y * w + x;
          acc += out[i]; cnt++;
          if (x >= 1) { acc -= out[y * w + (x - 1)]; cnt--; }
          tmp[i] = acc / Math.max(1, cnt);
        }
      }
      for (var xx = 0; xx < w; xx++) {
        var acc2 = 0, cnt2 = 0;
        for (var yy = 0; yy < h; yy++) {
          var k = yy * w + xx;
          acc2 += tmp[k]; cnt2++;
          if (yy >= 1) { acc2 -= tmp[(yy - 1) * w + xx]; cnt2--; }
          out[k] = acc2 / Math.max(1, cnt2);
        }
      }
    }
    return out;
  }

  function rebuildFinalMask() {
    var w = $.canvasRes.width, h = $.canvasRes.height;
    if (!state.aiMask) return;
    var N = w * h;
    var m = new Float32Array(N);
    for (var i = 0; i < N; i++) {
      var v = state.aiMask[i];
      if (state.refineKeep) v += state.refineKeep[i] || 0;
      if (state.refineRemove) v -= state.refineRemove[i] || 0;
      m[i] = Math.max(0, Math.min(1, v));
    }
    state.finalMask = featherMask(m, w, h, state.feather);
    composeResult();
  }

  // ---------- Manual Refinement ----------

  function paintRefine(clientX, clientY) {
    var w = $.canvasRes.width, h = $.canvasRes.height;
    if (w === 0 || h === 0) return;

    var rect = $.canvasBrush.getBoundingClientRect();
    var bx = Math.round(clientX - rect.left);
    var by = Math.round(clientY - rect.top);
    var r = Math.max(1, state.brushSize / 2);
    var r2 = r * r;
    var target = state.tool === 'keep' ? 'refineKeep' : 'refineRemove';
    if (!state[target]) state[target] = new Float32Array(w * h);

    for (var j = -r; j <= r; j++) {
      for (var i = -r; i <= r; i++) {
        var px = bx + i, py = by + j;
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        var d2 = i * i + j * j;
        if (d2 <= r2) {
          var idx = py * w + px;
          var t = 1 - Math.sqrt(d2) / r;
          state[target][idx] = Math.max(state[target][idx] || 0, t * 0.9);
        }
      }
    }

    ctxB.clearRect(0, 0, w, h);
    ctxB.beginPath();
    ctxB.arc(bx, by, r, 0, Math.PI * 2);
    ctxB.strokeStyle = state.tool === 'keep' ? '#34d399' : '#f87171';
    ctxB.lineWidth = 2;
    ctxB.stroke();

    rebuildFinalMask();
  }

  function pushHistory() {
    var snapshot = {
      keep: state.refineKeep ? new Float32Array(state.refineKeep) : null,
      remove: state.refineRemove ? new Float32Array(state.refineRemove) : null,
      feather: state.feather
    };
    state.history = state.history.slice(0, state.histIndex + 1);
    state.history.push(snapshot);
    state.histIndex = state.history.length - 1;
  }

  function applyHistory(idx) {
    var snap = state.history[idx];
    state.refineKeep = snap.keep ? new Float32Array(snap.keep) : null;
    state.refineRemove = snap.remove ? new Float32Array(snap.remove) : null;
    state.feather = (snap.feather !== undefined && snap.feather !== null) ? snap.feather : 0;
    $.feather.value = state.feather;
    $.featherVal.textContent = String(state.feather);
    rebuildFinalMask();
  }

  // ---------- Image Loading ----------

  function loadImage(file) {
    return new Promise(function(resolve, reject){
      try {
        if (!file || typeof file !== 'object' || !('type' in file)) {
          return reject(new Error('Invalid file object'));
        }
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function(){ resolve(img); URL.revokeObjectURL(url); };
        img.onerror = function(e){ reject(e); URL.revokeObjectURL(url); };
        img.src = url;
      } catch (e) {
        reject(e);
      }
    });
  }

  function alphaToFloat32(imgData) {
    var data = imgData.data, w = imgData.width, h = imgData.height;
    var mask = new Float32Array(w * h);
    for (var i = 0; i < w * h; i++) {
      mask[i] = data[i * 4 + 3] / 255;
    }
    return mask;
  }

  // ---------- AI Processing (Modern IMG.LY API) ----------

  async function runPrimaryAI(imageBitmap, onProgress) {
    if (!state.imglyRemover) throw new Error('Primary model not initialized');
    var t0 = performance.now();
    if (typeof onProgress === 'function') onProgress(10, 'Initializing…');

    // Convert ImageBitmap to Image element for IMG.LY
    var canvas = document.createElement('canvas');
    canvas.width = imageBitmap.width;
    canvas.height = imageBitmap.height;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(imageBitmap, 0, 0);

    if (typeof onProgress === 'function') onProgress(30, 'Analyzing…');

    // Use modern IMG.LY API - returns blob
    var config = {
      debug: false,
      progress: function(key, current, total) {
        var percentage = Math.round((current / total) * 100);
        var progress = Math.min(80, 30 + (percentage * 0.5));
        if (typeof onProgress === 'function') onProgress(progress, 'Processing…');
      }
    };

    var resultBlob = await state.imglyRemover(canvas, config);
    
    if (typeof onProgress === 'function') onProgress(85, 'Converting result…');

    // Convert blob back to canvas to extract mask
    var resultImg = new Image();
    var blobUrl = URL.createObjectURL(resultBlob);
    resultImg.src = blobUrl;

    await new Promise(function(resolve, reject) {
      resultImg.onload = resolve;
      resultImg.onerror = reject;
    });

    var w = $.canvasRes.width, h = $.canvasRes.height;
    var buf = document.createElement('canvas');
    buf.width = w; buf.height = h;
    var bctx = buf.getContext('2d');
    bctx.drawImage(resultImg, 0, 0, w, h);
    var img = bctx.getImageData(0, 0, w, h);
    var mask = alphaToFloat32(img);

    URL.revokeObjectURL(blobUrl);

    var t1 = performance.now();
    state.timings.infer = Math.round(t1 - t0);

    var sum = 0;
    for (var i = 0; i < w * h; i++) sum += mask[i];
    var mean = sum / (w * h);
    var confidence = mean > 0.01 ? 0.95 : 0.3;
    return { mask: mask, confidence: confidence };
  }

  async function runFallback(imageBitmap) {
    if (!state.mpSegmenter) throw new Error('Fallback model not initialized');
    
    var w = $.canvasRes.width, h = $.canvasRes.height;
    var off = document.createElement('canvas');
    off.width = w; off.height = h;
    off.getContext('2d').drawImage(imageBitmap, 0, 0);

    var result = await state.mpSegmenter.segment(off);
    var mask = new Float32Array(w * h);
    
    if (result && result.confidenceMasks && result.confidenceMasks.length > 0) {
      var m = result.confidenceMasks[0];
      for (var i = 0; i < w * h; i++) mask[i] = m.data[i * 4] / 255;
    } else if (result && result.categoryMask) {
      var m2 = result.categoryMask;
      for (var k = 0; k < w * h; k++) mask[k] = (m2.data[k * 4] > 127) ? 1 : 0;
    } else {
      for (var z = 0; z < w * h; z++) mask[z] = 0;
    }
    return { mask: mask, confidence: 0.6 };
  }

  // ---------- Main AI Flow ----------

  async function doAI() {
    if (!state.image) return;
    $.btnAI.disabled = true;
    $.aiStatus.textContent = 'Starting…';
    $.aiBar.style.width = '0%';

    drawOriginal();

    var off = document.createElement('canvas');
    off.width = $.canvasRes.width; off.height = $.canvasRes.height;
    off.getContext('2d').drawImage(state.image, 0, 0, off.width, off.height);
    var bitmap = await createImageBitmap(off);
    state.imgBitmap = bitmap;

    var result = null;
    var primaryFailed = false;

    try {
      result = await runPrimaryAI(bitmap, function(p, label){
        $.aiBar.style.width = String(p) + '%';
        $.aiStatus.textContent = label || 'Processing…';
      });
    } catch (e) {
      console.warn('Primary AI failed:', e);
      primaryFailed = true;
    }

    if (!result || result.confidence < 0.4) {
      if (state.mpSegmenter) {
        try {
          $.aiStatus.textContent = 'Primary failed. Using fallback…';
          state.usedFallback = true;
          $.badgeFallback.hidden = false;
          result = await runFallback(bitmap);
          $.dbgFb.textContent = 'Yes';
        } catch (e2) {
          console.error('Fallback failed:', e2);
          $.aiStatus.textContent = 'All AI methods failed. Try another image.';
          $.btnAI.disabled = false;
          return;
        }
      } else if (primaryFailed) {
        $.aiStatus.textContent = 'AI processing failed. Check console for details.';
        $.btnAI.disabled = false;
        return;
      } else {
        // Accept low-confidence result
        state.usedFallback = false;
        $.dbgFb.textContent = 'No';
      }
    } else {
      state.usedFallback = false;
      $.dbgFb.textContent = 'No';
    }

    state.aiMask = result.mask;
    rebuildFinalMask();

    $.aiBar.style.width = '100%';
    $.aiStatus.textContent = state.usedFallback ? 'Fallback complete' : 'AI processing complete';
    $.btnAI.disabled = false;
    $.dbgInfer.textContent = String(state.timings.infer);
  }

  // ---------- Event Binding ----------

  function bindEvents() {
    if ($.btnChoose && $.fileInput) {
      $.btnChoose.addEventListener('click', function(){ $.fileInput.click(); });
    }
    
    var upArea = document.getElementById('upload-area');
    if (upArea) {
      upArea.addEventListener('dragover', function(e){ e.preventDefault(); upArea.classList.add('drag'); });
      upArea.addEventListener('dragleave', function(){ upArea.classList.remove('drag'); });
      upArea.addEventListener('drop', async function(e){
        e.preventDefault(); upArea.classList.remove('drag');
        var files = e.dataTransfer && e.dataTransfer.files;
        var f = files && files[0];
        if (f) await handleFile(f);
      });
    }
    
    if ($.fileInput) {
      $.fileInput.addEventListener('change', async function(e){
        var files = e.target && e.target.files;
        var f = files && files[0];
        if (f) await handleFile(f);
      });
    }

    if ($.btnAI) $.btnAI.addEventListener('click', doAI);

    if ($.toolKeep) $.toolKeep.addEventListener('click', function(){
      state.tool = 'keep';
      $.toolKeep.classList.add('active');
      if ($.toolRemove) $.toolRemove.classList.remove('active');
    });
    
    if ($.toolRemove) $.toolRemove.addEventListener('click', function(){
      state.tool = 'remove';
      $.toolRemove.classList.add('active');
      if ($.toolKeep) $.toolKeep.classList.remove('active');
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

    if ($.undo) $.undo.addEventListener('click', function(){
      if (state.histIndex > 0) { state.histIndex--; applyHistory(state.histIndex); }
    });
    
    if ($.redo) $.redo.addEventListener('click', function(){
      if (state.histIndex < state.history.length - 1) { state.histIndex++; applyHistory(state.histIndex); }
    });

    if ($.toggleMatte) $.toggleMatte.addEventListener('click', function(){
      state.matteOn = !state.matteOn; composeResult();
    });

    if ($.download) $.download.addEventListener('click', function(){
      if ($.canvasRes.width === 0 || $.canvasRes.height === 0) return;
      var url = $.canvasRes.toDataURL('image/png');
      var a = document.createElement('a');
      a.href = url; a.download = 'cutout.png'; a.click();
    });

    window.addEventListener('resize', function(){
      if (state.image) {
        fitCanvasToImage(state.image.naturalWidth, state.image.naturalHeight);
        drawOriginal();
        rebuildFinalMask();
      }
    });
  }

  // ---------- File Handling ----------

  async function handleFile(file) {
    try {
      var img = await loadImage(file);
      state.image = img;
      state.usedFallback = false;
      state.refineKeep = null; state.refineRemove = null;
      state.history = []; state.histIndex = -1;
      state.aiMask = null; state.finalMask = null;

      if ($.fileMeta) $.fileMeta.textContent = file.name + ' — ' + img.naturalWidth + '×' + img.naturalHeight;
      fitCanvasToImage(img.naturalWidth, img.naturalHeight);
      drawOriginal();

      if ($.btnAI) $.btnAI.disabled = !state.modelReady;
      if ($.aiStatus) $.aiStatus.textContent = state.modelReady ? 'Model ready' : 'Model loading…';
    } catch (e) {
      console.error('Failed to load image:', e);
      if ($.aiStatus) $.aiStatus.textContent = 'Image load failed. Try another file.';
    }
  }

  // ---------- Model Preloading ----------

  async function preloadPrimaryImgly() {
    try {
      // Wait for ES module to be available
      for (var i = 0; i < 20; i++) {
        if (window.imglyRemoveBackground) break;
        await new Promise(function(resolve) { setTimeout(resolve, 250); });
      }
      
      if (!window.imglyRemoveBackground) {
        throw new Error('IMG.LY module failed to load after 5 seconds');
      }
      
      state.imglyRemover = window.imglyRemoveBackground;
      
    } catch (e) {
      console.error('IMG.LY preload failed:', e);
      state.imglyRemover = null;
      if ($.badgeModel) $.badgeModel.textContent = 'Model: Load Failed';
      if ($.aiStatus) $.aiStatus.textContent = 'AI unavailable: ' + e.message;
    }
  }

  async function preloadFallbackMediaPipe() {
    try {
      var visionNS = window && (window.vision || window.Vision);
      if (!visionNS) return;
      var ImageSegmenter = visionNS.ImageSegmenter;
      var ImageSegmenterModelFiles = visionNS.ImageSegmenterModelFiles;
      if (!ImageSegmenter || !ImageSegmenterModelFiles) return;
      state.mpSegmenter = await ImageSegmenter.createFromModelPath(
        ImageSegmenterModelFiles.selfieSegmentation
      );
    } catch (e) {
      console.warn('MediaPipe fallback not available:', e);
    }
  }

  async function preloadModel() {
    var t0 = performance.now();
    if ($.badgeModel) $.badgeModel.textContent = 'Model: Loading…';
    if ($.aiStatus) $.aiStatus.textContent = 'Loading AI model…';

    await preloadPrimaryImgly();
    await preloadFallbackMediaPipe();

    var t1 = performance.now();
    state.timings.load = Math.round(t1 - t0);

    state.modelReady = !!state.imglyRemover;
    if ($.dbgLoad) $.dbgLoad.textContent = String(state.timings.load);
    if ($.badgeModel) $.badgeModel.textContent = state.modelReady ? 'Model: Ready' : 'Model: Failed';
    if ($.aiStatus) $.aiStatus.textContent = state.modelReady ? 'AI model ready' : 'AI model failed to load';
    if ($.btnAI) $.btnAI.disabled = !state.modelReady;
  }

  // ---------- Initialization ----------

  function init(){
    try {
      bindEvents();
    } catch(e) {
      console.error('Event binding failed:', e);
    }
    preloadModel().catch(function(e){ console.error('Model preload failed:', e); });
  }

  init();
})();
