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
    fileSize: 0,
    fileHash: null,
    matchedTemplateId: null,
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
    font: { family: "'Noto Sans Bengali','Inter',sans-serif", size: 12, color: '#0b2f6b', weight: '600', checkSymbol: '✔', checkScale: 0.8 }
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
  // TEMPLATES STORAGE & SMART FORM RECOGNITION
  // =========================================================================
  // BUILT-IN OFFICIAL FORMS & TEMPLATES REPOSITORY
  // =========================================================================
  var BUILTIN_TEMPLATES = [
    {
      id: 'tpl_wb_jobcard_3page_official',
      name: 'জনকল্যাণ শিবির - জব কার্ড ও পারিবারিক তথ্য আবেদনপত্র (৩ পাতা)',
      isBuiltin: true,
      fileHash: '2438609647a801fd5282c383bbe80dbbd361a55c2e911a03b7092a40a644da47',
      fileSize: 309127,
      totalPages: 3,
      aspectRatio: '0.773',
      printerOffsetMm: { x: 0, y: 0 },
      fields: [
        // PAGE 1: Job Card Application Form
        { page: 1, label: 'ব্লক', type: 'text', xNorm: 0.1193, yNorm: 0.1919, wNorm: 0.1552, hNorm: 0.0164 },
        { page: 1, label: 'আমি (আবেদনকারীর নাম)', type: 'text', xNorm: 0.2165, yNorm: 0.2936, wNorm: 0.4493, hNorm: 0.0177 },
        { page: 1, label: 'পিতা/স্বামীর নাম', type: 'text', xNorm: 0.1193, yNorm: 0.3163, wNorm: 0.2042, hNorm: 0.0177 },
        { page: 1, label: 'গ্রাম পঞ্চায়েত', type: 'text', xNorm: 0.3513, yNorm: 0.3163, wNorm: 0.2859, hNorm: 0.0177 },
        { page: 1, label: 'তারিখ', type: 'text', xNorm: 0.1675, yNorm: 0.4899, wNorm: 0.1225, hNorm: 0.0177 },
        { page: 1, label: 'আবেদনকারীর পুরো নাম', type: 'text', xNorm: 0.6127, yNorm: 0.5152, wNorm: 0.1634, hNorm: 0.0177 },
        { page: 1, label: 'মোবাইল নং', type: 'text', xNorm: 0.7312, yNorm: 0.5379, wNorm: 0.1471, hNorm: 0.0177 },

        // PAGE 2: Family Details & Table
        // Top Address Section
        { page: 2, label: 'আবেদনকারীর নাম', type: 'text', xNorm: 0.2614, yNorm: 0.1098, wNorm: 0.3676, hNorm: 0.0164 },
        { page: 2, label: 'পিতা/ স্বামীর নাম', type: 'text', xNorm: 0.2614, yNorm: 0.1433, wNorm: 0.3676, hNorm: 0.0164 },
        { page: 2, label: 'পরিবারের প্রধান সদস্যের নাম', type: 'text', xNorm: 0.3513, yNorm: 0.1812, wNorm: 0.3431, hNorm: 0.0164 },
        { page: 2, label: 'গ্রাম', type: 'text', xNorm: 0.1634, yNorm: 0.2513, wNorm: 0.1389, hNorm: 0.0164 },
        { page: 2, label: 'মৌজা', type: 'text', xNorm: 0.3595, yNorm: 0.2513, wNorm: 0.1471, hNorm: 0.0164 },
        { page: 2, label: 'সংসদ', type: 'text', xNorm: 0.5637, yNorm: 0.2513, wNorm: 0.1552, hNorm: 0.0164 },
        { page: 2, label: 'গ্রাম পঞ্চায়েত', type: 'text', xNorm: 0.2165, yNorm: 0.2866, wNorm: 0.1429, hNorm: 0.0164 },
        { page: 2, label: 'ব্লক', type: 'text', xNorm: 0.4085, yNorm: 0.2866, wNorm: 0.1144, hNorm: 0.0164 },
        { page: 2, label: 'জেলা', type: 'text', xNorm: 0.5759, yNorm: 0.2866, wNorm: 0.1429, hNorm: 0.0164 },
        { page: 2, label: 'পিন কোড', type: 'text', xNorm: 0.1838, yNorm: 0.3220, wNorm: 0.1429, hNorm: 0.0164 },

        // Row 1 (Table)
        { page: 2, label: 'সদস্য ১ - নাম', type: 'text', xNorm: 0.0784, yNorm: 0.5177, wNorm: 0.1127, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ১ - জন্ম তারিখ', type: 'text', xNorm: 0.1912, yNorm: 0.5177, wNorm: 0.0931, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ১ - লিঙ্গ (পুং/স্ত্রী/অন্য)', type: 'text', xNorm: 0.2843, yNorm: 0.5177, wNorm: 0.0458, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ১ - কাস্ট (SC/ST/OBC/Gen)', type: 'text', xNorm: 0.3301, yNorm: 0.5177, wNorm: 0.0694, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ১ - ভোটার কার্ড পুরো নং', type: 'text', xNorm: 0.3995, yNorm: 0.5177, wNorm: 0.1275, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ১ - আধার কার্ড নং', type: 'text', xNorm: 0.5270, yNorm: 0.5177, wNorm: 0.1511, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ১ - মোবাইল নং', type: 'text', xNorm: 0.6781, yNorm: 0.5177, wNorm: 0.1152, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ১ - ব্যাঙ্ক তথ্য (শাখা/IFSC/A/C)', type: 'text', xNorm: 0.7933, yNorm: 0.5177, wNorm: 0.1275, hNorm: 0.0202 },

        // Row 2 (Table)
        { page: 2, label: 'সদস্য ২ - নাম', type: 'text', xNorm: 0.0784, yNorm: 0.5379, wNorm: 0.1127, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ২ - জন্ম তারিখ', type: 'text', xNorm: 0.1912, yNorm: 0.5379, wNorm: 0.0931, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ২ - লিঙ্গ (পুং/স্ত্রী/অন্য)', type: 'text', xNorm: 0.2843, yNorm: 0.5379, wNorm: 0.0458, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ২ - কাস্ট (SC/ST/OBC/Gen)', type: 'text', xNorm: 0.3301, yNorm: 0.5379, wNorm: 0.0694, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ২ - ভোটার কার্ড পুরো নং', type: 'text', xNorm: 0.3995, yNorm: 0.5379, wNorm: 0.1275, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ২ - আধার কার্ড নং', type: 'text', xNorm: 0.5270, yNorm: 0.5379, wNorm: 0.1511, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ২ - মোবাইল নং', type: 'text', xNorm: 0.6781, yNorm: 0.5379, wNorm: 0.1152, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ২ - ব্যাঙ্ক তথ্য (শাখা/IFSC/A/C)', type: 'text', xNorm: 0.7933, yNorm: 0.5379, wNorm: 0.1275, hNorm: 0.0202 },

        // Row 3 (Table)
        { page: 2, label: 'সদস্য ৩ - নাম', type: 'text', xNorm: 0.0784, yNorm: 0.5581, wNorm: 0.1127, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ৩ - জন্ম তারিখ', type: 'text', xNorm: 0.1912, yNorm: 0.5581, wNorm: 0.0931, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ৩ - লিঙ্গ (পুং/স্ত্রী/অন্য)', type: 'text', xNorm: 0.2843, yNorm: 0.5581, wNorm: 0.0458, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ৩ - কাস্ট (SC/ST/OBC/Gen)', type: 'text', xNorm: 0.3301, yNorm: 0.5581, wNorm: 0.0694, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ৩ - ভোটার কার্ড পুরো নং', type: 'text', xNorm: 0.3995, yNorm: 0.5581, wNorm: 0.1275, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ৩ - আধার কার্ড নং', type: 'text', xNorm: 0.5270, yNorm: 0.5581, wNorm: 0.1511, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ৩ - মোবাইল নং', type: 'text', xNorm: 0.6781, yNorm: 0.5581, wNorm: 0.1152, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ৩ - ব্যাঙ্ক তথ্য (শাখা/IFSC/A/C)', type: 'text', xNorm: 0.7933, yNorm: 0.5581, wNorm: 0.1275, hNorm: 0.0202 },

        // Row 4 (Table)
        { page: 2, label: 'সদস্য ৪ - নাম', type: 'text', xNorm: 0.0784, yNorm: 0.5783, wNorm: 0.1127, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ৪ - জন্ম তারিখ', type: 'text', xNorm: 0.1912, yNorm: 0.5783, wNorm: 0.0931, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ৪ - লিঙ্গ (পুং/স্ত্রী/অন্য)', type: 'text', xNorm: 0.2843, yNorm: 0.5783, wNorm: 0.0458, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ৪ - কাস্ট (SC/ST/OBC/Gen)', type: 'text', xNorm: 0.3301, yNorm: 0.5783, wNorm: 0.0694, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ৪ - ভোটার কার্ড পুরো নং', type: 'text', xNorm: 0.3995, yNorm: 0.5783, wNorm: 0.1275, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ৪ - আধার কার্ড নং', type: 'text', xNorm: 0.5270, yNorm: 0.5783, wNorm: 0.1511, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ৪ - মোবাইল নং', type: 'text', xNorm: 0.6781, yNorm: 0.5783, wNorm: 0.1152, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ৪ - ব্যাঙ্ক তথ্য (শাখা/IFSC/A/C)', type: 'text', xNorm: 0.7933, yNorm: 0.5783, wNorm: 0.1275, hNorm: 0.0202 },

        // Row 5 (Table)
        { page: 2, label: 'সদস্য ৫ - নাম', type: 'text', xNorm: 0.0784, yNorm: 0.5985, wNorm: 0.1127, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ৫ - জন্ম তারিখ', type: 'text', xNorm: 0.1912, yNorm: 0.5985, wNorm: 0.0931, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ৫ - লিঙ্গ (পুং/স্ত্রী/অন্য)', type: 'text', xNorm: 0.2843, yNorm: 0.5985, wNorm: 0.0458, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ৫ - কাস্ট (SC/ST/OBC/Gen)', type: 'text', xNorm: 0.3301, yNorm: 0.5985, wNorm: 0.0694, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ৫ - ভোটার কার্ড পুরো নং', type: 'text', xNorm: 0.3995, yNorm: 0.5985, wNorm: 0.1275, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ৫ - আধার কার্ড নং', type: 'text', xNorm: 0.5270, yNorm: 0.5985, wNorm: 0.1511, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ৫ - মোবাইল নং', type: 'text', xNorm: 0.6781, yNorm: 0.5985, wNorm: 0.1152, hNorm: 0.0202 },
        { page: 2, label: 'সদস্য ৫ - ব্যাঙ্ক তথ্য (শাখা/IFSC/A/C)', type: 'text', xNorm: 0.7933, yNorm: 0.5985, wNorm: 0.1275, hNorm: 0.0202 },

        // Receipt (রসিদ)
        { page: 2, label: 'রসিদ - আবেদনকারীর নাম', type: 'text', xNorm: 0.1797, yNorm: 0.8567, wNorm: 0.2941, hNorm: 0.0177 },

        // PAGE 3: Aadhaar Consent Form
        // English Section
        { page: 3, label: 'Name (English)', type: 'text', xNorm: 0.1429, yNorm: 0.1667, wNorm: 0.3595, hNorm: 0.0177 },
        { page: 3, label: 'Job Card Number (English)', type: 'text', xNorm: 0.7843, yNorm: 0.1667, wNorm: 0.0980, hNorm: 0.0177 },
        { page: 3, label: 'Job Card Continuation (English)', type: 'text', xNorm: 0.1185, yNorm: 0.1932, wNorm: 0.2737, hNorm: 0.0177 },
        { page: 3, label: 'Aadhaar Number (English)', type: 'text', xNorm: 0.6180, yNorm: 0.1932, wNorm: 0.2600, hNorm: 0.0177 },
        { page: 3, label: 'Date (English)', type: 'text', xNorm: 0.1675, yNorm: 0.3138, wNorm: 0.1429, hNorm: 0.0177 },
        { page: 3, label: 'Signer Name (English)', type: 'text', xNorm: 0.5882, yNorm: 0.4122, wNorm: 0.1879, hNorm: 0.0177 },

        // Bengali Section
        { page: 3, label: 'আমি (নাম)', type: 'text', xNorm: 0.1838, yNorm: 0.6086, wNorm: 0.3676, hNorm: 0.0177 },
        { page: 3, label: 'জব কার্ড নম্বর (বাংলা)', type: 'text', xNorm: 0.1176, yNorm: 0.6376, wNorm: 0.4902, hNorm: 0.0177 },
        { page: 3, label: 'আধার নম্বর (বাংলা)', type: 'text', xNorm: 0.1176, yNorm: 0.6660, wNorm: 0.3962, hNorm: 0.0177 },
        { page: 3, label: 'তারিখ (বাংলা)', type: 'text', xNorm: 0.1757, yNorm: 0.7525, wNorm: 0.1348, hNorm: 0.0177 },
        { page: 3, label: 'নাম (স্বাক্ষর/টিপসই)', type: 'text', xNorm: 0.5719, yNorm: 0.8579, wNorm: 0.2042, hNorm: 0.0177 }
      ]
    }
  ];

  var TPL_KEY = 'sff_templates_v1';
  function getTemplates() { try { return JSON.parse(localStorage.getItem(TPL_KEY) || '[]'); } catch (e) { return []; } }
  function saveTemplates(t) { localStorage.setItem(TPL_KEY, JSON.stringify(t)); renderTemplatesList(); }

  // Fast cryptographic hash (SHA-256) of first 128KB for instant form identification
  function computeFileHash(arrayBuffer) {
    if (!window.crypto || !window.crypto.subtle) {
      return Promise.resolve(null);
    }
    var slice = arrayBuffer.byteLength > 131072 ? arrayBuffer.slice(0, 131072) : arrayBuffer;
    return window.crypto.subtle.digest('SHA-256', slice).then(function (hashBuf) {
      var hashArray = Array.from(new Uint8Array(hashBuf));
      return hashArray.map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    }).catch(function () {
      return null;
    });
  }

  function normalizeDocName(name) {
    if (!name) return '';
    return String(name).toLowerCase()
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/\(\d+\)/g, '')
      .replace(/[_\-\s\.]+/g, ' ')
      .trim();
  }

  function findMatchingTemplate(fileInfo) {
    var userTpls = getTemplates();
    var tpls = BUILTIN_TEMPLATES.concat(userTpls);
    if (!tpls || tpls.length === 0) return null;

    var curNameNorm = normalizeDocName(fileInfo.fileName);

    // 1. Exact cryptographic file hash match (instant 100% confidence, even if renamed)
    if (fileInfo.fileHash) {
      var hashMatch = tpls.find(function (t) {
        return t.fileHash && t.fileHash === fileInfo.fileHash;
      });
      if (hashMatch) return hashMatch;
    }

    // 2. Exact file name match (normalized)
    if (curNameNorm) {
      var nameMatch = tpls.find(function (t) {
        var tFileNorm = normalizeDocName(t.fileName);
        var tNameNorm = normalizeDocName(t.name);
        return (tFileNorm && tFileNorm === curNameNorm) || (tNameNorm && tNameNorm === curNameNorm);
      });
      if (nameMatch) return nameMatch;
    }

    // 3. Document structure match: 3-page Job Card Form (aspect ratio ~0.773)
    if (fileInfo.totalPages === 3 && fileInfo.aspectRatio && Math.abs(parseFloat(fileInfo.aspectRatio) - 0.773) < 0.05) {
      var jcTpl = tpls.find(function (t) { return t.id === 'tpl_wb_jobcard_3page_official'; });
      if (jcTpl) return jcTpl;
    }

    // 4. Exact file size AND total pages match
    if (fileInfo.fileSize && fileInfo.fileSize > 0) {
      var sizeMatch = tpls.find(function (t) {
        if (!t.fileSize || t.fileSize !== fileInfo.fileSize) return false;
        if (t.totalPages && fileInfo.totalPages && t.totalPages !== fileInfo.totalPages) return false;
        return true;
      });
      if (sizeMatch) return sizeMatch;
    }

    return null;
  }

  function showAutoTemplateBanner(tpl) {
    var banner = $('#autoTemplateBanner');
    var nameEl = $('#autoTemplateName');
    var descEl = $('#autoTemplateDesc');
    if (!banner) return;
    if (nameEl) nameEl.textContent = '✨ সরকারি ফর্ম টেমপ্লেট: "' + (tpl.name || 'সংরক্ষিত টেমপ্লেট') + '"';
    if (descEl) descEl.textContent = 'ফর্মটি নির্ভুলভাবে শনাক্ত হয়েছে এবং ' + tpl.fields.length + 'টি ফিল্ড সঠিক অবস্থানে বসানো হয়েছে। সরাসরি ক্লিক করে টাইপ শুরু করুন।';
    banner.hidden = false;
  }

  function hideAutoTemplateBanner() {
    var banner = $('#autoTemplateBanner');
    if (banner) banner.hidden = true;
  }

  function applyTemplate(t, isAutoLoaded) {
    STATE.matchedTemplateId = t.id;
    STATE.fields = t.fields.map(function (f) {
      return Object.assign({}, f, {
        id: uid('tpl'),
        value: (f.value !== undefined) ? f.value : (f.type === 'checkbox' ? false : ''),
        source: 'template',
        needsReview: false,
        confidence: 1.0
      });
    });

    if (t.printerOffsetMm) {
      STATE.printerOffsetMm = Object.assign({}, t.printerOffsetMm);
      if ($('#offsetXInput')) $('#offsetXInput').value = t.printerOffsetMm.x;
      if ($('#offsetYInput')) $('#offsetYInput').value = t.printerOffsetMm.y;
    }

    setTab('fields');
    renderFieldsList();
    renderReviewList();
    renderOverlay();
    renderTemplatesList();

    if (isAutoLoaded) {
      showAutoTemplateBanner(t);
      toast('✨ সরকারি ফর্ম "' + t.name + '" স্বয়ংক্রিয়ভাবে শনাক্ত ও প্রয়োগ করা হয়েছে!');
    } else {
      hideAutoTemplateBanner();
      toast('টেমপ্লেট "' + t.name + '" লোড হয়েছে।');
    }
  }

  function checkAutoTemplateOrDetect() {
    var dims = STATE.pageDims[STATE.currentPage] || { width: canvas.width, height: canvas.height };
    var aspect = (dims.width && dims.height) ? (dims.width / dims.height).toFixed(3) : null;

    var fileInfo = {
      fileName: STATE.fileName,
      fileSize: STATE.fileSize,
      fileHash: STATE.fileHash,
      totalPages: STATE.totalPages,
      aspectRatio: aspect
    };

    var matchedTpl = findMatchingTemplate(fileInfo);
    if (matchedTpl) {
      applyTemplate(matchedTpl, true);
      return Promise.resolve();
    }

    // No saved template matches, proceed with normal detection
    return detectFields();
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
    STATE.fileSize = file.size || 0;
    STATE.fileHash = null;
    STATE.matchedTemplateId = null;
    STATE.fields = [];
    STATE.pageDims = {};
    STATE.currentPage = 1;
    $('#emptyState').style.display = 'none';
    $('#stageInner').style.display = 'block';
    hideAutoTemplateBanner();

    if (isPdf) {
      file.arrayBuffer().then(function (buf) {
        return Promise.all([
          computeFileHash(buf),
          window.pdfjsLib.getDocument({ data: buf }).promise
        ]);
      }).then(function (results) {
        var hash = results[0];
        var doc = results[1];
        STATE.fileHash = hash;
        STATE.fileType = 'pdf';
        STATE.pdfDoc = doc;
        STATE.imageElement = null;
        STATE.totalPages = doc.numPages;
        return renderPage();
      }).then(function () {
        setBusy(false);
        return checkAutoTemplateOrDetect();
      }).catch(function (err) {
        console.error(err);
        setBusy(false);
        toast('ফাইল খুলতে সমস্যা হয়েছে: ' + err.message);
      });
    } else {
      file.arrayBuffer().then(function (buf) {
        return computeFileHash(buf);
      }).then(function (h) {
        STATE.fileHash = h;
      }).catch(function () {});

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
            checkAutoTemplateOrDetect();
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

  // ---- Helpers for AI Configuration & Web Crypto AES-256 Encryption -----
  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // =========================================================================
  // SECURE API KEY ENCRYPTION (AES-GCM 256-bit via Web Crypto API)
  // =========================================================================
  var ENC_STORAGE_KEY = 'sff_gemini_enc_v1';
  var ENC_SALT = new Uint8Array([80, 114, 97, 103, 97, 116, 105, 84, 101, 108, 101, 99, 111, 109, 65, 73]); // "PragatiTelecomAI"

  function getCryptoSecretKey() {
    var rawSecret = (window.location.origin || 'pragati-telecom') + '_sff_sec_salt_2026';
    var enc = new TextEncoder();
    return window.crypto.subtle.importKey(
      'raw',
      enc.encode(rawSecret),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    ).then(function (importedKey) {
      return window.crypto.subtle.deriveKey(
        {
          name: 'PBKDF2',
          salt: ENC_SALT,
          iterations: 100000,
          hash: 'SHA-256'
        },
        importedKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    });
  }

  function encryptApiKey(plainKey) {
    if (!plainKey || !plainKey.trim()) return Promise.resolve(null);
    var cleanKey = plainKey.trim();
    if (!window.crypto || !window.crypto.subtle) {
      return Promise.resolve('plain:' + btoa(cleanKey));
    }
    return getCryptoSecretKey().then(function (key) {
      var iv = window.crypto.getRandomValues(new Uint8Array(12));
      var enc = new TextEncoder();
      return window.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        enc.encode(cleanKey)
      ).then(function (ciphertext) {
        var ivHex = Array.from(iv).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
        var cipherHex = Array.from(new Uint8Array(ciphertext)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
        return 'aes_v1:' + ivHex + ':' + cipherHex;
      });
    }).catch(function (e) {
      console.warn('Encryption fallback to obfuscation:', e);
      return 'plain:' + btoa(cleanKey);
    });
  }

  function decryptApiKey(storedPayload) {
    if (!storedPayload) return Promise.resolve(null);
    if (storedPayload.startsWith('plain:')) {
      try { return Promise.resolve(atob(storedPayload.slice(6))); } catch (e) { return Promise.resolve(null); }
    }
    if (!storedPayload.startsWith('aes_v1:')) {
      // Legacy plain key
      return Promise.resolve(storedPayload);
    }
    var parts = storedPayload.split(':');
    if (parts.length !== 3) return Promise.resolve(null);
    var ivHex = parts[1];
    var cipherHex = parts[2];
    var ivBytes = ivHex.match(/.{1,2}/g);
    var cipherBytes = cipherHex.match(/.{1,2}/g);
    if (!ivBytes || !cipherBytes) return Promise.resolve(null);
    var iv = new Uint8Array(ivBytes.map(function (b) { return parseInt(b, 16); }));
    var cipherData = new Uint8Array(cipherBytes.map(function (b) { return parseInt(b, 16); }));

    if (!window.crypto || !window.crypto.subtle) {
      return Promise.resolve(null);
    }

    return getCryptoSecretKey().then(function (key) {
      return window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        cipherData
      ).then(function (decryptedBuf) {
        var dec = new TextDecoder();
        return dec.decode(decryptedBuf);
      });
    }).catch(function (e) {
      console.error('Decryption failed:', e);
      return null;
    });
  }

  var FORM_FILLER_PROMPT =
    'You are analyzing a scanned government/official application form image.\n\n' +
    'Detect EVERY fillable field, blank line, box, and checkbox on the page — including empty ones,\n' +
    'and including repeating rows in tables (e.g. if a family-member table repeats "Name" for 5 rows,\n' +
    'label them "Member 1 Name", "Member 2 Name", etc. — do not collapse them into one field).\n\n' +
    'Return STRICT JSON only, no markdown code fences, no commentary — a single JSON array:\n' +
    '[\n' +
    '  {\n' +
    '    "label": "short label as printed on the form (in the form\'s own language)",\n' +
    '    "value": "the filled-in value if the field already has handwritten or printed text in it, otherwise an empty string",\n' +
    '    "type": "text" | "textarea" | "checkbox" | "date" | "number",\n' +
    '    "box_2d": [ymin, xmin, ymax, xmax]\n' +
    '  }\n' +
    ']\n\n' +
    'Rules for box_2d:\n' +
    '- Integers normalized to a 0-1000 scale relative to the FULL image (top-left corner = [0,0,0,0], bottom-right = 1000).\n' +
    '- The box must cover the BLANK / ANSWER area where a value should be written (the empty underline, the empty box,\n' +
    '  or the checkbox glyph itself) — NOT the printed label text next to it.\n' +
    '- For name and text fields with a printed label followed by a blank underline or dotted line (e.g. "Name: ________" or "নাম: ________"):\n' +
    '  The box must start IMMEDIATELY after the label/colon where the blank line begins, exactly aligned horizontally with the underline, covering the full width of the writeable underline without overlapping the label text or shifting to the side.\n' +
    '- For a checkbox, make the box small and tight around just the checkbox glyph (☐ / □ / [ ]).\n' +
    '- Never skip a field just because it is currently empty.\n' +
    '- Never merge two distinct fields into a single box.';

  // Candidate models to try in priority order (Google Gemini 2.x / 1.5)
  var GEMINI_MODELS = [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash',
    'gemini-1.5-pro',
    'gemini-2.5-pro',
    'gemini-3.6-flash'
  ];
  var cachedWorkingModel = null;

  function requestGeminiContent(modelName, apiKey, base64) {
    var geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(modelName) + ':generateContent?key=' + encodeURIComponent(apiKey);
    var geminiBody = {
      contents: [{
        parts: [
          { text: FORM_FILLER_PROMPT },
          { inline_data: { mime_type: 'image/jpeg', data: base64 } }
        ]
      }],
      generationConfig: {
        temperature: 0.1,
        response_mime_type: 'application/json'
      }
    };

    return withTimeout(function (signal) {
      return fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody),
        signal: signal
      });
    }, 20000, 'Google Gemini (' + modelName + ') থেকে ২০ সেকেন্ডে কোনো সাড়া আসেনি।')
    .then(function (res) {
      if (res.status === 429) {
        throw new Error('Gemini API কোটা লিমিট বা রেট লিমিট অতিক্রম হয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।');
      }
      return res.json().then(function (data) {
        if (!res.ok) {
          var errMsg = (data && data.error && data.error.message) ? data.error.message : ('HTTP ' + res.status);
          var err = new Error(errMsg);
          err.status = res.status;
          throw err;
        }
        var rawText = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
        return { success: true, data: rawText || '[]' };
      });
    });
  }

  function callDirectGeminiWithFallback(apiKey, base64) {
    var modelsToTry = cachedWorkingModel 
      ? [cachedWorkingModel].concat(GEMINI_MODELS.filter(function(m) { return m !== cachedWorkingModel; }))
      : GEMINI_MODELS.slice();

    function tryModel(index) {
      if (index >= modelsToTry.length) {
        // All pre-defined models failed.
        // Dynamically query ModelService.ListModels to find active models for this API key:
        return fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(apiKey))
          .then(function (res) {
            if (!res.ok) {
              throw new Error('Google Gemini API Key সঠিক নয় অথবা মডেল তালিকা পাওয়া যায়নি।');
            }
            return res.json();
          })
          .then(function (listJson) {
            var models = (listJson && listJson.models) || [];
            var matched = models.find(function (m) {
              var name = m.name || '';
              var methods = m.supportedGenerationMethods || [];
              return methods.includes('generateContent') && (name.includes('flash') || name.includes('gemini'));
            });
            if (matched) {
              var cleanName = matched.name.replace(/^models\//, '');
              console.log('ListModels থেকে সক্রিয় মডেল পাওয়া গেছে:', cleanName);
              return requestGeminiContent(cleanName, apiKey, base64).then(function (res) {
                cachedWorkingModel = cleanName;
                return res;
              });
            }
            throw new Error('আপনার Gemini API Key-তে কোনো কার্যকর মডেল খুঁজে পাওয়া যায়নি। অনুগ্রহ করে Google AI Studio থেকে নতুন কী (API Key) তৈরি করুন।');
          });
      }

      var currentModel = modelsToTry[index];
      return requestGeminiContent(currentModel, apiKey, base64)
        .then(function (res) {
          cachedWorkingModel = currentModel;
          return res;
        })
        .catch(function (err) {
          var msg = (err && err.message) || '';

          // 1. If Google explicitly recommends a newer model in the error message, extract & try it
          var recMatch = msg.match(/update your code to use (?:models\/)?([a-zA-Z0-9\.\-_]+)/i);
          if (recMatch && recMatch[1] && recMatch[1] !== currentModel) {
            var suggested = recMatch[1].trim();
            console.log('Google Gemini suggested model:', suggested);
            if (!modelsToTry.includes(suggested)) {
              modelsToTry.splice(index + 1, 0, suggested);
            }
            return tryModel(index + 1);
          }

          // 2. If model is retired, not available, deprecated, or not found, fall back to next candidate
          var isModelUnavailable = 
            err.status === 404 || 
            err.status === 400 ||
            err.status === 503 ||
            err.name === 'AbortError' ||
            msg.includes('not found') || 
            msg.includes('no longer available') ||
            msg.includes('not available') ||
            msg.includes('deprecated') ||
            msg.includes('update your code') ||
            msg.includes('not supported') || 
            msg.includes('is not found for API version') ||
            msg.includes('সাড়া আসেনি') ||
            msg.includes('সময় শেষ') ||
            msg.includes('timeout') ||
            msg.includes('timed out') ||
            msg.includes('Failed to fetch') ||
            msg.includes('NetworkError');

          if (isModelUnavailable) {
            console.warn('মডেল ' + currentModel + ' কাজ করছে না, পরবর্তী মডেল চেষ্টা করা হচ্ছে...', msg);
            return tryModel(index + 1);
          }
          throw err;
        });
    }

    return tryModel(0);
  }

  // Robust Bounding Box Parser: handles 0-1000 scale, 0-1 normalized scale, arrays, objects & inverted coordinates
  function parseBoundingBox(rawBox) {
    var ymin = 0, xmin = 0, ymax = 0, xmax = 0;
    if (Array.isArray(rawBox)) {
      ymin = Number(rawBox[0]) || 0;
      xmin = Number(rawBox[1]) || 0;
      ymax = Number(rawBox[2]) || 0;
      xmax = Number(rawBox[3]) || 0;
    } else if (rawBox && typeof rawBox === 'object') {
      ymin = Number(rawBox.ymin !== undefined ? rawBox.ymin : (rawBox.top !== undefined ? rawBox.top : rawBox.y)) || 0;
      xmin = Number(rawBox.xmin !== undefined ? rawBox.xmin : (rawBox.left !== undefined ? rawBox.left : rawBox.x)) || 0;
      ymax = Number(rawBox.ymax !== undefined ? rawBox.ymax : (rawBox.bottom !== undefined ? rawBox.bottom : (ymin + (rawBox.height || rawBox.h || 0)))) || 0;
      xmax = Number(rawBox.xmax !== undefined ? rawBox.xmax : (rawBox.right !== undefined ? rawBox.right : (xmin + (rawBox.width || rawBox.w || 0)))) || 0;
    }

    if (ymin > ymax) { var ty = ymin; ymin = ymax; ymax = ty; }
    if (xmin > xmax) { var tx = xmin; xmin = xmax; xmax = tx; }

    var isThousand = (ymin > 1 || xmin > 1 || ymax > 1 || xmax > 1);
    var scaleDiv = isThousand ? 1000 : 1;

    var xNorm = Math.max(0, Math.min(0.98, xmin / scaleDiv));
    var yNorm = Math.max(0, Math.min(0.98, ymin / scaleDiv));
    var wNorm = Math.max(0.015, Math.min(1 - xNorm, (xmax - xmin) / scaleDiv));
    var hNorm = Math.max(0.012, Math.min(1 - yNorm, (ymax - ymin) / scaleDiv));

    return { xNorm: xNorm, yNorm: yNorm, wNorm: wNorm, hNorm: hNorm };
  }

  // ---- 2) Gemini Vision fallback (Direct API key or Cloudflare serverless endpoint)
  function handleGeminiApiResponse(json) {
    if (!json || !json.success) {
      toast('AI ফিল্ড স্ক্যান সম্পন্ন হয়নি: ' + ((json && json.error) || 'অজানা সমস্যা'));
      return false;
    }
    var arr;
    try {
      var cleanData = json.data;
      if (typeof cleanData === 'string') {
        cleanData = cleanData.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
        arr = JSON.parse(cleanData);
      } else {
        arr = cleanData;
      }
    } catch (e) {
      console.error('JSON parse error:', e, json.data);
      toast('AI থেকে বৈধ ফিল্ড ডেটা পাওয়া যায়নি।');
      return false;
    }
    if (!Array.isArray(arr)) arr = [];

    var fields = arr.map(function (item) {
      var coords = parseBoundingBox(item.box_2d || item.box || [0, 0, 40, 300]);
      return {
        id: uid('gm'),
        page: STATE.currentPage,
        label: item.label || 'ফিল্ড',
        type: item.type || 'text',
        xNorm: coords.xNorm,
        yNorm: coords.yNorm,
        wNorm: coords.wNorm,
        hNorm: coords.hNorm,
        value: item.type === 'checkbox' ? false : (item.value || ''),
        source: 'gemini',
        needsReview: true,
        confidence: 0.8
      };
    });

    replacePageFields(fields);
    toast('AI ' + fields.length + 'টি ফিল্ড খুঁজে পেয়েছে। সরাসরি ক্লিক করে টাইপ শুরু করুন।');
    return true;
  }

  function detectViaGemini() {
    var storedEnc = localStorage.getItem(ENC_STORAGE_KEY);
    var dims = STATE.pageDims[STATE.currentPage] || { width: canvas.width, height: canvas.height };

    setBusy(true, 'AI দিয়ে ফর্ম বিশ্লেষণ করা হচ্ছে...');

    // 1. If direct Gemini API key is configured in Settings, use it
    if (storedEnc) {
      return decryptApiKey(storedEnc).then(function (apiKey) {
        if (!apiKey || !apiKey.trim()) throw new Error('API Key নেই');
        return renderOffscreenForGemini(dims).then(function (dataUrl) {
          var base64 = dataUrl.split(',')[1];
          return callDirectGeminiWithFallback(apiKey.trim(), base64);
        });
      }).then(function (json) {
        setBusy(false);
        handleGeminiApiResponse(json);
      }).catch(function (directErr) {
        console.warn('Direct Gemini call failed, attempting server endpoint fallback...', directErr);
        return tryCloudflareBackend(dims);
      });
    }

    // 2. Cloudflare Worker API fallback (/api/form-filler-ai)
    return tryCloudflareBackend(dims);
  }

  function tryCloudflareBackend(dims) {
    return renderOffscreenForGemini(dims).then(function (dataUrl) {
      var base64 = dataUrl.split(',')[1];
      return fetch('/api/form-filler-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64, mimeType: 'image/jpeg' })
      });
    }).then(function (res) {
      if (res.ok) {
        return res.json().then(function (json) {
          setBusy(false);
          handleGeminiApiResponse(json);
        });
      }
      throw new Error('সার্ভার সাড়া দেয়নি (HTTP ' + res.status + ')');
    }).catch(function (err) {
      setBusy(false);
      // Gentle notification without forcing tab switch
      toast('💡 AI স্ক্যান করতে সেটিংসে আপনার Gemini Key দিতে পারেন, অথবা "আঁকুন" মোডে নিজেই সহজে ফিল্ড বসিয়ে নিতে পারেন।');
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
    var searchQ = ($('#fieldSearchInput') && $('#fieldSearchInput').value || '').trim().toLowerCase();

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
      if (searchQ && ((f.label && f.label.toLowerCase().includes(searchQ)) || (typeof f.value === 'string' && f.value.toLowerCase().includes(searchQ)))) {
        box.classList.add('search-matched');
      }
      box.style.left = leftPx + 'px';
      box.style.top = topPx + 'px';
      box.style.width = wPx + 'px';
      box.style.height = hPx + 'px';
      box.dataset.fieldId = f.id;

      // Always include a move handle badge indicating field name & drag capability
      var moveBadge = document.createElement('div');
      moveBadge.className = 'field-move-handle';
      moveBadge.title = 'মাউস দিয়ে ধরে সঠিক জায়গায় সরান';
      moveBadge.innerHTML = '✥ ' + escapeHtml(f.label);
      box.appendChild(moveBadge);

      if (STATE.mode === 'fill') {
        if (f.type === 'checkbox') {
          if (f.value) {
            var chk = document.createElement('span');
            chk.className = 'overlay-check';
            var baseBoxDim = Math.min(wPx, hPx);
            var scaleMultiplier = STATE.font.checkScale || 0.8;
            var checkFontSize = Math.max(9, Math.round(baseBoxDim * scaleMultiplier));
            chk.style.fontSize = checkFontSize + 'px';
            chk.style.color = STATE.font.color;
            chk.textContent = f.checkSymbol || STATE.font.checkSymbol;
            box.appendChild(chk);
          } else if (STATE.hoveredFieldId === f.id) {
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
          var fieldBaseSize = f.fontSize || STATE.font.size;
          var fontSizePx = Math.max(1, Math.round(fieldBaseSize * scaleUsed * STATE.zoom));
          span.style.fontSize = fontSizePx + 'px';
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
      }

      // Universal resize handles: allows dragging with mouse to make field longer/shorter (↔) or taller/shorter (↕)
      ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(function (dir) {
        var h = document.createElement('div');
        h.className = 'resize-handle handle-' + dir;
        h.dataset.handle = dir;
        if (dir === 'e' || dir === 'w') {
          h.title = 'মাউস দিয়ে টেনে ডানে/বামে লম্বা বা খাটো করুন (↔)';
        } else if (dir === 'n' || dir === 's') {
          h.title = 'মাউস দিয়ে টেনে উপরে/নিচে সাইজ পরিবর্তন করুন (↕)';
        } else {
          h.title = 'মাউস দিয়ে টেনে কোণা বরাবর সাইজ পরিবর্তন করুন';
        }
        box.appendChild(h);
      });

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
      return (f.value ? 'ক্লিক করলে "' + sym + '" উঠে যাবে (আন-টিক)' : 'ক্লিক করলে "' + sym + '" বসবে') + ' • ধরে সরান বা হ্যান্ডেল টেনে সাইজ বদলান — ' + f.label;
    }
    if (f.type === 'textarea') return '✏️ এখানে লিখুন • হ্যান্ডেল টেনে সাইজ বদলান • ধরে সরান — ' + f.label;
    return '✏️ এখানে লিখুন • ডানের হ্যান্ডেল টেনে লম্বা/খাটো করুন (↔) — ' + f.label;
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
    if (e.target && e.target.classList && e.target.classList.contains('resize-handle')) {
      hideHoverTip();
      return;
    }
    var target = e.target.closest('.field-box');
    if (!target || dragSession || resizing || drawing) return;
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
    if (toEl === target) return;
    hideHoverTip();
  });

  overlay.addEventListener('mouseleave', function () { hideHoverTip(); });

  // Floating Drag Position Indicator
  var dragIndicatorEl = null;
  function showMoveTooltip(f, clientX, clientY, xNorm, yNorm) {
    if (!dragIndicatorEl) {
      dragIndicatorEl = document.createElement('div');
      dragIndicatorEl.className = 'sff-drag-indicator';
      document.body.appendChild(dragIndicatorEl);
    }
    var pctX = Math.round(xNorm * 100);
    var pctY = Math.round(yNorm * 100);
    dragIndicatorEl.innerHTML = '<span>📍</span> <strong>' + escapeHtml(f.label) + '</strong> <span style="opacity:0.75; font-size:10.5px;">(' + pctX + '%, ' + pctY + '%)</span>';
    dragIndicatorEl.style.left = (clientX + 14) + 'px';
    dragIndicatorEl.style.top = (clientY + 14) + 'px';
    dragIndicatorEl.style.display = 'flex';
  }

  function hideMoveTooltip() {
    if (dragIndicatorEl) dragIndicatorEl.style.display = 'none';
  }

  // =========================================================================
  // QUICK STAMP TOOLBAR (টিক চিহ্ন, টেক্সট, তারিখ, স্বাক্ষর দ্রুত বসানো)
  // =========================================================================
  var activeStampTool = null;

  function setStampTool(tool) {
    activeStampTool = tool;
    $all('.stamp-tool-btn').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.stamp === tool);
    });
    if (tool) {
      var toolNames = {
        tick: 'টিক চিহ্ন (✓)',
        text: 'নতুন টেক্সট ফিল্ড',
        cross: 'ক্রস চিহ্ন (✗)'
      };
      toast('👉 ' + (toolNames[tool] || tool) + ' সক্রিয়: ফর্মে যেখানে বসাতে চান সেখানে ক্লিক করুন');
    }
  }

  function applyStampAtPosition(tool, clientX, clientY) {
    if (!STATE.imageElement && !STATE.pdfDoc) {
      toast('দয়া করে প্রথমে একটি ফর্ম বা PDF আপলোড করুন');
      return;
    }
    var r = overlay.getBoundingClientRect();
    var clickX = clientX - r.left;
    var clickY = clientY - r.top;
    var stageW = canvas.width * STATE.zoom;
    var stageH = canvas.height * STATE.zoom;
    var normX = Math.max(0, Math.min(0.96, clickX / stageW));
    var normY = Math.max(0, Math.min(0.98, clickY / stageH));

    if (tool === 'tick') {
      var f = addField({
        xNorm: Math.max(0, normX - 0.0075),
        yNorm: Math.max(0, normY - 0.007),
        wNorm: 0.015,
        hNorm: 0.014,
        type: 'checkbox',
        label: 'টিক চিহ্ন (✓)',
        checkSymbol: '✓',
        value: true
      });
      STATE.selectedFieldId = f.id;
      renderOverlay();
      renderFieldsList();
      toast('✓ টিক চিহ্ন বসানো হয়েছে');
    } else if (tool === 'cross') {
      var f = addField({
        xNorm: Math.max(0, normX - 0.0075),
        yNorm: Math.max(0, normY - 0.007),
        wNorm: 0.015,
        hNorm: 0.014,
        type: 'checkbox',
        label: 'ক্রস চিহ্ন (✗)',
        checkSymbol: '✗',
        value: true
      });
      STATE.selectedFieldId = f.id;
      renderOverlay();
      renderFieldsList();
      toast('✓ ক্রস চিহ্ন বসানো হয়েছে');
    } else if (tool === 'text') {
      var f = addField({
        xNorm: Math.max(0, normX),
        yNorm: Math.max(0, normY - 0.008),
        wNorm: 0.16,
        hNorm: 0.020,
        type: 'text',
        label: 'টেক্সট ফিল্ড',
        value: ''
      });
      STATE.selectedFieldId = f.id;
      renderOverlay();
      renderFieldsList();
      openInlineEditor(f);
      toast('✓ লেখার ফিল্ড যোগ করা হয়েছে');
    } else if (tool === 'date') {
      var d = new Date();
      var todayStr = String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
      var f = addField({
        xNorm: Math.max(0, normX),
        yNorm: Math.max(0, normY - 0.008),
        wNorm: 0.12,
        hNorm: 0.020,
        type: 'text',
        label: 'তারিখ',
        value: todayStr
      });
      STATE.selectedFieldId = f.id;
      renderOverlay();
      renderFieldsList();
      toast('✓ আজকের তারিখ বসানো হয়েছে: ' + todayStr);
    } else if (tool === 'signature') {
      var f = addField({
        xNorm: Math.max(0, normX),
        yNorm: Math.max(0, normY - 0.008),
        wNorm: 0.18,
        hNorm: 0.022,
        type: 'text',
        label: 'স্বাক্ষর / নাম',
        value: ''
      });
      STATE.selectedFieldId = f.id;
      renderOverlay();
      renderFieldsList();
      openInlineEditor(f);
      toast('✓ স্বাক্ষর বক্স যোগ করা হয়েছে');
    }
  }

  // =========================================================================
  // INTERACTION: Universal Direct Mouse Dragging, Resizing, Drawing & Filling
  // =========================================================================
  var drawing = null;
  var dragSession = null;
  var resizing = null;

  function onPointerDown(e) {
    var isTouch = !!e.touches;
    var clientX = isTouch ? e.touches[0].clientX : e.clientX;
    var clientY = isTouch ? e.touches[0].clientY : e.clientY;
    var target = e.target.closest ? e.target.closest('.field-box') : null;
    hideHoverTip();

    // 1. Quick Stamp Active
    if (activeStampTool) {
      if (target && target.classList.contains('checkbox-type')) {
        var cbField = STATE.fields.find(function (x) { return x.id === target.dataset.fieldId; });
        if (cbField) {
          cbField.value = !cbField.value;
          renderOverlay();
          renderFieldsList();
          toast((cbField.value ? '✓ টিক দেওয়া হয়েছে: ' : 'টিক সরানো হয়েছে: ') + cbField.label);
        }
      } else {
        applyStampAtPosition(activeStampTool, clientX, clientY);
      }
      if (!isTouch) e.preventDefault();
      return;
    }

    if (STATE.mode === 'draw' && !target) {
      var r = overlay.getBoundingClientRect();
      drawing = { x: clientX - r.left, y: clientY - r.top };
      var box = document.createElement('div');
      box.className = 'drawing-box';
      box.style.left = drawing.x + 'px';
      box.style.top = drawing.y + 'px';
      overlay.appendChild(box);
      drawing.el = box;
      if (!isTouch) e.preventDefault();
      return;
    }

    if (target) {
      var handle = e.target.dataset.handle;
      var fieldId = target.dataset.fieldId;
      var f = STATE.fields.find(function (x) { return x.id === fieldId; });
      if (!f) return;

      // Universal mouse dragging handles: pull East handle to make longer/shorter (↔), or corners/edges
      if (handle) {
        closeInlineEditor(true);
        resizing = {
          id: fieldId,
          handle: handle,
          startClientX: clientX,
          startClientY: clientY,
          x: f.xNorm,
          y: f.yNorm,
          w: f.wNorm,
          h: f.hNorm,
          isMoved: false
        };
        STATE.selectedFieldId = fieldId;
        $all('.field-box', overlay).forEach(function (b) {
          b.classList.toggle('is-selected', b.dataset.fieldId === fieldId);
        });
        document.body.classList.add('sff-is-resizing');
        if (!isTouch) e.preventDefault();
        e.stopPropagation();
        return;
      }

      // Universal drag on any field in both fill and edit modes
      dragSession = {
        id: fieldId,
        field: f,
        startClientX: clientX,
        startClientY: clientY,
        origXNorm: f.xNorm,
        origYNorm: f.yNorm,
        origWNorm: f.wNorm,
        origHNorm: f.hNorm,
        currentXNorm: f.xNorm,
        currentYNorm: f.yNorm,
        isMoved: false,
        el: target
      };

      STATE.selectedFieldId = fieldId;
      $all('.field-box', overlay).forEach(function (b) {
        b.classList.toggle('is-selected', b.dataset.fieldId === fieldId);
      });

      e.preventDefault();
    }
  }

  function onPointerMove(e) {
    var isTouch = !!e.touches;
    var clientX = isTouch ? e.touches[0].clientX : e.clientX;
    var clientY = isTouch ? e.touches[0].clientY : e.clientY;

    if (drawing) {
      var r = overlay.getBoundingClientRect();
      var cx = Math.max(0, Math.min(r.width, clientX - r.left));
      var cy = Math.max(0, Math.min(r.height, clientY - r.top));
      var left = Math.min(drawing.x, cx), top = Math.min(drawing.y, cy);
      var w = Math.abs(cx - drawing.x), h = Math.abs(cy - drawing.y);
      drawing.el.style.left = left + 'px';
      drawing.el.style.top = top + 'px';
      drawing.el.style.width = w + 'px';
      drawing.el.style.height = h + 'px';
      drawing.w = w; drawing.h = h; drawing.finalLeft = left; drawing.finalTop = top;
      if (isTouch) e.preventDefault();
      return;
    }

    if (resizing) {
      var f = STATE.fields.find(function (x) { return x.id === resizing.id; });
      if (!f) return;
      var dist = Math.hypot(clientX - resizing.startClientX, clientY - resizing.startClientY);
      if (dist >= 2) {
        resizing.isMoved = true;
      }
      var stageW2 = canvas.width * STATE.zoom, stageH2 = canvas.height * STATE.zoom;
      var ddx = (clientX - resizing.startClientX) / stageW2;
      var ddy = (clientY - resizing.startClientY) / stageH2;
      var x = resizing.x, y = resizing.y, w = resizing.w, h = resizing.h;
      var hd = resizing.handle;
      if (hd.indexOf('e') !== -1) w = Math.max(0.005, Math.min(1 - x, resizing.w + ddx));
      if (hd.indexOf('s') !== -1) h = Math.max(0.005, Math.min(1 - y, resizing.h + ddy));
      if (hd.indexOf('w') !== -1) { var nw = resizing.w - ddx; if (nw > 0.005 && (resizing.x + ddx >= 0)) { x = resizing.x + ddx; w = nw; } }
      if (hd.indexOf('n') !== -1) { var nh = resizing.h - ddy; if (nh > 0.005 && (resizing.y + ddy >= 0)) { y = resizing.y + ddy; h = nh; } }
      updateField(resizing.id, { xNorm: x, yNorm: y, wNorm: w, hNorm: h });
      if (isTouch) e.preventDefault();
      return;
    }

    if (dragSession) {
      var dist = Math.hypot(clientX - dragSession.startClientX, clientY - dragSession.startClientY);
      var threshold = (STATE.mode === 'fill') ? 10 : 5;
      if (dist >= threshold || dragSession.isMoved) {
        dragSession.isMoved = true;
        dragSession.el.classList.add('is-dragging');
        document.body.classList.add('sff-is-dragging');

        var scaleUsed = currentCanvasScale();
        var offset = offsetInCanvasPx(scaleUsed);
        var stageW = canvas.width * STATE.zoom;
        var stageH = canvas.height * STATE.zoom;
        var dxNorm = (clientX - dragSession.startClientX) / stageW;
        var dyNorm = (clientY - dragSession.startClientY) / stageH;

        var newXNorm = Math.max(0, Math.min(1 - dragSession.origWNorm, dragSession.origXNorm + dxNorm));
        var newYNorm = Math.max(0, Math.min(1 - dragSession.origHNorm, dragSession.origYNorm + dyNorm));

        dragSession.currentXNorm = newXNorm;
        dragSession.currentYNorm = newYNorm;

        // Smooth real-time DOM position update
        var leftPx = (newXNorm * canvas.width + offset.x) * STATE.zoom;
        var topPx = (newYNorm * canvas.height + offset.y) * STATE.zoom;
        dragSession.el.style.left = leftPx + 'px';
        dragSession.el.style.top = topPx + 'px';

        showMoveTooltip(dragSession.field, clientX, clientY, newXNorm, newYNorm);
      }
      if (isTouch) e.preventDefault();
      return;
    }
  }

  function onPointerUp() {
    hideMoveTooltip();
    document.body.classList.remove('sff-is-dragging');
    document.body.classList.remove('sff-is-resizing');

    if (resizing) {
      var wasMoved = resizing.isMoved;
      resizing = null;
      if (wasMoved) {
        renderFieldsList();
        toast('↔ ফিল্ড সাইজ সংরক্ষণ করা হয়েছে');
      }
      return;
    }

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

    if (dragSession) {
      dragSession.el.classList.remove('is-dragging');
      if (dragSession.isMoved) {
        updateField(dragSession.id, {
          xNorm: dragSession.currentXNorm,
          yNorm: dragSession.currentYNorm
        });
        toast('📍 ফিল্ডের সঠিক অবস্থান সংরক্ষণ করা হয়েছে (' + dragSession.field.label + ')');
      } else {
        // Simple click without dragging
        var clickedField = dragSession.field;
        if (STATE.mode === 'fill') {
          if (clickedField.type === 'checkbox') {
            updateField(clickedField.id, { value: !clickedField.value });
            renderFieldsList();
            toast((clickedField.value ? '✓ টিক দেওয়া হয়েছে: ' : 'টিক সরানো হয়েছে: ') + clickedField.label);
          } else {
            openInlineEditor(clickedField);
            var input = document.getElementById('val_' + clickedField.id);
            if (input) {
              input.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
          }
        } else if (STATE.mode === 'edit') {
          renderOverlay();
          renderFieldsList();
        }
      }
      dragSession = null;
    }

    resizing = null;
  }

  overlay.addEventListener('mousedown', onPointerDown);
  window.addEventListener('mousemove', onPointerMove);
  window.addEventListener('mouseup', onPointerUp);

  overlay.addEventListener('touchstart', onPointerDown, { passive: false });
  window.addEventListener('touchmove', onPointerMove, { passive: false });
  window.addEventListener('touchend', onPointerUp);

  // Keyboard Fine-Nudging (Arrow Keys)
  window.addEventListener('keydown', function (e) {
    var tag = (document.activeElement && document.activeElement.tagName) ? document.activeElement.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || (document.activeElement && document.activeElement.isContentEditable)) return;
    if (!STATE.selectedFieldId) return;

    var f = STATE.fields.find(function (x) { return x.id === STATE.selectedFieldId; });
    if (!f || f.page !== STATE.currentPage) return;

    var step = e.shiftKey ? 0.01 : 0.002;
    var handled = false;

    if (e.key === 'ArrowLeft') {
      f.xNorm = Math.max(0, f.xNorm - step);
      handled = true;
    } else if (e.key === 'ArrowRight') {
      f.xNorm = Math.min(1 - f.wNorm, f.xNorm + step);
      handled = true;
    } else if (e.key === 'ArrowUp') {
      f.yNorm = Math.max(0, f.yNorm - step);
      handled = true;
    } else if (e.key === 'ArrowDown') {
      f.yNorm = Math.min(1 - f.hNorm, f.yNorm + step);
      handled = true;
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (STATE.mode === 'edit') {
        removeField(f.id);
        handled = true;
      }
    }

    if (handled) {
      e.preventDefault();
      renderOverlay();
    }
  });

  // =========================================================================
  // DIRECT ON-FORM DOUBLE-CLICK FILLING (Floating Inline Editor)
  var activeInlineEditor = null;
  var onDocClickOutsideHandler = null;
  var outsideTimeout = null;

  function closeInlineEditor(save) {
    if (outsideTimeout) {
      clearTimeout(outsideTimeout);
      outsideTimeout = null;
    }
    if (onDocClickOutsideHandler) {
      document.removeEventListener('pointerdown', onDocClickOutsideHandler);
      onDocClickOutsideHandler = null;
    }
    if (!activeInlineEditor) return;
    var ed = activeInlineEditor;
    activeInlineEditor = null;

    if (save && ed.input) {
      var val = ed.input.value;
      var f = STATE.fields.find(function (x) { return x.id === ed.fieldId; });
      updateField(ed.fieldId, { value: val, fontSize: (f ? f.fontSize : undefined) });
      var sidebarInp = document.getElementById('val_' + ed.fieldId);
      if (sidebarInp) sidebarInp.value = val;
    }
    if (ed.wrap && ed.wrap.parentNode) {
      ed.wrap.parentNode.removeChild(ed.wrap);
    }
    renderOverlay();
  }

  function openInlineEditor(field) {
    closeInlineEditor(true);

    var scaleUsed = currentCanvasScale();
    var offset = offsetInCanvasPx(scaleUsed);
    var leftPx = (field.xNorm * canvas.width + offset.x) * STATE.zoom;
    var topPx = (field.yNorm * canvas.height + offset.y) * STATE.zoom;
    var wPx = Math.max(80, (field.wNorm * canvas.width) * STATE.zoom);
    var hPx = Math.max(26, (field.hNorm * canvas.height) * STATE.zoom);

    var wrap = document.createElement('div');
    wrap.className = 'sff-inline-editor-wrap';
    wrap.style.left = leftPx + 'px';
    wrap.style.top = topPx + 'px';
    wrap.style.width = wPx + 'px';

    var isTextarea = field.type === 'textarea';
    var input = isTextarea ? document.createElement('textarea') : document.createElement('input');
    input.className = 'sff-inline-editor-input';
    if (!isTextarea) input.type = (field.type === 'number' ? 'number' : 'text');
    input.value = field.value || '';
    input.placeholder = field.label || 'এখানে লিখুন...';

    var curFontSize = field.fontSize || STATE.font.size;
    function calcInputFontSize(fs) {
      return Math.max(1, Math.round(fs * scaleUsed * STATE.zoom));
    }
    input.style.fontSize = calcInputFontSize(curFontSize) + 'px';
    input.style.fontFamily = STATE.font.family;
    input.style.fontWeight = STATE.font.weight;
    input.style.color = STATE.font.color;
    input.style.height = hPx + 'px';

    var badge = document.createElement('div');
    badge.className = 'sff-inline-editor-badge';
    badge.innerHTML = '<span class="sff-inline-badge-title">' + escapeHtml(field.label) + '</span>' +
      '<div class="sff-inline-font-controls">' +
        '<button type="button" class="sff-font-btn" id="sffInlineDec" title="ফন্ট ছোট করুন (A-)">A−</button>' +
        '<span class="sff-font-size-label" id="sffInlineSize">' + curFontSize + 'px</span>' +
        '<button type="button" class="sff-font-btn" id="sffInlineInc" title="ফন্ট বড় করুন (A+)">A+</button>' +
        '<button type="button" class="sff-font-btn sff-font-autofit" id="sffInlineFit" title="বক্সের মাপে ফন্ট অটো-ফিট করুন">⚡ Auto</button>' +
      '</div>' +
      '<span style="font-size:9.5px; opacity:0.8; margin-left:4px;">[Enter] সেভ • [Tab] পরেরটি</span>';

    // Prevent focus loss when clicking font size controls
    badge.addEventListener('mousedown', function (e) {
      wrap.dataset.hovered = 'true';
      if (e.target.closest('.sff-font-btn')) {
        e.preventDefault();
      }
    });

    var decBtn = badge.querySelector('#sffInlineDec');
    if (decBtn) {
      decBtn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        wrap.dataset.hovered = 'true';
        var cur = field.fontSize || STATE.font.size;
        var next = Math.max(1, cur - 1);
        field.fontSize = next;
        updateField(field.id, { fontSize: next });
        badge.querySelector('#sffInlineSize').textContent = next + 'px';
        input.style.fontSize = calcInputFontSize(next) + 'px';
        renderFieldsList();
        input.focus();
      });
    }

    var incBtn = badge.querySelector('#sffInlineInc');
    if (incBtn) {
      incBtn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        wrap.dataset.hovered = 'true';
        var cur = field.fontSize || STATE.font.size;
        var next = Math.min(36, cur + 1);
        field.fontSize = next;
        updateField(field.id, { fontSize: next });
        badge.querySelector('#sffInlineSize').textContent = next + 'px';
        input.style.fontSize = calcInputFontSize(next) + 'px';
        renderFieldsList();
        input.focus();
      });
    }

    var fitBtn = badge.querySelector('#sffInlineFit');
    if (fitBtn) {
      fitBtn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var text = input.value || field.value || '';
        if (!text) {
          toast('আগে কিছু টেক্সট লিখুন');
          return;
        }
        var availWidth = (field.wNorm * canvas.width) - 8;
        var tCanvas = document.createElement('canvas');
        var tCtx = tCanvas.getContext('2d');
        var cur = field.fontSize || STATE.font.size;
        tCtx.font = STATE.font.weight + ' ' + cur + 'px ' + STATE.font.family;
        var mWidth = tCtx.measureText(text).width;
        if (mWidth > availWidth && availWidth > 15) {
          var fit = Math.max(1, Math.floor(cur * (availWidth / mWidth)));
          field.fontSize = fit;
          updateField(field.id, { fontSize: fit });
          badge.querySelector('#sffInlineSize').textContent = fit + 'px';
          input.style.fontSize = calcInputFontSize(fit) + 'px';
          renderFieldsList();
          toast('⚡ ফন্ট সাইজ ' + fit + 'px এ অটো-ফিট করা হয়েছে');
        } else {
          toast('✓ লেখাটি বক্সের সাইজের মধ্যে ঠিক আছে');
        }
        input.focus();
      });
    }

    wrap.appendChild(input);
    wrap.appendChild(badge);
    stageInner.appendChild(wrap);

    wrap.addEventListener('mouseenter', function () { wrap.dataset.hovered = 'true'; });
    wrap.addEventListener('mouseleave', function () { wrap.dataset.hovered = 'false'; });

    activeInlineEditor = { wrap: wrap, input: input, fieldId: field.id };

    setTimeout(function () {
      input.focus();
      if (input.select) input.select();
    }, 20);

    input.addEventListener('input', function () {
      field.value = input.value;
      var sidebarInp = document.getElementById('val_' + field.id);
      if (sidebarInp) sidebarInp.value = input.value;

      // Real-time auto-fit indication if text exceeds width
      var availWidth = (field.wNorm * canvas.width) - 8;
      if (availWidth > 20 && input.value.length > 3) {
        var tCanvas = document.createElement('canvas');
        var tCtx = tCanvas.getContext('2d');
        var cur = field.fontSize || STATE.font.size;
        tCtx.font = STATE.font.weight + ' ' + cur + 'px ' + STATE.font.family;
        var mWidth = tCtx.measureText(input.value).width;
        if (mWidth > availWidth) {
          var fit = Math.max(1, Math.floor(cur * (availWidth / mWidth)));
          field.fontSize = fit;
          var sizeLabel = badge.querySelector('#sffInlineSize');
          if (sizeLabel) sizeLabel.textContent = fit + 'px';
          input.style.fontSize = calcInputFontSize(fit) + 'px';
        }
      }
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (!isTextarea || e.ctrlKey)) {
        e.preventDefault();
        closeInlineEditor(true);
        toast('✓ পূরণ করা হয়েছে: ' + field.label);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeInlineEditor(false);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        closeInlineEditor(true);
        var pageFields = getPageFields();
        var idx = pageFields.findIndex(function (x) { return x.id === field.id; });
        var nextIdx = e.shiftKey ? (idx - 1) : (idx + 1);
        if (nextIdx >= 0 && nextIdx < pageFields.length) {
          var nextField = pageFields[nextIdx];
          if (nextField.type === 'checkbox') {
            nextField.value = !nextField.value;
            renderOverlay();
            renderFieldsList();
            toast((nextField.value ? '✓ টিক দেওয়া হয়েছে: ' : 'টিক সরানো হয়েছে: ') + nextField.label);
          } else {
            openInlineEditor(nextField);
          }
        }
      }
    });

    onDocClickOutsideHandler = function (e) {
      if (wrap && !wrap.contains(e.target) && !e.target.closest('.field-box')) {
        closeInlineEditor(true);
      }
    };
    outsideTimeout = setTimeout(function () {
      if (activeInlineEditor && activeInlineEditor.fieldId === field.id) {
        document.addEventListener('pointerdown', onDocClickOutsideHandler);
      }
      outsideTimeout = null;
    }, 150);
  }

  // =========================================================================
  // DIRECT ON-FORM DOUBLE-CLICK FILLING (Floating Inline Editor)
  // =========================================================================
  var lastClickTime = 0;
  var lastClickX = 0, lastClickY = 0;
  var lastDblTrigger = 0;

  function handleFormDoubleClick(e) {
    if (e.target && e.target.closest && e.target.closest('.sff-inline-editor-wrap')) return;
    var now = Date.now();
    if (now - lastDblTrigger < 300) return;
    lastDblTrigger = now;

    if (STATE.mode === 'draw') return;

    var r = overlay.getBoundingClientRect();
    var clickX = (e.clientX - r.left) / STATE.zoom;
    var clickY = (e.clientY - r.top) / STATE.zoom;
    var scaleUsed = currentCanvasScale();
    var offset = offsetInCanvasPx(scaleUsed);

    var target = (e.target && e.target.closest) ? e.target.closest('.field-box') : null;
    var field = null;

    if (target && target.dataset.fieldId) {
      field = STATE.fields.find(function (x) { return x.id === target.dataset.fieldId; });
    }
    if (!field) {
      var pageFields = getPageFields();
      field = pageFields.find(function (f) {
        var fx = f.xNorm * canvas.width + offset.x;
        var fy = f.yNorm * canvas.height + offset.y;
        var fw = f.wNorm * canvas.width;
        var fh = f.hNorm * canvas.height;
        return clickX >= fx && clickX <= (fx + fw) && clickY >= fy && clickY <= (fy + fh);
      });
    }

    if (field) {
      if (field.type === 'checkbox') {
        updateField(field.id, { value: !field.value });
        renderFieldsList();
        renderOverlay();
        toast((field.value ? '✓ টিক দেওয়া হয়েছে: ' : 'টিক সরানো হয়েছে: ') + field.label);
      } else {
        openInlineEditor(field);
      }
      return;
    }

    // Double-click on blank form canvas area: create new field and open inline editor!
    var formW = canvas.width;
    var formH = canvas.height;
    if (!formW || !formH) return;

    var defaultW = 160;
    var defaultH = 28;
    var xCanvas = Math.max(0, clickX - offset.x);
    var yCanvas = Math.max(0, clickY - offset.y);

    var newField = addField({
      xNorm: Math.min(0.85, xCanvas / formW),
      yNorm: Math.min(0.95, yCanvas / formH),
      wNorm: Math.min(0.35, defaultW / formW),
      hNorm: Math.min(0.06, defaultH / formH),
      label: 'ফিল্ড ' + (STATE.fields.length + 1),
      type: 'text',
      value: '',
      source: 'manual'
    });

    openInlineEditor(newField);
    toast('নতুন ফিল্ড যোগ হয়েছে। সরাসরি টাইপ করে Enter চাপুন।');
  }

  overlay.addEventListener('dblclick', handleFormDoubleClick);
  stageInner.addEventListener('dblclick', handleFormDoubleClick);

  // Consecutive click detector for 100% reliable double-click detection across all devices
  overlay.addEventListener('click', function (e) {
    if (e.target && e.target.closest && e.target.closest('.sff-inline-editor-wrap')) return;
    var now = Date.now();
    var dist = Math.hypot(e.clientX - lastClickX, e.clientY - lastClickY);
    if (now - lastClickTime < 380 && dist < 20) {
      handleFormDoubleClick(e);
      lastClickTime = 0;
    } else {
      lastClickTime = now;
      lastClickX = e.clientX;
      lastClickY = e.clientY;
    }
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
    if (getPageFields().length === 0 && STATE.fileType === 'pdf' && STATE.pdfDoc) {
      detectAcroFormFields().then(function (acro) {
        if (acro && acro.length > 0) {
          replacePageFields(acro);
        }
      }).catch(function () {});
    }
  }

  function renderFieldsList() {
    var list = $('#fieldsList');
    var fields = getPageFields();
    list.innerHTML = '';

    var searchQ = '';
    var searchInput = $('#fieldSearchInput');
    if (searchInput) searchQ = (searchInput.value || '').trim().toLowerCase();

    if (searchQ) {
      fields = fields.filter(function (f) {
        return (f.label && f.label.toLowerCase().includes(searchQ)) ||
               (typeof f.value === 'string' && f.value.toLowerCase().includes(searchQ));
      });
    }

    if (fields.length === 0) {
      if (searchQ) {
        list.innerHTML = '<p class="hint">"' + escapeHtml(searchQ) + '" দিয়ে কোনো ফিল্ড পাওয়া যায়নি।</p>';
      } else {
        list.innerHTML = '<p class="hint">এই পাতায় কোনো ফিল্ড নেই। "ফিল্ড খুঁজুন" চাপুন অথবা "আঁকুন" মোডে হাতে বসান।</p>';
      }
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
    labelInput.className = 'field-label-input locked';
    labelInput.value = f.label;
    labelInput.readOnly = true;
    labelInput.tabIndex = -1; // Skip in Tab navigation
    labelInput.title = 'নাম বদলাতে এডিট (✏️) চাপুন বা ডাবল ক্লিক করুন';

    function unlockLabel() {
      labelInput.readOnly = false;
      labelInput.tabIndex = 0;
      labelInput.classList.remove('locked');
      labelInput.focus();
      if (labelInput.select) labelInput.select();
    }

    function lockLabel() {
      labelInput.readOnly = true;
      labelInput.tabIndex = -1;
      labelInput.classList.add('locked');
      var newLabel = labelInput.value.trim();
      if (!newLabel) {
        labelInput.value = f.label;
      } else if (newLabel !== f.label) {
        updateField(f.id, { label: newLabel });
      }
    }

    labelInput.addEventListener('dblclick', unlockLabel);
    labelInput.addEventListener('blur', lockLabel);
    labelInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        lockLabel();
      } else if (e.key === 'Escape') {
        labelInput.value = f.label;
        lockLabel();
      }
    });

    var renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'field-rename-btn';
    renameBtn.textContent = '✏️';
    renameBtn.tabIndex = -1; // Skip in Tab navigation
    renameBtn.title = 'ফিল্ডের নাম পরিবর্তন করুন';
    renameBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (labelInput.readOnly) unlockLabel();
      else lockLabel();
    });

    var tag = document.createElement('span');
    tag.className = 'field-tag ' + f.source;
    tag.textContent = f.source === 'acroform' ? 'AcroForm' : (f.source === 'gemini' ? 'Gemini' : (f.source === 'template' ? 'টেমপ্লেট' : 'হাতে'));

    var del = document.createElement('button');
    del.className = 'field-del';
    del.textContent = '×';
    del.tabIndex = -1; // Skip in Tab navigation
    del.title = 'ফিল্ড মুছুন';
    del.addEventListener('click', function () { removeField(f.id); });

    head.appendChild(labelInput);
    head.appendChild(renameBtn);

    if (f.type !== 'checkbox') {
      var fontCtrl = document.createElement('div');
      fontCtrl.className = 'field-font-control';
      var curSize = f.fontSize || STATE.font.size;
      fontCtrl.innerHTML = '<button type="button" class="field-font-btn dec" title="ফন্ট ছোট করুন (A-)">A−</button>' +
                           '<span class="field-font-val">' + curSize + '</span>' +
                           '<button type="button" class="field-font-btn inc" title="ফন্ট বড় করুন (A+)">A+</button>';
      fontCtrl.querySelector('.dec').addEventListener('click', function (e) {
        e.stopPropagation();
        var s = Math.max(1, (f.fontSize || STATE.font.size) - 1);
        updateField(f.id, { fontSize: s });
        renderOverlay();
        renderFieldsList();
      });
      fontCtrl.querySelector('.inc').addEventListener('click', function (e) {
        e.stopPropagation();
        var s = Math.min(36, (f.fontSize || STATE.font.size) + 1);
        updateField(f.id, { fontSize: s });
        renderOverlay();
        renderFieldsList();
      });
      head.appendChild(fontCtrl);
    }

    head.appendChild(tag);
    head.appendChild(del);
    card.appendChild(head);

    if (f.type === 'checkbox') {
      var row = document.createElement('label');
      row.className = 'field-checkbox-row';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.tabIndex = 0; // Focusable via Tab
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
      ta.tabIndex = 0; // Focusable via Tab
      ta.value = f.value || '';
      ta.addEventListener('input', function () { updateField(f.id, { value: ta.value }); });
      card.appendChild(ta);
    } else {
      var inp = document.createElement('input');
      inp.className = 'field-value-input';
      inp.id = 'val_' + f.id;
      inp.tabIndex = 0; // Focusable via Tab
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
  // SETTINGS (AI Configuration & Printer Tuning)
  // =========================================================================
  // =========================================================================
  // SETTINGS (Google Gemini Encrypted AI Configuration & Printer Tuning)
  // =========================================================================
  function updateApiKeyUI() {
    var stored = localStorage.getItem(ENC_STORAGE_KEY);
    var badge = $('#geminiKeyStatusBadge');
    var notice = $('#geminiKeyStatusNotice');
    var input = $('#geminiApiKeyInput');
    if (!badge || !notice || !input) return;

    if (stored) {
      badge.textContent = '🔒 এনক্রিপ্টেড (Active)';
      badge.className = 'sff-status-badge badge-encrypted';
      notice.className = 'sff-status-notice notice-encrypted';
      notice.innerHTML = '🔒 <strong>Gemini API Key সক্রিয় ও সুরক্ষিত:</strong> আপনার API Key টি ব্রাউজারে AES-256 দিয়ে এনক্রিপ্ট করে সেভ করা রয়েছে (অনিরাপদ প্লেইন টেক্সট হিসেবে নয়)।';
      if (!input.dataset.viewingRaw) {
        input.value = '••••••••••••••••••••••••••••••••';
        input.type = 'password';
      }
    } else {
      badge.textContent = '⚠️ Key নেই';
      badge.className = 'sff-status-badge badge-warning';
      notice.className = 'sff-status-notice notice-warning';
      notice.innerHTML = '⚠️ <strong>কোনো API Key সেট করা নেই:</strong> AI ফিল্ড ডিটেকশন ব্যবহার করতে উপরে আপনার Gemini API Key দিন।';
      input.value = '';
      input.type = 'password';
      delete input.dataset.viewingRaw;
    }
  }

  // Auto-migrate legacy key if exists
  var legacyVal = localStorage.getItem('sff_worker_url') || '';
  if (legacyVal && (legacyVal.startsWith('AIza') || (/^[A-Za-z0-9_\-]{28,}$/.test(legacyVal) && !legacyVal.includes('/')))) {
    encryptApiKey(legacyVal).then(function (enc) {
      if (enc) localStorage.setItem(ENC_STORAGE_KEY, enc);
      localStorage.removeItem('sff_worker_url');
      updateApiKeyUI();
    });
  } else {
    localStorage.removeItem('sff_worker_url');
  }

  updateApiKeyUI();

  var btnToggleKey = $('#btnToggleKeyVisibility');
  if (btnToggleKey) {
    btnToggleKey.addEventListener('click', function () {
      var input = $('#geminiApiKeyInput');
      var stored = localStorage.getItem(ENC_STORAGE_KEY);
      if (!input) return;
      if (input.type === 'password') {
        if (stored) {
          decryptApiKey(stored).then(function (plain) {
            if (plain) {
              input.value = plain;
              input.dataset.viewingRaw = 'true';
              input.type = 'text';
              btnToggleKey.textContent = '🙈';
            }
          });
        } else {
          input.type = 'text';
          btnToggleKey.textContent = '🙈';
        }
      } else {
        input.type = 'password';
        btnToggleKey.textContent = '👁️';
        if (stored) {
          input.value = '••••••••••••••••••••••••••••••••';
          delete input.dataset.viewingRaw;
        }
      }
    });
  }

  var btnSaveApiKey = $('#btnSaveApiKey');
  if (btnSaveApiKey) {
    btnSaveApiKey.addEventListener('click', function () {
      var input = $('#geminiApiKeyInput');
      var val = (input ? input.value : '').trim();
      if (!val || val.startsWith('••••')) {
        toast('অনুগ্রহ করে আপনার আসল Gemini API Key পেস্ট করুন।');
        return;
      }
      setBusy(true, 'Key এনক্রিপ্ট করা হচ্ছে...');
      encryptApiKey(val).then(function (enc) {
        setBusy(false);
        if (!enc) {
          toast('API Key এনক্রিপ্ট করা যায়নি।');
          return;
        }
        localStorage.setItem(ENC_STORAGE_KEY, enc);
        if (input) {
          delete input.dataset.viewingRaw;
        }
        updateApiKeyUI();
        toast('🔒 Google Gemini API Key সফলভাবে AES-256 এনক্রিপ্ট করে সেভ করা হয়েছে!');
      }).catch(function (err) {
        setBusy(false);
        toast('এনক্রিপশন সমস্যা: ' + err.message);
      });
    });
  }

  var btnClearApiKey = $('#btnClearApiKey');
  if (btnClearApiKey) {
    btnClearApiKey.addEventListener('click', function () {
      if (confirm('সংরক্ষিত API Key টি মুছে ফেলতে চান?')) {
        localStorage.removeItem(ENC_STORAGE_KEY);
        var input = $('#geminiApiKeyInput');
        if (input) {
          input.value = '';
          input.type = 'password';
          delete input.dataset.viewingRaw;
        }
        updateApiKeyUI();
        toast('API Key মুছে ফেলা হয়েছে।');
      }
    });
  }

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
  var checkSizeInput = $('#checkSizeInput');
  if (checkSizeInput) {
    checkSizeInput.addEventListener('change', function () {
      STATE.font.checkScale = parseFloat(checkSizeInput.value) || 1.6;
      renderOverlay();
    });
  }

  // =========================================================================
  // TEMPLATES (localStorage UI Handlers)
  // =========================================================================
  $('#btnSaveTemplate').addEventListener('click', function () {
    if (STATE.fields.length === 0) { toast('সেভ করার মতো কোনো ফিল্ড নেই।'); return; }
    var name = $('#templateNameInput').value.trim() || ('টেমপ্লেট ' + new Date().toLocaleDateString('bn-BD'));
    var tpls = getTemplates();
    var dims = STATE.pageDims[STATE.currentPage];
    var aspect = (dims && dims.width && dims.height) ? (dims.width / dims.height).toFixed(3) : null;

    var newTpl = {
      id: uid('tpl'),
      name: name,
      fileName: STATE.fileName,
      fileSize: STATE.fileSize || 0,
      fileHash: STATE.fileHash || null,
      totalPages: STATE.totalPages || 1,
      aspectRatio: aspect,
      fields: STATE.fields.map(function (f) {
        return { page: f.page, label: f.label, type: f.type, xNorm: f.xNorm, yNorm: f.yNorm, wNorm: f.wNorm, hNorm: f.hNorm };
      }),
      printerOffsetMm: Object.assign({}, STATE.printerOffsetMm),
      createdAt: new Date().toISOString()
    };

    var existingIdx = tpls.findIndex(function (x) {
      return (x.name && x.name === name) || (newTpl.fileHash && x.fileHash === newTpl.fileHash);
    });
    if (existingIdx !== -1) {
      newTpl.id = tpls[existingIdx].id;
      tpls[existingIdx] = newTpl;
    } else {
      tpls.unshift(newTpl);
    }

    saveTemplates(tpls);
    STATE.matchedTemplateId = newTpl.id;
    $('#templateNameInput').value = '';
    renderTemplatesList();
    toast('টেমপ্লেট "' + name + '" সংরক্ষিত হয়েছে। পরবর্তীতে এই ফর্ম আপলোড করলে এটি স্বয়ংক্রিয়ভাবে চিনে নেবে!');
  });

  function renderTemplatesList() {
    var list = $('#templatesList');
    var tpls = getTemplates();
    list.innerHTML = '';
    if (tpls.length === 0) { list.innerHTML = '<p class="hint">এখনো কোনো টেমপ্লেট সেভ করা হয়নি।</p>'; return; }
    tpls.forEach(function (t) {
      var card = document.createElement('div');
      var isActive = (t.id === STATE.matchedTemplateId);
      card.className = 'field-card' + (isActive ? ' selected' : '');
      var activeBadgeHtml = isActive ? '<span class="template-active-badge">✓ সক্রিয়</span>' : '';

      card.innerHTML = '<strong>' + escapeHtml(t.name) + '</strong>' + activeBadgeHtml +
        '<div class="review-meta">' + t.fields.length + 'টি ফিল্ড &bull; ' + escapeHtml(t.fileName || '') + '</div>';

      var actions = document.createElement('div');
      actions.className = 'review-actions';
      var loadBtn = document.createElement('button');
      loadBtn.className = 'btn-sm btn-accent';
      loadBtn.textContent = 'লোড করুন';
      loadBtn.addEventListener('click', function () {
        applyTemplate(t, false);
      });
      var delBtn = document.createElement('button');
      delBtn.className = 'btn-sm';
      delBtn.textContent = 'মুছুন';
      delBtn.addEventListener('click', function () {
        if (confirm('এই টেমপ্লেটটি মুছে ফেলতে চান?')) {
          if (STATE.matchedTemplateId === t.id) {
            STATE.matchedTemplateId = null;
            hideAutoTemplateBanner();
          }
          saveTemplates(getTemplates().filter(function (x) { return x.id !== t.id; }));
        }
      });
      actions.appendChild(loadBtn);
      actions.appendChild(delBtn);
      card.appendChild(actions);
      list.appendChild(card);
    });
  }
  renderTemplatesList();

  // Banner Actions
  var btnRescanAI = $('#btnRescanAI');
  if (btnRescanAI) {
    btnRescanAI.addEventListener('click', function () {
      hideAutoTemplateBanner();
      STATE.matchedTemplateId = null;
      renderTemplatesList();
      detectFields();
    });
  }
  var btnCloseAutoTemplate = $('#btnCloseAutoTemplate');
  if (btnCloseAutoTemplate) {
    btnCloseAutoTemplate.addEventListener('click', function () {
      hideAutoTemplateBanner();
    });
  }

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
          var baseBoxDim = Math.min(w, h);
          var scaleMultiplier = (font && font.checkScale) || 0.8;
          var checkFontSize = Math.max(9 * scaleUsed, Math.round(baseBoxDim * scaleMultiplier));
          targetCtx.font = '900 ' + checkFontSize + 'px "Noto Sans Bengali", Arial, sans-serif';
          targetCtx.textBaseline = 'middle';
          targetCtx.textAlign = 'center';
          targetCtx.fillText(f.checkSymbol || font.checkSymbol, x + w / 2, y + h / 2);
        }
      } else if (f.value) {
        targetCtx.fillStyle = font.color;
        var effectiveBaseSize = f.fontSize || font.size;
        var fontSize = Math.round(effectiveBaseSize * scaleUsed);
        targetCtx.font = font.weight + ' ' + fontSize + 'px ' + font.family;
        targetCtx.textBaseline = 'middle';
        targetCtx.textAlign = 'left';
        var paddingX = 4 * scaleUsed;
        var maxTextWidth = Math.max(10, w - (paddingX * 2));
        if (f.type === 'textarea') {
          var lines = String(f.value).split('\n');
          var lh = fontSize * 1.35;
          var cy = y + lh * 0.7;
          lines.forEach(function (line) {
            targetCtx.fillText(line, x + paddingX, cy);
            cy += lh;
          });
        } else {
          var textVal = String(f.value);
          var measuredW = targetCtx.measureText(textVal).width;
          if (measuredW > maxTextWidth && maxTextWidth > 15) {
            var scaledSize = Math.max(1 * scaleUsed, Math.floor(fontSize * (maxTextWidth / measuredW)));
            targetCtx.font = font.weight + ' ' + scaledSize + 'px ' + font.family;
          }
          targetCtx.fillText(textVal, x + paddingX, y + h / 2);
          targetCtx.font = font.weight + ' ' + fontSize + 'px ' + font.family;
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
  // UPLOAD / DRAG-DROP / STAMP TOOLBAR WIRING
  // =========================================================================
  $('#btnUpload').addEventListener('click', function () { $('#fileInput').click(); });
  $('#fileInput').addEventListener('change', function (e) {
    if (e.target.files[0]) handleFile(e.target.files[0]);
    e.target.value = '';
  });

  // Page View Interactive Dropzone
  var stageDropzone = $('#stageDropzone');
  if (stageDropzone) {
    stageDropzone.addEventListener('click', function () {
      $('#fileInput').click();
    });
  }
  var btnDropzoneBrowse = $('#btnDropzoneBrowse');
  if (btnDropzoneBrowse) {
    btnDropzoneBrowse.addEventListener('click', function (e) {
      e.stopPropagation();
      $('#fileInput').click();
    });
  }

  // Stamp toolbar button click and drag setup
  $all('.stamp-tool-btn').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var tool = btn.dataset.stamp;
      if (activeStampTool === tool) {
        setStampTool(null);
      } else {
        setStampTool(tool);
      }
    });

    btn.setAttribute('draggable', 'true');
    btn.addEventListener('dragstart', function (e) {
      e.dataTransfer.setData('text/plain', 'stamp:' + btn.dataset.stamp);
      e.dataTransfer.effectAllowed = 'copy';
    });
  });

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && activeStampTool) {
      setStampTool(null);
      toast('স্ট্যাম্প মোড বন্ধ করা হয়েছে');
    }
  });

  // Stage Area drag & drop handling (files and stamp tools)
  var stageArea = $('#stageArea');
  var stageDragOverlay = $('#stageDragOverlay');
  var dragDepth = 0;

  if (stageArea) {
    stageArea.addEventListener('dragenter', function (e) {
      e.preventDefault();
      dragDepth++;
      if (e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).indexOf('Files') !== -1) {
        if (STATE.pdfDoc || STATE.imageElement) {
          if (stageDragOverlay) stageDragOverlay.hidden = false;
        } else {
          var dz = $('#stageDropzone');
          if (dz) dz.classList.add('drag-hover');
        }
      }
    });

    stageArea.addEventListener('dragover', function (e) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });

    stageArea.addEventListener('dragleave', function (e) {
      e.preventDefault();
      dragDepth--;
      if (dragDepth <= 0) {
        dragDepth = 0;
        if (stageDragOverlay) stageDragOverlay.hidden = true;
        var dz = $('#stageDropzone');
        if (dz) dz.classList.remove('drag-hover');
      }
    });

    stageArea.addEventListener('drop', function (e) {
      e.preventDefault();
      dragDepth = 0;
      if (stageDragOverlay) stageDragOverlay.hidden = true;
      var dz = $('#stageDropzone');
      if (dz) dz.classList.remove('drag-hover');

      // 1. Check if a stamp tool was dragged and dropped onto canvas
      var stampData = e.dataTransfer ? e.dataTransfer.getData('text/plain') : '';
      if (stampData && stampData.indexOf('stamp:') === 0) {
        var tool = stampData.replace('stamp:', '');
        applyStampAtPosition(tool, e.clientX, e.clientY);
        return;
      }

      // 2. Check if a document file was dropped
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleFile(e.dataTransfer.files[0]);
      }
    });
  }

  var fieldSearchInput = $('#fieldSearchInput');
  if (fieldSearchInput) {
    function scrollToMatchedBox(fieldId) {
      setTimeout(function () {
        var matchedBox = overlay.querySelector('[data-field-id="' + fieldId + '"]');
        if (matchedBox && $('#stageArea')) {
          var stage = $('#stageArea');
          var bRect = matchedBox.getBoundingClientRect();
          var sRect = stage.getBoundingClientRect();
          var scrollY = (bRect.top - sRect.top) + stage.scrollTop - (stage.clientHeight / 2) + (bRect.height / 2);
          var scrollX = (bRect.left - sRect.left) + stage.scrollLeft - (stage.clientWidth / 2) + (bRect.width / 2);
          stage.scrollTo({ top: Math.max(0, scrollY), left: Math.max(0, scrollX), behavior: 'smooth' });
        }
      }, 60);
    }

    fieldSearchInput.addEventListener('input', function () {
      renderFieldsList();
      var q = (fieldSearchInput.value || '').trim().toLowerCase();
      if (q) {
        // 1. Search current page first
        var match = getPageFields().find(function (f) {
          return (f.label && f.label.toLowerCase().includes(q)) ||
                 (typeof f.value === 'string' && f.value.toLowerCase().includes(q));
        });

        // 2. If not found on current page, search across entire document (all pages)
        if (!match) {
          match = STATE.fields.find(function (f) {
            return (f.label && f.label.toLowerCase().includes(q)) ||
                   (typeof f.value === 'string' && f.value.toLowerCase().includes(q));
          });
        }

        if (match) {
          STATE.selectedFieldId = match.id;
          if (match.page && match.page !== STATE.currentPage) {
            // Auto switch to that page so user instantly sees where the match is
            STATE.currentPage = match.page;
            renderPage().then(function () {
              updateToolbar();
              renderFieldsList();
              renderOverlay();
              scrollToMatchedBox(match.id);
            });
          } else {
            renderOverlay();
            scrollToMatchedBox(match.id);
          }
        } else {
          STATE.selectedFieldId = null;
          renderOverlay();
        }
      } else {
        renderOverlay();
      }
    });

    fieldSearchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (STATE.selectedFieldId) {
          var f = STATE.fields.find(function (x) { return x.id === STATE.selectedFieldId; });
          if (f) {
            if (f.type === 'checkbox') {
              updateField(f.id, { value: !f.value });
              renderFieldsList();
              toast((f.value ? '✓ টিক দেওয়া হয়েছে: ' : 'টিক সরানো হয়েছে: ') + f.label);
            } else {
              openInlineEditor(f);
            }
          }
        }
      }
    });
  }

})();
