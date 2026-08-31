/**
 * Pragati Telecom - Modular Shared Layout System (Updated for 7 Premium Tools & Legal Pages)
 * Dynamically injects identical frosted-glass Header & dark glowing Footer across all pages.
 */

(function () {
  // 1. Detect relative base path based on current script or page location
  const currentPath = window.location.pathname;
  const isInsideSubdir = currentPath.includes('/tools/') || currentPath.includes('/guides/') || currentPath.endsWith('/tools') || currentPath.endsWith('/guides') || window.location.href.includes('/tools/') || window.location.href.includes('/guides/');
  const basePath = isInsideSubdir ? '../' : './';

  // 2. Ensure CSS is loaded
  function ensureStylesheet() {
    const cssHref = basePath + 'css/style.css';
    const existing = document.querySelector(`link[href*="style.css"]`);
    if (!existing) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = cssHref;
      document.head.appendChild(link);
    }
  }

  // 3. Header HTML Template
  function getHeaderHTML() {
    const isHome = !isInsideSubdir && (currentPath.endsWith('index.html') || currentPath.endsWith('/') || currentPath === '');
    const isPhotoStudio = currentPath.includes('photo-studio.html');
    const isSmartCard = currentPath.includes('smart-card.html');
    const isPdfMaker = currentPath.includes('pdf-maker.html') || currentPath.includes('pdf-compressor.html') || currentPath.includes('searchable-pdf.html') || currentPath.includes('pdf-editor.html');
    const isGuides = currentPath.includes('/guides/');
    const isAbout = currentPath.includes('about.html');
    const isContact = currentPath.includes('contact.html');

    return `
    <div class="nav-container">
      <!-- Brand Logo -->
      <a href="${basePath}index.html" class="brand-logo" title="Pragati Telecom Home">
        <div class="brand-icon-wrap">
          <span>⚡</span>
        </div>
        <div class="brand-text">
          <div class="brand-title">PRAGATI <span class="accent">TELECOM</span></div>
          <div class="brand-tagline">Digital Utilities &amp; Tool Portal</div>
        </div>
      </a>

      <!-- Desktop Nav Links -->
      <ul class="nav-links">
        <li>
          <a href="${basePath}index.html" class="nav-link ${isHome ? 'active' : ''}">
            <span>🏠</span> Home
          </a>
        </li>
        <li>
          <a href="${basePath}tools/photo-studio.html" class="nav-link ${isPhotoStudio ? 'active' : ''}">
            <span>📸</span> Photo Studio
          </a>
        </li>
        <li>
          <a href="${basePath}tools/smart-card.html" class="nav-link ${isSmartCard ? 'active' : ''}">
            <span>💳</span> Smart Cards
          </a>
        </li>
        <li>
          <a href="${basePath}index.html#search-bar" class="nav-link ${isPdfMaker ? 'active' : ''}">
            <span>📄</span> PDF Suite
          </a>
        </li>
        <li>
          <a href="${basePath}guides/index.html" class="nav-link ${isGuides ? 'active' : ''}">
            <span>📚</span> Guides
          </a>
        </li>
        <li>
          <a href="${basePath}about.html" class="nav-link ${isAbout ? 'active' : ''}">
            <span>ℹ️</span> About
          </a>
        </li>
        <li>
          <a href="${basePath}contact.html" class="nav-link ${isContact ? 'active' : ''}">
            <span>📞</span> Contact
          </a>
        </li>
      </ul>

      <!-- Nav Actions -->
      <div class="nav-actions">
        <a href="${basePath}index.html#search-bar" class="btn-nav-search" id="topNavSearchBtn" title="Quick Search Tools">
          <span>🔍</span> Search <span class="kbd-shortcut">/</span>
        </a>
        <a href="https://wa.me/919775096842?text=Hello%20Pragati%20Telecom" target="_blank" rel="noopener" class="btn-nav-whatsapp">
          <span>💬</span> WhatsApp
        </a>
        <button class="mobile-nav-toggle" id="mobileNavToggle" aria-label="Toggle Mobile Navigation">
          ☰
        </button>
      </div>
    </div>

    <!-- Mobile Drawer Overlay & Menu -->
    <div class="mobile-drawer-overlay" id="mobileDrawerOverlay"></div>
    <div class="mobile-drawer" id="mobileDrawer">
      <div class="drawer-header">
        <div class="brand-logo">
          <div class="brand-icon-wrap" style="width: 36px; height: 36px; font-size: 1.1rem;">⚡</div>
          <div class="brand-text">
            <div class="brand-title" style="font-size: 1.05rem;">PRAGATI <span class="accent">TELECOM</span></div>
            <div class="brand-tagline" style="font-size: 0.65rem;">Digital Seva Center</div>
          </div>
        </div>
        <button class="drawer-close-btn" id="mobileDrawerClose">✕</button>
      </div>
      <ul class="drawer-links">
        <li><a href="${basePath}index.html" class="nav-link ${isHome ? 'active' : ''}"><span>🏠</span> Home</a></li>
        <li><a href="${basePath}tools/photo-studio.html" class="nav-link ${isPhotoStudio ? 'active' : ''}"><span>📸</span> AI Photo Studio Pro</a></li>
        <li><a href="${basePath}tools/smart-card.html" class="nav-link ${isSmartCard ? 'active' : ''}"><span>💳</span> Smart Multi-Card Studio</a></li>
        <li><a href="${basePath}index.html#search-bar" class="nav-link ${isPdfMaker ? 'active' : ''}"><span>📄</span> PDF Suite &amp; Tools</a></li>
        <li><a href="${basePath}guides/index.html" class="nav-link ${isGuides ? 'active' : ''}"><span>📚</span> Knowledge Base &amp; Guides</a></li>
        <li><a href="${basePath}about.html" class="nav-link ${isAbout ? 'active' : ''}"><span>ℹ️</span> About Us</a></li>
        <li><a href="${basePath}contact.html" class="nav-link ${isContact ? 'active' : ''}"><span>📞</span> Contact Us</a></li>
        <li><a href="${basePath}privacy-policy.html" class="nav-link"><span>🔒</span> Privacy Policy</a></li>
        <li><a href="${basePath}terms.html" class="nav-link"><span>📜</span> Terms &amp; Conditions</a></li>
        <li><a href="${basePath}disclaimer.html" class="nav-link"><span>⚠️</span> Disclaimer</a></li>
      </ul>
      <div style="margin-top: auto; padding-top: 1.5rem; display: flex; flex-direction: column; gap: 0.75rem;">
        <a href="tel:9775096842" class="btn-nav-whatsapp" style="background: linear-gradient(135deg, #2563eb, #1d4ed8); justify-content: center;">
          <span>📞</span> Call: +91 9775096842
        </a>
        <a href="https://wa.me/919775096842" target="_blank" rel="noopener" class="btn-nav-whatsapp" style="justify-content: center;">
          <span>💬</span> Chat on WhatsApp
        </a>
      </div>
    </div>
    `;
  }

  // 4. Footer HTML Template
  function getFooterHTML() {
    const currentYear = new Date().getFullYear();

    return `
    <div class="footer-glow-bg"></div>
    <div class="footer-container">
      <div class="footer-grid">
        <!-- Col 1: Brand Info & Business Details -->
        <div class="footer-col">
          <div class="footer-brand-title">
            <span style="color: var(--brand-primary-light);">⚡</span> PRAGATI TELECOM
          </div>
          <p class="footer-bio">
            Independent local digital tools and utility suite based in Murshidabad. Providing browser-based passport photo cropping, searchable OCR PDF generation, PVC smart card formatting, and daily cash calculation tools.
          </p>
          <div class="business-info-card">
            <div class="business-info-row">
              <span class="business-info-icon">📍</span>
              <div><strong>Address:</strong> Kalupur Middle Para, Murshidabad, West Bengal, India</div>
            </div>
            <div class="business-info-row">
              <span class="business-info-icon">📞</span>
              <div><strong>Care &amp; Support:</strong> <a href="tel:9775096842" style="color: #60a5fa; font-weight:700;">+91 9775096842</a></div>
            </div>
            <div class="business-info-row">
              <span class="business-info-icon">✉️</span>
              <div><strong>Email:</strong> <span style="color: #cbd5e1;">support@pragatitelecom.local (Owner to update)</span></div>
            </div>
          </div>
        </div>

        <!-- Col 2: Premium Photo & Card Tools -->
        <div class="footer-col">
          <div class="footer-col-title">Photo &amp; Cards</div>
          <ul class="footer-links-list">
            <li><a href="${basePath}tools/photo-studio.html" class="footer-link">📸 AI Photo Studio Pro</a></li>
            <li><a href="${basePath}tools/smart-card.html" class="footer-link">💳 Smart Multi-Card Studio</a></li>
            <li><a href="${basePath}index.html" class="footer-link">💵 Cash Denomination Tally</a></li>
          </ul>
        </div>

        <!-- Col 3: Premium PDF Suite -->
        <div class="footer-col">
          <div class="footer-col-title">PDF Suite</div>
          <ul class="footer-links-list">
            <li><a href="${basePath}tools/searchable-pdf.html" class="footer-link">🔎 Searchable PDF Maker (OCR)</a></li>
            <li><a href="${basePath}tools/pdf-compressor.html" class="footer-link">🗜️ Custom PDF Compressor</a></li>
            <li><a href="${basePath}tools/pdf-editor.html" class="footer-link">✏️ Smart Visual PDF Editor</a></li>
            <li><a href="${basePath}tools/pdf-maker.html" class="footer-link">📑 Drag &amp; Drop PDF Maker</a></li>
          </ul>
        </div>

        <!-- Col 4: Trust, Legal & Knowledge -->
        <div class="footer-col">
          <div class="footer-col-title">Knowledge &amp; Trust</div>
          <ul class="footer-links-list">
            <li><a href="${basePath}guides/index.html" class="footer-link">📚 Knowledge Base &amp; Guides</a></li>
            <li><a href="${basePath}about.html" class="footer-link">ℹ️ About Pragati Telecom</a></li>
            <li><a href="${basePath}contact.html" class="footer-link">📞 Contact Us &amp; Support</a></li>
            <li><a href="${basePath}privacy-policy.html" class="footer-link">🔒 Privacy Policy</a></li>
            <li><a href="${basePath}terms.html" class="footer-link">📜 Terms &amp; Conditions</a></li>
            <li><a href="${basePath}disclaimer.html" class="footer-link">⚠️ Non-Government Disclaimer</a></li>
          </ul>

          <div class="social-icons-row" style="margin-top: 1.2rem;">
            <!-- WhatsApp -->
            <a href="https://wa.me/919775096842?text=Hello%20Pragati%20Telecom" target="_blank" rel="noopener" class="social-icon-btn whatsapp" title="Chat on WhatsApp" aria-label="WhatsApp">
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12.031 0C5.394 0 0 5.394 0 12.031c0 2.122.553 4.184 1.602 6.008L.069 23.931l6.059-1.589a11.97 11.97 0 005.903 1.543h.005c6.632 0 12.026-5.394 12.026-12.031A12.03 12.03 0 0012.031 0zm-.005 21.884h-.004a9.96 9.96 0 01-5.074-1.39l-.364-.216-3.771.989 1.006-3.676-.237-.377a9.982 9.982 0 01-1.536-5.183c0-5.508 4.48-9.988 9.99-9.988 2.668 0 5.176 1.039 7.062 2.926a9.932 9.932 0 012.921 7.063c0 5.508-4.48 9.988-9.988 9.988z"/></svg>
            </a>
            <!-- Phone -->
            <a href="tel:9775096842" class="social-icon-btn phone" title="Call Us Direct" aria-label="Phone">
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.977.977 0 00-1.01.24l-2.2 2.2a15.044 15.044 0 01-6.59-6.59l2.2-2.21a.96.96 0 00.25-1.01A11.36 11.36 0 018.57 3.9c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1 0 9.39 7.61 17 17 17 .55 0 1-.45 1-1v-3.52c0-.55-.45-1-.99-1z"/></svg>
            </a>
            <!-- Maps -->
            <a href="https://maps.google.com/?q=Murshidabad" target="_blank" rel="noopener" class="social-icon-btn maps" title="View Center on Map" aria-label="Map Location">
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 010-5 2.5 2.5 0 010 5z"/></svg>
            </a>
          </div>
        </div>
      </div>

      <!-- Legal Disclaimer Note -->
      <div style="padding: 1.2rem; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: var(--radius-md); font-size: 0.8rem; color: var(--text-light); line-height: 1.5; margin-bottom: 2rem;">
        <strong>⚠️ Non-Government Affiliation Disclaimer:</strong> Pragati Telecom is an independent digital tool and productivity platform designed for local computer operators, cyber cafes, CSC operators, and students. We are <em>not</em> affiliated with, associated with, authorized by, endorsed by, or in any way officially connected with any government department, agency, or authority (including UIDAI, PM-JAY, NSDL, or Election Commission of India).
      </div>

      <!-- Footer Bottom Copyright & Legal Quick Links -->
      <div class="footer-bottom">
        <div>
          &copy; ${currentYear} <strong>Pragati Telecom</strong>. All Rights Reserved. Kalupur Middle Para, Murshidabad.
        </div>
        <div class="footer-legal-links">
          <a href="${basePath}privacy-policy.html">Privacy Policy</a>
          <a href="${basePath}terms.html">Terms &amp; Conditions</a>
          <a href="${basePath}disclaimer.html">Disclaimer</a>
          <a href="${basePath}about.html">About Us</a>
          <a href="${basePath}contact.html">Contact Us</a>
        </div>
      </div>
    </div>
    `;
  }

  // 5. Initialize and inject layout
  function initSharedLayout() {
    ensureStylesheet();

    // Inject Header
    let headerEl = document.getElementById('site-header');
    if (!headerEl) {
      headerEl = document.createElement('header');
      headerEl.id = 'site-header';
      document.body.prepend(headerEl);
    }
    headerEl.innerHTML = getHeaderHTML();

    // Inject Footer
    let footerEl = document.getElementById('site-footer');
    if (!footerEl) {
      footerEl = document.createElement('footer');
      footerEl.id = 'site-footer';
      document.body.appendChild(footerEl);
    }
    footerEl.innerHTML = getFooterHTML();

    setupLayoutEvents();
  }

  // 6. Mobile Drawer & Global Keyboard Events
  function setupLayoutEvents() {
    const toggleBtn = document.getElementById('mobileNavToggle');
    const closeBtn = document.getElementById('mobileDrawerClose');
    const drawer = document.getElementById('mobileDrawer');
    const overlay = document.getElementById('mobileDrawerOverlay');
    const searchNavBtn = document.getElementById('topNavSearchBtn');

    function openDrawer() {
      if (drawer && overlay) {
        drawer.classList.add('open');
        overlay.classList.add('active');
        document.body.style.overflow = 'hidden';
      }
    }

    function closeDrawer() {
      if (drawer && overlay) {
        drawer.classList.remove('open');
        overlay.classList.remove('active');
        document.body.style.overflow = '';
      }
    }

    if (toggleBtn) toggleBtn.addEventListener('click', openDrawer);
    if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
    if (overlay) overlay.addEventListener('click', closeDrawer);

    if (drawer) {
      drawer.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', closeDrawer);
      });
    }

    function focusSearchInput() {
      const searchInput = document.getElementById('toolSearchInput') || document.getElementById('topSearchInput');
      if (searchInput) {
        searchInput.focus();
        searchInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }

    if (searchNavBtn && !isInsideTools) {
      searchNavBtn.addEventListener('click', function(e) {
        const searchInput = document.getElementById('toolSearchInput') || document.getElementById('topSearchInput');
        if (searchInput) {
          e.preventDefault();
          focusSearchInput();
        }
      });
    }

    window.addEventListener('keydown', function (e) {
      if ((e.key === '/' || (e.ctrlKey && e.key === 'k')) && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
        const searchInput = document.getElementById('toolSearchInput') || document.getElementById('topSearchInput');
        if (searchInput) {
          e.preventDefault();
          focusSearchInput();
        }
      }
    });
  }

  // Execute on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSharedLayout);
  } else {
    initSharedLayout();
  }
})();
