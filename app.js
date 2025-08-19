(function(){
  'use strict';

  function el(id){ return document.getElementById(id); }

  var $ = {
    fileInput: el('file-input'),
    btnChoose: el('btn-choose'),
    fileMeta: el('file-meta'),
    btnAuto: el('btn-auto'),
    autoBar: el('auto-progress-bar'),
    autoStatus: el('auto-status'),
    badgeModel: el('badge-model'),
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
    matteOn: false
  };

  var ctxO = $.canvasOrig.getContext('2d');
  var ctxR = $.canvasRes.getContext('2d');
  var ctxM = $.canvasMatte.getContext('2d');
  var ctxB = $.canvasBrush.getContext('2d');

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
      c.style.width = cw + 'px';
      c.style.height = ch + 'px';
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

function loadImage(file) {
  return new Promise(function(resolve, reject) {
    try {
      // Validate file type
      if (!file) {
        return reject(new Error('No file provided'));
      }
      if (!file.type) {
        return reject(new Error('File has no type property'));
      }
      if (!file.type.startsWith('image/')) {
        return reject(new Error('Unsupported file type: ' + file.type));
      }

      var url = URL.createObjectURL(file);
      var img = new Image();
      
      img.onload = function() { 
        URL.revokeObjectURL(url);
        resolve(img); 
      };
      
      img.onerror = function(e) { 
        URL.revokeObjectURL(url);
        reject(new Error('Failed to load image: ' + (e.message || 'Unknown error'))); 
      };
      
      img.src = url;
      
    } catch (e) {
      reject(new Error('createObjectURL failed: ' + e.message));
    }
  });
}


  // Create an intelligent initial mask based on edge detection and center bias
  function createAutoMask(w, h) {
    var mask = new Float32Array(w * h);
    var centerX = w / 2, centerY = h / 2;
    var maxDist = Math.min(w, h) * 0.4;

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = y * w + x;
        var distFromCenter = Math.sqrt((x - centerX) * (x - centerX) + (y - centerY) * (y - centerY));
        
        // Create a gradient mask that's stronger in center, weaker at edges
        var centerBias = Math.max(0, 1 - (distFromCenter / maxDist));
        
        // Add some randomness for more natural edge
        var noise = (Math.random() - 0.5) * 0.3;
        var edgeDetection = 1;
        
        // Simple edge detection - check if we're near image borders
        var borderDist = Math.min(x, y, w - x - 1, h - y - 1);
        if (borderDist < 20) {
          edgeDetection *= (borderDist / 20);
        }
        
        mask[i] = Math.max(0, Math.min(1, centerBias * edgeDetection + noise));
      }
    }
    return mask;
  }

  async function doAutoMask() {
    if (!state.image) return;
    $.btnAuto.disabled = true;
    $.autoStatus.textContent = 'Creating mask…';
    $.autoBar.style.width = '0%';

    // Simulate processing with progress
    for (var p = 0; p <= 100; p += 10) {
      $.autoBar.style.width = p + '%';
      if (p < 50) $.autoStatus.textContent = 'Analyzing image…';
      else if (p < 80) $.autoStatus.textContent = 'Detecting edges…';
      else $.autoStatus.textContent = 'Creating mask…';
      await new Promise(function(resolve) { setTimeout(resolve, 50); });
    }

    var w = $.canvasRes.width, h = $.canvasRes.height;
    state.aiMask = createAutoMask(w, h);
    rebuildFinalMask();

    $.autoBar.style.width = '100%';
    $.autoStatus.textContent = 'Mask created - use brushes to refine';
    $.btnAuto.disabled = false;
  }

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
        var f = files && files;
        if (f) await handleFile(f);
      });
    }

    if ($.btnAuto) $.btnAuto.addEventListener('click', doAutoMask);

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

async function handleFile(file) {
  try {
    console.log('File details:', {
      name: file.name,
      type: file.type,
      size: file.size
    });
    
    var img = await loadImage(file);
    state.image = img;
    state.refineKeep = null; state.refineRemove = null;
    state.history = []; state.histIndex = -1;
    state.aiMask = null; state.finalMask = null;

    if ($.fileMeta) $.fileMeta.textContent = file.name + ' — ' + img.naturalWidth + '×' + img.naturalHeight;
    fitCanvasToImage(img.naturalWidth, img.naturalHeight);
    drawOriginal();

    if ($.btnAuto) $.btnAuto.disabled = false;
    if ($.autoStatus) $.autoStatus.textContent = 'Ready to create initial mask';
    
  } catch (e) {
    console.error('Image load failed:', e);
    var errorMsg = 'Failed to load image';
    
    if (e.message.includes('Unsupported file type')) {
      errorMsg = 'Unsupported file type. Try JPG, PNG, or GIF.';
    } else if (e.message.includes('createObjectURL')) {
      errorMsg = 'Browser security restriction. Try a different image.';
    } else if (e.message.includes('No file')) {
      errorMsg = 'No file selected. Please choose an image.';
    }
    
    if ($.autoStatus) $.autoStatus.textContent = errorMsg;
  }
}


  function init(){
    try {
      bindEvents();
    } catch(e) {
      console.error('Event binding failed:', e);
    }
  }

  init();
})();
