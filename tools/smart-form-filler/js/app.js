/* =========================================================================
   Smart Form Filler — Pragati Telecom
   ---------------------------------------------------------------------
   Detection priority (cheapest & most reliable first):
     1) AcroForm widgets already embedded in the PDF (page.getAnnotations)
        -> exact positions, zero cost, zero guessing. Most reliable form
           we've seen (Annapurna, PMJAY) do NOT have these, but some do.
     2) Gemini Vision (via a small Cloudflare Worker you deploy yourself,
        see README) -> the model returns a bounding box (box_2d, 0-1000
        normalized) for every field it sees, so placement is real, not
        guessed from dark-pixel lines or a fixed label list.
     3) Manual "আঁকুন" (Draw) tool -> always available, always accurate,
        because the user places the box themselves.

   One coordinate system everywhere: every field stores xNorm/yNorm/
   wNorm/hNorm (0..1, relative to the UNSCALED page size). Screen
   preview, the print view and the exported PDF all convert from that
   same normalized value using the same formula, so what you see is
   always what you get.
   ========================================================================= */

(function () {
  'use strict';

  // ---- Global constants (single source of truth for scale math) --------
  var RENDER_SCALE = 1.5;           // on-screen canvas render scale
  var GEMINI_SCALE = 2.0;           // sharper offscreen render sent to Gemini
  var MM_TO_POINTS = 72 / 25.4;     // 1 mm in PDF points

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $all = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  // ---- State --------------------------------------------------------------
  var STATE = {
    fileName: 'ফর্ম',
    fileType: null,     // 'pdf' | 'image'
    pdfDoc: null,
    imageElement: null,
    currentPage: 1,
    totalPages: 1,
    zoom: 1.0,
    mode: 'fill',       // 'fill' | 'draw' | 'edit'
    activeTab: 'fields',
    fields: [],          // {id, page, label, type, xNorm,yNorm,wNorm,hNorm, value, source, needsReview, confidence}
    selectedFieldId: null,
    hoveredFieldId: null,
    pageDims: {},        // pageNum -> {width, height} UNSCALED (viewport scale 1.0)
    printerOffsetMm: { x: 0, y: 0 },
    font: { family: "'Noto Sans Bengali','Inter',sans-serif", size: 12, color: '#0b2f6b', weight: '600', checkSymbol: '✓' },
    workerUrl: localStorage.getItem('sff_worker_url') || '/api/form-filler-ai'
  };

  // ---- Small UI helpers -----------------------------------------------
  var toastEl = $('#toast');
  var toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 3200);
  }
  var busyEl = $('#busyBanner'), busyText = $('#busyText');
  function setBusy(on, text) {
    busyEl.hidden = !on;
    if (text) busyText.textContent = text;
    clearTimeout(busyWatchdog);
    if (on) {
      busyWatchdog = setTimeout(function () {
        busyEl.hidden = true;
        toast('অনেকক্ষণ ধরে কোনো সাড়া পাওয়া যাচ্ছে না, তাই থামিয়ে দেওয়া হলো। আবার চেষ্টা করুন বা "আঁকুন" মোডে হাতে ফিল্ড বসান।');
      }, WATCHDOG_MS);
    }
  }

  function uid(prefix) {
    return prefix + '_' + Math.random().toString(36).slice(2, 9);
  }

  // pdf.js worker
  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  // ---- Busy-banner watchdog: NEVER let the spinner spin forever ---------
  // Bug fixed: if a render/fetch call silently hangs (slow network, a
  // Worker URL that never responds, etc.) the old code had nothing that
  // would ever turn the banner back off, so it just "spins forever" with
  // no explanation. Every setBusy(true, ...) now auto-clears itself and
  // shows an error toast if it is not turned off within WATCHDOG_MS.
  var WATCHDOG_MS = 20000;
  var busyWatchdog = null;

  // ---- Promise timeout helper --------------------------------------------
  // Bug fixed: the Gemini fetch() had no timeout/AbortController, so a
  // slow or unreachable Worker URL would hang the "Gemini দিয়ে ফর্ম পড়া
  // হচ্ছে..." spinner indefinitely.
  function withTimeout(promise, ms, message) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, ms);
    return Promise.race([
      promise(controller.signal),
      new Promise(function (_, reject) {
        controller.signal.addEventListener('abort', function () {
          reject(new Error(message || ('সময় শেষ (' + Math.round(ms / 1000) + ' সেকেন্ড)।')));
        });
      })
    ]).finally(function () { clearTimeout(timer); });
  }

  // =========================================================================
  // FILE LOADING
  // =========================================================================
  function handleFile(file) {
    var isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    var isImage = /^image\//.test(file.type);
    if (!isPdf && !isImage) {
      toast('শুধু PDF বা ছবি (PNG/JPG) আপলোড করা যাবে।');
      return;
    }

    setBusy(true, 'ফাইল লোড হচ্ছে...');
    STATE.fileName = file.name;
    STATE.fields = [];
    STATE.pageDims = {};
    STATE.currentPage = 1;
    $('#emptyState').style.display = 'none';
    $('#stageInner').style.display = 'block';

    if (isPdf) {
      file.arrayBuffer().then(function (buf) {
        return window.pdfjsLib.getDocument({ data: buf }).promise;
      }).then(function (doc) {
        STATE.fileType = 'pdf';
        STATE.pdfDoc = doc;
        STATE.imageElement = null;
        STATE.totalPages = doc.numPages;
        return renderPage();
      }).then(function () {
        setBusy(false);
        return detectFields();
      }).catch(function (err) {
        console.error(err);
        setBusy(false);
        toast('ফাইল খুলতে সমস্যা হয়েছে: ' + err.message);
      });
    } else {
      var reader = new FileReader();
      reader.onload = function (e) {
        var img = new Image();
        img.onload = function () {
          STATE.fileType = 'image';
          STATE.pdfDoc = null;
          STATE.imageElement = img;
          STATE.totalPages = 1;
          STATE.pageDims[1] = { width: img.naturalWidth, height: img.naturalHeight };
          renderPage().then(function () {
            setBusy(false);
            detectFields();
          });
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    }
  }

  // =========================================================================
  // PAGE RENDERING
  // =========================================================================
  var canvas = $('#pageCanvas');
  var ctx = canvas.getContext('2d', { alpha: false });
  var overlay = $('#overlay');
  var stageInner = $('#stageInner');

  // Bug fixed: the old code called page.render() on the shared on-screen
  // canvas with nothing tracking the in-flight RenderTask. pdf.js refuses
  // to start a second render on a canvas that's still mid-render and
  // throws "Cannot use the same canvas during multiple render() operations".
  // That happened whenever a page-change fired while the previous page
  // was still rendering (e.g. quick clicks on ◀/▶, or detectFieldsIfEmpty
  // re-rendering while a Gemini call was still in flight) — the promise
  // rejected, nothing caught it on the nav buttons, and the app looked
  // "stuck" on page 1 forever. We now cancel any previous task first.
  var currentRenderTask = null;

  function renderPage() {
    if (STATE.fileType === 'pdf') {
      var thisPage = STATE.currentPage;
      var cancelPrev = currentRenderTask ? currentRenderTask.cancel() : null;
      return Promise.resolve(cancelPrev).catch(function () {}).then(function () {
        return STATE.pdfDoc.getPage(thisPage);
      }).then(function (page) {
        var unscaled = page.getViewport({ scale: 1.0 });
        STATE.pageDims[thisPage] = { width: unscaled.width, height: unscaled.height };

        var viewport = page.getViewport({ scale: RENDER_SCALE });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);

        currentRenderTask = page.render({ canvasContext: ctx, viewport: viewport });
        return currentRenderTask.promise;
      }).then(function () {
        currentRenderTask = null;
        applyZoom();
        renderOverlay();
        updateToolbar();
      }).catch(function (err) {
        // A cancelled render throws a RenderingCancelledException by design —
        // that's not a real error, just ignore it and let the newer render win.
        if (err && err.name === 'RenderingCancelledException') return;
        throw err;
      });
    } else if (STATE.fileType === 'image') {
      var img = STATE.imageElement;
      canvas.width = Math.floor(img.naturalWidth);
      canvas.height = Math.floor(img.naturalHeight);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      applyZoom();
      renderOverlay();
      updateToolbar();
      return Promise.resolve();
    }
    return Promise.resolve();
  }

  function applyZoom() {
    var w = canvas.width * STATE.zoom;
    var h = canvas.height * STATE.zoom;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    overlay.style.width = w + 'px';
    overlay.style.height = h + 'px';
    stageInner.style.width = w + 'px';
    stageInner.style.height = h + 'px';
    $('#zoomLabel').textContent = Math.round(STATE.zoom * 100) + '%';
  }

  function setZoom(z) {
    STATE.zoom = Math.max(0.4, Math.min(3, Math.round(z * 100) / 100));
    applyZoom();
    renderOverlay();
  }

  function updateToolbar() {
    $('#pageLabel').textContent = 'পাতা ' + STATE.currentPage + ' / ' + STATE.totalPages;
    $('#btnPrevPage').disabled = STATE.currentPage <= 1;
    $('#btnNextPage').disabled = STATE.currentPage >= STATE.totalPages;
  }

  // The render scale actually baked into the CURRENT on-screen canvas,
  // relative to the unscaled page. Used to keep offset math consistent.
  function currentCanvasScale() {
    var dims = STATE.pageDims[STATE.currentPage];
    if (!dims || !dims.width) return RENDER_SCALE;
    return canvas.width / dims.width;
  }

  function offsetInCanvasPx(scaleUsed) {
    return {
      x: STATE.printerOffsetMm.x * MM_TO_POINTS * scaleUsed,
      y: STATE.printerOffsetMm.y * MM_TO_POINTS * scaleUsed
    };
  }

  // =========================================================================
  // FIELD DETECTION — AcroForm first, Gemini Vision fallback
  // =========================================================================
  function detectFields() {
    if (STATE.fileType === 'pdf') {
      return detectAcroFormFields().then(function (acroFields) {
        if (acroFields.length > 0) {
          replacePageFields(acroFields);
          toast('AcroForm থেকে ' + acroFields.length + 'টি ফিল্ড সরাসরি পাওয়া গেছে (নির্ভুল পজিশন)।');
          return;
        }
        return detectViaGemini();
      });
    } else {
      return detectViaGemini();
    }
  }

  // ---- 1) AcroForm (interactive PDF fields, if the form has any) --------
  function detectAcroFormFields() {
    return STATE.pdfDoc.getPage(STATE.currentPage).then(function (page) {
      return page.getAnnotations({ intent: 'display' }).then(function (annots) {
        var vp1 = page.getViewport({ scale: 1.0 });
        var out = [];

        annots.forEach(function (a, i) {
          if (a.subtype !== 'Widget' || a.hidden) return;
          if (a.fieldType === 'Sig') return; // signature widgets aren't text-fillable here

          var rect = vp1.convertToViewportRectangle(a.rect);
          var x1 = Math.min(rect[0], rect[2]), x2 = Math.max(rect[0], rect[2]);
          var y1 = Math.min(rect[1], rect[3]), y2 = Math.max(rect[1], rect[3]);

          var type = 'text';
          if (a.fieldType === 'Btn' && (a.checkBox || a.radioButton)) type = 'checkbox';
          else if (a.fieldType === 'Tx' && a.multiLine) type = 'textarea';
          else if (a.fieldType === 'Ch') type = 'text';

          out.push({
            id: uid('af'),
            page: STATE.currentPage,
            label: a.fieldName || ('ফিল্ড ' + (i + 1)),
            type: type,
            xNorm: x1 / vp1.width,
            yNorm: y1 / vp1.height,
            wNorm: Math.max(0.01, (x2 - x1) / vp1.width),
            hNorm: Math.max(0.01, (y2 - y1) / vp1.height),
            value: type === 'checkbox' ? false : '',
            source: 'acroform',
            needsReview: false,
            confidence: 1.0
          });
        });
        return out;
      });
    });
  }

  // ---- 2) Gemini Vision fallback (for flat/print-and-fill PDFs & images) -
  function detectViaGemini() {
    if (!STATE.workerUrl) {
      toast('এই ফর্মে AcroForm ফিল্ড নেই এবং কোনো Gemini Worker URL সেট করা নেই। সেটিংসে URL বসান, অথবা "আঁকুন" মোডে হাতে ফিল্ড বসান।');
      return Promise.resolve();
    }

    setBusy(true, 'Gemini দিয়ে ফর্ম পড়া হচ্ছে...');

    var dims = STATE.pageDims[STATE.currentPage] || { width: canvas.width, height: canvas.height };

    return renderOffscreenForGemini(dims).then(function (dataUrl) {
      var base64 = dataUrl.split(',')[1];
      // Bug fixed: no timeout here before — an unreachable/slow Worker URL
      // made the "Gemini দিয়ে ফর্ম পড়া হচ্ছে..." banner spin forever with
      // no way out except reloading the page.
      return withTimeout(function (signal) {
        return fetch(STATE.workerUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: base64 }),
          signal: signal
        });
      }, 25000, 'Worker থেকে ২৫ সেকেন্ডে কোনো সাড়া আসেনি। URL ঠিক আছে কিনা এবং Worker ডিপ্লয় করা আছে কিনা দেখুন।');
    }).then(function (res) { return res.json(); })
      .then(function (json) {
        setBusy(false);
        if (!json.success) {
          toast('Gemini এরর: ' + (json.error || 'অজানা সমস্যা'));
          return;
        }
        var arr;
        try {
          arr = typeof json.data === 'string' ? JSON.parse(json.data) : json.data;
        } catch (e) {
          toast('Gemini থেকে বৈধ JSON পাওয়া যায়নি।');
          return;
        }
        if (!Array.isArray(arr)) arr = [];

        var fields = arr.map(function (item) {
          var box = item.box_2d || [0, 0, 40, 300];
          var ymin = box[0], xmin = box[1], ymax = box[2], xmax = box[3];
          return {
            id: uid('gm'),
            page: STATE.currentPage,
            label: item.label || 'ফিল্ড',
            type: item.type || 'text',
            xNorm: Math.max(0, xmin / 1000),
            yNorm: Math.max(0, ymin / 1000),
            wNorm: Math.max(0.01, (xmax - xmin) / 1000),
            hNorm: Math.max(0.01, (ymax - ymin) / 1000),
            value: item.type === 'checkbox' ? false : (item.value || ''),
            source: 'gemini',
            needsReview: true,
            confidence: 0.8
          };
        });

        replacePageFields(fields);
        toast('Gemini ' + fields.length + 'টি ফিল্ড খুঁজে পেয়েছে। যাচাই ট্যাবে গিয়ে চেক করে নিন।');
      }).catch(function (err) {
        setBusy(false);
        console.error(err);
        toast('Gemini কল ব্যর্থ হয়েছে: ' + err.message);
      });
  }

  // Render a sharper standalone copy of the current page for the Gemini call,
  // independent of the on-screen RENDER_SCALE.
  function renderOffscreenForGemini(dims) {
    var off = document.createElement('canvas');
    var octx = off.getContext('2d', { alpha: false });

    if (STATE.fileType === 'pdf') {
      return STATE.pdfDoc.getPage(STATE.currentPage).then(function (page) {
        var vp = page.getViewport({ scale: GEMINI_SCALE });
        off.width = Math.floor(vp.width);
        off.height = Math.floor(vp.height);
        return page.render({ canvasContext: octx, viewport: vp }).promise;
      }).then(function () {
        return off.toDataURL('image/jpeg', 0.85);
      });
    } else {
      off.width = dims.width;
      off.height = dims.height;
      octx.fillStyle = '#fff';
      octx.fillRect(0, 0, off.width, off.height);
      octx.drawImage(STATE.imageElement, 0, 0, off.width, off.height);
      return Promise.resolve(off.toDataURL('image/jpeg', 0.85));
    }
  }

  // =========================================================================
  // FIELD CRUD
  // =========================================================================
  function getPageFields(pageNum) {
    pageNum = pageNum || STATE.currentPage;
    return STATE.fields.filter(function (f) { return f.page === pageNum; });
  }

  function replacePageFields(newFields) {
    STATE.fields = STATE.fields.filter(function (f) { return f.page !== STATE.currentPage; }).concat(newFields);
    STATE.selectedFieldId = null;
    renderOverlay();
    renderFieldsList();
    renderReviewList();
  }

  function addField(data) {
    var f = Object.assign({
      id: uid('m'),
      page: STATE.currentPage,
      label: 'নতুন ফিল্ড',
      type: 'text',
      xNorm: 0.1, yNorm: 0.1, wNorm: 0.25, hNorm: 0.03,
      value: '',
      source: 'manual',
      needsReview: false,
      confidence: 1.0
    }, data);
    STATE.fields.push(f);
    renderOverlay();
    renderFieldsList();
    return f;
  }

  function updateField(id, updates) {
    var f = STATE.fields.find(function (x) { return x.id === id; });
    if (!f) return;
    Object.assign(f, updates);
    renderOverlay();
  }

  function removeField(id) {
    STATE.fields = STATE.fields.filter(function (f) { return f.id !== id; });
    if (STATE.selectedFieldId === id) STATE.selectedFieldId = null;
    renderOverlay();
    renderFieldsList();
    renderReviewList();
  }

  // =========================================================================
  // OVERLAY RENDERING (screen preview) — same formula export/print will use
  // =========================================================================
  function renderOverlay() {
    overlay.innerHTML = '';
    var scaleUsed = currentCanvasScale();
    var offset = offsetInCanvasPx(scaleUsed);
    var fields = getPageFields();

    fields.forEach(function (f) {
      var leftPx = (f.xNorm * canvas.width + offset.x) * STATE.zoom;
      var topPx = (f.yNorm * canvas.height + offset.y) * STATE.zoom;
      var wPx = (f.wNorm * canvas.width) * STATE.zoom;
      var hPx = (f.hNorm * canvas.height) * STATE.zoom;

      var box = document.createElement('div');
      box.className = 'field-box ' + STATE.mode + '-mode ' + f.type + '-type';
      if (f.needsReview) box.classList.add('needs-review');
      if (STATE.selectedFieldId === f.id) box.classList.add('is-selected');
      if (STATE.hoveredFieldId === f.id) box.classList.add('is-hovered');
      box.style.left = leftPx + 'px';
      box.style.top = topPx + 'px';
      box.style.width = wPx + 'px';
      box.style.height = hPx + 'px';
      box.dataset.fieldId = f.id;

      if (STATE.mode === 'fill') {
        if (f.type === 'checkbox') {
          if (f.value) {
            var chk = document.createElement('span');
            chk.className = 'overlay-check';
            chk.style.fontSize = Math.max(10, Math.round(hPx * 0.85)) + 'px';
            chk.style.color = STATE.font.color;
            chk.textContent = STATE.font.checkSymbol;
            box.appendChild(chk);
          } else if (STATE.hoveredFieldId === f.id) {
            // Bug fixed: checkboxes never showed a hover hint before
            // (only text fields did), so hovering an empty checkbox on
            // the canvas gave no clue what it was or what a click would do.
            var chint = document.createElement('span');
            chint.className = 'overlay-hint';
            chint.textContent = f.label;
            box.appendChild(chint);
          }
        } else if (f.value) {
          var span = document.createElement('span');
          span.className = 'overlay-text';
          span.style.fontFamily = STATE.font.family;
          span.style.fontWeight = STATE.font.weight;
          span.style.color = STATE.font.color;
          span.style.fontSize = Math.round(STATE.font.size * scaleUsed * STATE.zoom) + 'px';
          span.textContent = f.value;
          box.appendChild(span);
        } else if (STATE.hoveredFieldId === f.id) {
          var hint = document.createElement('span');
          hint.className = 'overlay-hint';
          hint.textContent = f.label;
          box.appendChild(hint);
        }
      } else {
        var hint2 = document.createElement('span');
        hint2.className = 'overlay-hint';
        hint2.textContent = f.label;
        box.appendChild(hint2);

        if (STATE.mode === 'edit' && STATE.selectedFieldId === f.id) {
          ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(function (dir) {
            var h = document.createElement('div');
            h.className = 'resize-handle handle-' + dir;
            h.dataset.handle = dir;
            box.appendChild(h);
          });
        }
      }

      overlay.appendChild(box);
    });
  }

  // =========================================================================
  // HOVER HIGHLIGHT + TOOLTIP — shows exactly which field the mouse is over
  // and what filling it will do, in every mode (fill / draw / edit).
  // =========================================================================
  var hoverTip = $('#hoverTip');

  function symbolPreview(f) {
    if (f.type !== 'checkbox') return null;
    return STATE.font.checkSymbol;
  }

  function hoverTipText(f) {
    if (f.type === 'checkbox') {
      var sym = symbolPreview(f);
      return (f.value ? 'ক্লিক করলে "' + sym + '" উঠে যাবে (আন-টিক)' : 'ক্লিক করলে "' + sym + '" বসবে') + ' — ' + f.label;
    }
    if (f.type === 'textarea') return '✏️ এখানে লিখুন — ' + f.label;
    return '✏️ এখানে লিখুন — ' + f.label;
  }

  function showHoverTip(fieldEl, f, clientX, clientY) {
    STATE.hoveredFieldId = f.id;
    fieldEl.classList.add('is-hovered');
    hoverTip.textContent = hoverTipText(f);
    hoverTip.hidden = false;
    positionHoverTip(clientX, clientY);
  }

  function positionHoverTip(clientX, clientY) {
    if (hoverTip.hidden) return;
    var pad = 14;
    var ttW = hoverTip.offsetWidth || 160;
    var ttH = hoverTip.offsetHeight || 28;
    var left = clientX + pad;
    var top = clientY + pad;
    if (left + ttW > window.innerWidth - 8) left = clientX - ttW - pad;
    if (top + ttH > window.innerHeight - 8) top = clientY - ttH - pad;
    hoverTip.style.left = left + 'px';
    hoverTip.style.top = top + 'px';
  }

  function hideHoverTip() {
    if (STATE.hoveredFieldId !== null) {
      var prevEl = overlay.querySelector('[data-field-id="' + STATE.hoveredFieldId + '"]');
      if (prevEl) prevEl.classList.remove('is-hovered');
    }
    STATE.hoveredFieldId = null;
    hoverTip.hidden = true;
  }

  overlay.addEventListener('mouseover', function (e) {
    var target = e.target.closest('.field-box');
    if (!target || dragging || resizing || drawing) return;
    var f = STATE.fields.find(function (x) { return x.id === target.dataset.fieldId; });
    if (!f) return;
    showHoverTip(target, f, e.clientX, e.clientY);
  });

  overlay.addEventListener('mousemove', function (e) {
    if (!hoverTip.hidden) positionHoverTip(e.clientX, e.clientY);
  });

  overlay.addEventListener('mouseout', function (e) {
    var target = e.target.closest('.field-box');
    if (!target) return;
    var toEl = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('.field-box') : null;
    if (toEl === target) return; // moved within the same box (e.g. onto a child span)
    hideHoverTip();
  });

  overlay.addEventListener('mouseleave', function () { hideHoverTip(); });

  // =========================================================================
  // INTERACTION: fill clicks, draw, drag, resize
  // =========================================================================
  var drawing = null, dragging = null, resizing = null;

  overlay.addEventListener('mousedown', function (e) {
    var target = e.target.closest('.field-box');
    hideHoverTip();

    if (STATE.mode === 'draw' && !target) {
      var r = overlay.getBoundingClientRect();
      drawing = { x: e.clientX - r.left, y: e.clientY - r.top };
      var box = document.createElement('div');
      box.className = 'drawing-box';
      box.style.left = drawing.x + 'px';
      box.style.top = drawing.y + 'px';
      overlay.appendChild(box);
      drawing.el = box;
      return;
    }

    if (STATE.mode === 'edit' && target) {
      var handle = e.target.dataset.handle;
      var fieldId = target.dataset.fieldId;
      var f = STATE.fields.find(function (x) { return x.id === fieldId; });
      if (!f) return;

      if (handle) {
        resizing = { id: fieldId, handle: handle, startClientX: e.clientX, startClientY: e.clientY,
          x: f.xNorm, y: f.yNorm, w: f.wNorm, h: f.hNorm };
        e.preventDefault();
        return;
      }

      STATE.selectedFieldId = fieldId;
      renderFieldsList();
      renderOverlay();
      dragging = { id: fieldId, startClientX: e.clientX, startClientY: e.clientY, x: f.xNorm, y: f.yNorm };
      e.preventDefault();
      return;
    }

    if (STATE.mode === 'fill' && target) {
      var fid = target.dataset.fieldId;
      var field = STATE.fields.find(function (x) { return x.id === fid; });
      if (!field) return;
      if (field.type === 'checkbox') {
        updateField(fid, { value: !field.value });
        renderFieldsList();
      } else {
        var input = document.getElementById('val_' + fid);
        if (input) { input.focus(); input.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
      }
    }
  });

  window.addEventListener('mousemove', function (e) {
    if (drawing) {
      var r = overlay.getBoundingClientRect();
      var cx = Math.max(0, Math.min(r.width, e.clientX - r.left));
      var cy = Math.max(0, Math.min(r.height, e.clientY - r.top));
      var left = Math.min(drawing.x, cx), top = Math.min(drawing.y, cy);
      var w = Math.abs(cx - drawing.x), h = Math.abs(cy - drawing.y);
      drawing.el.style.left = left + 'px';
      drawing.el.style.top = top + 'px';
      drawing.el.style.width = w + 'px';
      drawing.el.style.height = h + 'px';
      drawing.w = w; drawing.h = h; drawing.finalLeft = left; drawing.finalTop = top;
      return;
    }

    if (dragging) {
      var stageW = canvas.width * STATE.zoom, stageH = canvas.height * STATE.zoom;
      var dx = (e.clientX - dragging.startClientX) / stageW;
      var dy = (e.clientY - dragging.startClientY) / stageH;
      updateField(dragging.id, { xNorm: dragging.x + dx, yNorm: dragging.y + dy });
      return;
    }

    if (resizing) {
      var f = STATE.fields.find(function (x) { return x.id === resizing.id; });
      if (!f) return;
      var stageW2 = canvas.width * STATE.zoom, stageH2 = canvas.height * STATE.zoom;
      var ddx = (e.clientX - resizing.startClientX) / stageW2;
      var ddy = (e.clientY - resizing.startClientY) / stageH2;
      var x = resizing.x, y = resizing.y, w = resizing.w, h = resizing.h;
      var hd = resizing.handle;
      if (hd.indexOf('e') !== -1) w = Math.max(0.01, resizing.w + ddx);
      if (hd.indexOf('s') !== -1) h = Math.max(0.01, resizing.h + ddy);
      if (hd.indexOf('w') !== -1) { var nw = resizing.w - ddx; if (nw > 0.01) { x = resizing.x + ddx; w = nw; } }
      if (hd.indexOf('n') !== -1) { var nh = resizing.h - ddy; if (nh > 0.01) { y = resizing.y + ddy; h = nh; } }
      updateField(resizing.id, { xNorm: x, yNorm: y, wNorm: w, hNorm: h });
    }
  });

  window.addEventListener('mouseup', function () {
    if (drawing) {
      var w = drawing.w || 0, h = drawing.h || 0;
      drawing.el.remove();
      if (w > 8 && h > 8) {
        var stageW = canvas.width * STATE.zoom, stageH = canvas.height * STATE.zoom;
        var square = w / h >= 0.7 && w / h <= 1.4 && w < 26;
        var f = addField({
          xNorm: drawing.finalLeft / stageW,
          yNorm: drawing.finalTop / stageH,
          wNorm: w / stageW,
          hNorm: h / stageH,
          type: square ? 'checkbox' : 'text',
          label: square ? 'চেকবক্স' : ('ফিল্ড ' + (STATE.fields.length + 1)),
          value: square ? false : ''
        });
        STATE.selectedFieldId = f.id;
        setMode('edit');
      }
      drawing = null;
    }
    dragging = null;
    resizing = null;
  });

  // =========================================================================
  // MODE / TAB / PAGE / ZOOM controls
  // =========================================================================
  function setMode(mode) {
    STATE.mode = mode;
    if (mode !== 'edit') STATE.selectedFieldId = null;
    $all('.mode-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.mode === mode); });
    renderOverlay();
  }
  $all('.mode-btn').forEach(function (b) { b.addEventListener('click', function () { setMode(b.dataset.mode); }); });

  function setTab(tab) {
    STATE.activeTab = tab;
    $all('.tab-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === tab); });
    $all('.tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'tab-' + tab); });
  }
  $all('.tab-btn').forEach(function (b) { b.addEventListener('click', function () { setTab(b.dataset.tab); }); });

  $('#btnZoomIn').addEventListener('click', function () { setZoom(STATE.zoom + 0.15); });
  $('#btnZoomOut').addEventListener('click', function () { setZoom(STATE.zoom - 0.15); });
  $('#btnZoomFit').addEventListener('click', function () {
    var avail = $('#stageArea').clientWidth - 60;
    setZoom(avail / canvas.width);
  });

  // Bug fixed: these had no .catch() — any rendering error (see the
  // RenderTask note above) was an unhandled rejection that silently
  // left the page "stuck" with no feedback to the user at all.
  $('#btnPrevPage').addEventListener('click', function () {
    if (STATE.currentPage <= 1) return;
    STATE.currentPage--;
    renderPage().then(function () { detectFieldsIfEmpty(); }).catch(function (err) {
      console.error(err);
      toast('পাতা দেখাতে সমস্যা হয়েছে: ' + err.message);
    });
  });
  $('#btnNextPage').addEventListener('click', function () {
    if (STATE.currentPage >= STATE.totalPages) return;
    STATE.currentPage++;
    renderPage().then(function () { detectFieldsIfEmpty(); }).catch(function (err) {
      console.error(err);
      toast('পাতা দেখাতে সমস্যা হয়েছে: ' + err.message);
    });
  });
  function detectFieldsIfEmpty() {
    updateToolbar();
    renderFieldsList();
    renderReviewList();
    if (getPageFields().length === 0) detectFields();
  }

  // =========================================================================
  // SIDEBAR: Fields list
  // =========================================================================
  function renderFieldsList() {
    var list = $('#fieldsList');
    var fields = getPageFields();
    list.innerHTML = '';
    if (fields.length === 0) {
      list.innerHTML = '<p class="hint">এই পাতায় কোনো ফিল্ড নেই। "ফিল্ড খুঁজুন" চাপুন অথবা "আঁকুন" মোডে হাতে বসান।</p>';
      return;
    }
    fields.forEach(function (f) {
      list.appendChild(buildFieldCard(f));
    });
  }

  function buildFieldCard(f) {
    var card = document.createElement('div');
    card.className = 'field-card' + (STATE.selectedFieldId === f.id ? ' selected' : '');
    card.addEventListener('mouseenter', function () { hoverTip.hidden = true; STATE.hoveredFieldId = f.id; renderOverlay(); });
    card.addEventListener('mouseleave', function () { STATE.hoveredFieldId = null; renderOverlay(); });

    var head = document.createElement('div');
    head.className = 'field-card-head';

    var labelInput = document.createElement('input');
    labelInput.className = 'field-label-input';
    labelInput.value = f.label;
    labelInput.addEventListener('change', function () { updateField(f.id, { label: labelInput.value }); });

    var tag = document.createElement('span');
    tag.className = 'field-tag ' + f.source;
    tag.textContent = f.source === 'acroform' ? 'AcroForm' : (f.source === 'gemini' ? 'Gemini' : 'হাতে');

    var del = document.createElement('button');
    del.className = 'field-del';
    del.textContent = '×';
    del.addEventListener('click', function () { removeField(f.id); });

    head.appendChild(labelInput);
    head.appendChild(tag);
    head.appendChild(del);
    card.appendChild(head);

    if (f.type === 'checkbox') {
      var row = document.createElement('label');
      row.className = 'field-checkbox-row';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!f.value;
      cb.addEventListener('change', function () { updateField(f.id, { value: cb.checked }); renderFieldsList(); });
      var txt = document.createElement('span');
      txt.textContent = f.value ? 'টিক দেওয়া আছে' : 'টিক নেই';
      row.appendChild(cb);
      row.appendChild(txt);
      card.appendChild(row);
    } else if (f.type === 'textarea') {
      var ta = document.createElement('textarea');
      ta.className = 'field-value-textarea';
      ta.id = 'val_' + f.id;
      ta.value = f.value || '';
      ta.addEventListener('input', function () { updateField(f.id, { value: ta.value }); });
      card.appendChild(ta);
    } else {
      var inp = document.createElement('input');
      inp.className = 'field-value-input';
      inp.id = 'val_' + f.id;
      inp.type = (f.type === 'date') ? 'text' : (f.type === 'number' ? 'number' : 'text');
      inp.placeholder = f.label;
      inp.value = f.value || '';
      inp.addEventListener('input', function () { updateField(f.id, { value: inp.value }); });
      card.appendChild(inp);
    }

    return card;
  }

  // ---- Review queue -------------------------------------------------------
  function renderReviewList() {
    var list = $('#reviewList');
    var unverified = STATE.fields.filter(function (f) { return f.needsReview; });
    $('#reviewBadge').hidden = unverified.length === 0;
    $('#reviewBadge').textContent = unverified.length;

    list.innerHTML = '';
    if (unverified.length === 0) {
      list.innerHTML = '<p class="hint">যাচাই করার মতো কিছু নেই।</p>';
      return;
    }
    unverified.forEach(function (f) {
      var card = document.createElement('div');
      card.className = 'review-card';
      card.innerHTML = '<strong>' + escapeHtml(f.label) + '</strong>' +
        '<div class="review-meta">পাতা ' + f.page + ' &bull; বিশ্বাসযোগ্যতা ' + Math.round((f.confidence || 0.8) * 100) + '%</div>';
      var actions = document.createElement('div');
      actions.className = 'review-actions';
      var ok = document.createElement('button');
      ok.className = 'btn-sm btn-accent';
      ok.textContent = 'ঠিক আছে';
      ok.addEventListener('click', function () { updateField(f.id, { needsReview: false }); renderReviewList(); renderFieldsList(); });
      var no = document.createElement('button');
      no.className = 'btn-sm';
      no.textContent = 'বাদ দিন';
      no.addEventListener('click', function () { removeField(f.id); renderReviewList(); });
      actions.appendChild(ok);
      actions.appendChild(no);
      card.appendChild(actions);
      // Bug fixed: this card had a mouseenter to highlight the field but no
      // matching mouseleave, so the highlight used to stay stuck on once set.
      card.addEventListener('mouseenter', function () { hoverTip.hidden = true; STATE.hoveredFieldId = f.id; renderOverlay(); });
      card.addEventListener('mouseleave', function () { STATE.hoveredFieldId = null; renderOverlay(); });
      list.appendChild(card);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  $('#btnApproveAll').addEventListener('click', function () {
    STATE.fields.forEach(function (f) { f.needsReview = false; });
    renderReviewList(); renderFieldsList(); renderOverlay();
  });
  $('#btnClearValues').addEventListener('click', function () {
    if (!confirm('এই পাতার সব লেখা মুছে ফেলা হবে (ফিল্ডের অবস্থান থাকবে)। নিশ্চিত?')) return;
    getPageFields().forEach(function (f) { f.value = f.type === 'checkbox' ? false : ''; });
    renderFieldsList(); renderOverlay();
  });
  $('#btnAddField').addEventListener('click', function () {
    var f = addField({});
    STATE.selectedFieldId = f.id;
    setMode('edit');
    renderFieldsList();
  });
  $('#btnDetect').addEventListener('click', function () { detectFields(); });

  // =========================================================================
  // SETTINGS
  // =========================================================================
  $('#workerUrlInput').value = STATE.workerUrl || '/api/form-filler-ai';
  $('#btnSaveWorkerUrl').addEventListener('click', function () {
    STATE.workerUrl = $('#workerUrlInput').value.trim();
    localStorage.setItem('sff_worker_url', STATE.workerUrl);
    toast('Worker URL সেভ হয়েছে।');
  });

  $('#offsetXInput').addEventListener('input', function () {
    STATE.printerOffsetMm.x = parseFloat($('#offsetXInput').value) || 0;
    renderOverlay();
  });
  $('#offsetYInput').addEventListener('input', function () {
    STATE.printerOffsetMm.y = parseFloat($('#offsetYInput').value) || 0;
    renderOverlay();
  });
  $('#fontSizeInput').addEventListener('input', function () {
    STATE.font.size = parseInt($('#fontSizeInput').value, 10) || 12;
    renderOverlay();
  });
  $('#fontColorInput').addEventListener('change', function () {
    STATE.font.color = $('#fontColorInput').value;
    renderOverlay();
  });
  $('#checkSymbolInput').addEventListener('change', function () {
    STATE.font.checkSymbol = $('#checkSymbolInput').value;
    renderOverlay();
  });

  // =========================================================================
  // TEMPLATES (localStorage)
  // =========================================================================
  var TPL_KEY = 'sff_templates_v1';
  function getTemplates() { try { return JSON.parse(localStorage.getItem(TPL_KEY) || '[]'); } catch (e) { return []; } }
  function saveTemplates(t) { localStorage.setItem(TPL_KEY, JSON.stringify(t)); renderTemplatesList(); }

  $('#btnSaveTemplate').addEventListener('click', function () {
    if (STATE.fields.length === 0) { toast('সেভ করার মতো কোনো ফিল্ড নেই।'); return; }
    var name = $('#templateNameInput').value.trim() || ('টেমপ্লেট ' + new Date().toLocaleDateString('bn-BD'));
    var tpls = getTemplates();
    tpls.unshift({
      id: uid('tpl'), name: name, fileName: STATE.fileName,
      fields: STATE.fields.map(function (f) {
        return { page: f.page, label: f.label, type: f.type, xNorm: f.xNorm, yNorm: f.yNorm, wNorm: f.wNorm, hNorm: f.hNorm };
      }),
      printerOffsetMm: STATE.printerOffsetMm
    });
    saveTemplates(tpls);
    $('#templateNameInput').value = '';
    toast('টেমপ্লেট সেভ হয়েছে।');
  });

  function renderTemplatesList() {
    var list = $('#templatesList');
    var tpls = getTemplates();
    list.innerHTML = '';
    if (tpls.length === 0) { list.innerHTML = '<p class="hint">এখনো কোনো টেমপ্লেট সেভ করা হয়নি।</p>'; return; }
    tpls.forEach(function (t) {
      var card = document.createElement('div');
      card.className = 'field-card';
      card.innerHTML = '<strong>' + escapeHtml(t.name) + '</strong><div class="review-meta">' + t.fields.length + 'টি ফিল্ড &bull; ' + escapeHtml(t.fileName || '') + '</div>';
      var actions = document.createElement('div');
      actions.className = 'review-actions';
      var loadBtn = document.createElement('button');
      loadBtn.className = 'btn-sm btn-accent';
      loadBtn.textContent = 'লোড করুন';
      loadBtn.addEventListener('click', function () {
        STATE.fields = t.fields.map(function (f) {
          return Object.assign({}, f, { id: uid('tpl'), value: f.type === 'checkbox' ? false : '', source: 'manual', needsReview: false, confidence: 1 });
        });
        if (t.printerOffsetMm) {
          STATE.printerOffsetMm = t.printerOffsetMm;
          $('#offsetXInput').value = t.printerOffsetMm.x;
          $('#offsetYInput').value = t.printerOffsetMm.y;
        }
        setTab('fields');
        renderFieldsList(); renderReviewList(); renderOverlay();
        toast('টেমপ্লেট লোড হয়েছে।');
      });
      var delBtn = document.createElement('button');
      delBtn.className = 'btn-sm';
      delBtn.textContent = 'মুছুন';
      delBtn.addEventListener('click', function () {
        saveTemplates(getTemplates().filter(function (x) { return x.id !== t.id; }));
      });
      actions.appendChild(loadBtn);
      actions.appendChild(delBtn);
      card.appendChild(actions);
      list.appendChild(card);
    });
  }
  renderTemplatesList();

  // =========================================================================
  // SHARED DRAW FUNCTION — used identically by Print AND PDF export
  // =========================================================================
  function drawFieldsOnCanvas(targetCtx, fields, canvasW, canvasH, scaleUsed, font) {
    var offset = offsetInCanvasPx(scaleUsed);
    targetCtx.save();
    fields.forEach(function (f) {
      var x = f.xNorm * canvasW + offset.x;
      var y = f.yNorm * canvasH + offset.y;
      var w = f.wNorm * canvasW;
      var h = f.hNorm * canvasH;

      if (f.type === 'checkbox') {
        if (f.value) {
          targetCtx.fillStyle = font.color;
          targetCtx.font = '700 ' + Math.round(h * 0.85) + 'px "Noto Sans Bengali", Arial, sans-serif';
          targetCtx.textBaseline = 'middle';
          targetCtx.textAlign = 'center';
          targetCtx.fillText(font.checkSymbol, x + w / 2, y + h / 2);
        }
      } else if (f.value) {
        targetCtx.fillStyle = font.color;
        targetCtx.font = font.weight + ' ' + Math.round(font.size * scaleUsed) + 'px ' + font.family;
        targetCtx.textBaseline = 'middle';
        targetCtx.textAlign = 'left';
        if (f.type === 'textarea') {
          var lines = String(f.value).split('\n');
          var lh = font.size * scaleUsed * 1.3;
          var cy = y + lh * 0.6;
          lines.forEach(function (line) {
            targetCtx.fillText(line, x + 3 * scaleUsed, cy);
            cy += lh;
          });
        } else {
          targetCtx.fillText(String(f.value), x + 3 * scaleUsed, y + h / 2);
        }
      }
    });
    targetCtx.restore();
  }

  function renderPageToOffscreenCanvas(pageNum, scale) {
    var off = document.createElement('canvas');
    var octx = off.getContext('2d', { alpha: false });

    if (STATE.fileType === 'pdf') {
      return STATE.pdfDoc.getPage(pageNum).then(function (page) {
        var vp = page.getViewport({ scale: scale });
        off.width = Math.floor(vp.width);
        off.height = Math.floor(vp.height);
        return page.render({ canvasContext: octx, viewport: vp }).promise;
      }).then(function () { return { canvas: off, ctx: octx }; });
    } else {
      var dims = STATE.pageDims[1];
      off.width = Math.floor(dims.width * scale);
      off.height = Math.floor(dims.height * scale);
      octx.fillStyle = '#fff';
      octx.fillRect(0, 0, off.width, off.height);
      octx.drawImage(STATE.imageElement, 0, 0, off.width, off.height);
      return Promise.resolve({ canvas: off, ctx: octx });
    }
  }

  // =========================================================================
  // EXPORT — accurate page size (unscaled), unified offset formula
  // =========================================================================
  function ensureFontsLoaded() {
    if (document.fonts && document.fonts.ready) return document.fonts.ready;
    return Promise.resolve();
  }

  $('#btnExport').addEventListener('click', function () {
    if (!window.PDFLib) { toast('pdf-lib লোড হয়নি।'); return; }
    if (STATE.totalPages === 0) return;

    setBusy(true, 'PDF তৈরি হচ্ছে...');
    ensureFontsLoaded().then(function () {
      return window.PDFLib.PDFDocument.create();
    }).then(function (pdfDoc) {
      var chain = Promise.resolve();
      var pageCount = STATE.fileType === 'pdf' ? STATE.totalPages : 1;

      for (var p = 1; p <= pageCount; p++) {
        (function (pageNum) {
          chain = chain.then(function () {
            return renderPageToOffscreenCanvas(pageNum, RENDER_SCALE);
          }).then(function (res) {
            var scaleUsed = RENDER_SCALE;
            drawFieldsOnCanvas(res.ctx, getPageFields(pageNum), res.canvas.width, res.canvas.height, scaleUsed, STATE.font);

            var pageDims = STATE.pageDims[pageNum] || { width: res.canvas.width / scaleUsed, height: res.canvas.height / scaleUsed };
            var pngUrl = res.canvas.toDataURL('image/png');
            return pdfDoc.embedPng(pngUrl).then(function (pngImage) {
              var pdfPage = pdfDoc.addPage([pageDims.width, pageDims.height]);
              pdfPage.drawImage(pngImage, { x: 0, y: 0, width: pageDims.width, height: pageDims.height });
            });
          });
        })(p);
      }

      return chain.then(function () { return pdfDoc.save(); });
    }).then(function (bytes) {
      var blob = new Blob([bytes], { type: 'application/pdf' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'পূরণকৃত_' + (STATE.fileName || 'form').replace(/\.[^/.]+$/, '') + '.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      setBusy(false);
    }).catch(function (err) {
      console.error(err);
      setBusy(false);
      toast('PDF তৈরি করতে সমস্যা হয়েছে: ' + err.message);
    });
  });

  // =========================================================================
  // PRINT — same drawFieldsOnCanvas, same offset math, via hidden iframe
  // =========================================================================
  $('#btnPrint').addEventListener('click', function () {
    setBusy(true, 'প্রিন্টের জন্য প্রস্তুত হচ্ছে...');
    ensureFontsLoaded().then(function () {
      var pageCount = STATE.fileType === 'pdf' ? STATE.totalPages : 1;
      var chain = Promise.resolve();
      var imgs = [];

      for (var p = 1; p <= pageCount; p++) {
        (function (pageNum) {
          chain = chain.then(function () { return renderPageToOffscreenCanvas(pageNum, RENDER_SCALE); })
            .then(function (res) {
              drawFieldsOnCanvas(res.ctx, getPageFields(pageNum), res.canvas.width, res.canvas.height, RENDER_SCALE, STATE.font);
              imgs.push(res.canvas.toDataURL('image/png'));
            });
        })(p);
      }

      return chain.then(function () { return imgs; });
    }).then(function (imgs) {
      var frame = document.getElementById('printFrame');
      if (!frame) {
        frame = document.createElement('iframe');
        frame.id = 'printFrame';
        frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
        document.body.appendChild(frame);
      }
      var doc = frame.contentWindow.document;
      doc.open();
      doc.write('<!DOCTYPE html><html><head><style>@page{size:auto;margin:0} body{margin:0} .p{page-break-after:always;display:flex;align-items:center;justify-content:center;height:100vh} img{max-width:100%;max-height:100%}</style></head><body>' +
        imgs.map(function (src) { return '<div class="p"><img src="' + src + '"></div>'; }).join('') +
        '</body></html>');
      doc.close();
      setBusy(false);
      setTimeout(function () { frame.contentWindow.focus(); frame.contentWindow.print(); }, 400);
    }).catch(function (err) {
      console.error(err);
      setBusy(false);
      toast('প্রিন্ট প্রস্তুত করতে সমস্যা হয়েছে: ' + err.message);
    });
  });

  // =========================================================================
  // UPLOAD / DRAG-DROP
  // =========================================================================
  $('#btnUpload').addEventListener('click', function () { $('#fileInput').click(); });
  $('#fileInput').addEventListener('change', function (e) {
    if (e.target.files[0]) handleFile(e.target.files[0]);
    e.target.value = '';
  });
  ['dragenter', 'dragover'].forEach(function (ev) {
    $('#stageArea').addEventListener(ev, function (e) { e.preventDefault(); });
  });
  $('#stageArea').addEventListener('drop', function (e) {
    e.preventDefault();
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

})();
