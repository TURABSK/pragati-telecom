/**
 * Pragati Telecom - Modular Shared Layout System
 * Dynamically injects identical frosted-glass Header & dark glowing Footer across all pages.
 * Handles path resolution, mobile navigation, active states, and contact links.
 */

(function () {
  // 1. Detect relative base path based on current script or page location
  const currentPath = window.location.pathname;
  const isInsideTools = currentPath.includes('/tools/') || currentPath.endsWith('/tools') || window.location.href.includes('/tools/');
  const basePath = isInsideTools ? '../' : './';

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
    const isHome = !isInsideTools && (currentPath.endsWith('index.html') || currentPath.endsWith('/') || currentPath === '');
    const isPhotoStudio = currentPath.includes('photo-studio');
    const isPdfMaker = currentPath.includes('pdf-maker');

    return `
    <div class="nav-container">
      <!-- Brand Logo -->
      <a href="${basePath}index.html" class="brand-logo" title="Pragati Telecom Home">
        <div class="brand-icon-wrap">
          <span>⚡</span>
        </div>
        <div class="brand-text">
          <div class="brand-title">PRAGATI <span class="accent">TELECOM</span></div>
          <div class="brand-tagline">Digital Seva &amp; AI Tools Portal</div>
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
            <span>📸</span> AI Photo Studio
          </a>
        </li>
        <li>
          <a href="${basePath}tools/pdf-maker.html" class="nav-link ${isPdfMaker ? 'active' : ''}">
            <span>📄</span> Searchable PDF
          </a>
        </li>
        <li>
          <a href="${basePath}index.html#tools-directory" class="nav-link">
            <span>🛠️</span> 30+ Tools
          </a>
        </li>
        <li>
          <a href="${basePath}index.html#services-section" class="nav-link">
            <span>🏢</span> Services
          </a>
        </li>
        <li>
          <a href="${basePath}index.html#contact-section" class="nav-link">
            <span>📞</span> Contact
          </a>
        </li>
      </ul>

      <!-- Nav Actions -->
      <div class="nav-actions">
        <a href="${basePath}index.html#search-bar" class="btn-nav-search" title="Quick Search Tools">
          <span>🔍</span> Search <span class="kbd-shortcut">/</span>
        </a>
        <a href="https://wa.me/919775096842?text=Hello%20Pragati%20Telecom,%20I%20need%20assistance" target="_blank" rel="noopener" class="btn-nav-whatsapp">
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
        <li><a href="${basePath}tools/pdf-maker.html" class="nav-link ${isPdfMaker ? 'active' : ''}"><span>📄</span> Searchable PDF Maker</a></li>
        <li><a href="${basePath}index.html#tools-directory" class="nav-link"><span>🛠️</span> Browse 30+ Tools</a></li>
        <li><a href="${basePath}index.html#services-section" class="nav-link"><span>🏢</span> Center Services</a></li>
        <li><a href="${basePath}index.html#contact-section" class="nav-link"><span>📞</span> Contact Details</a></li>
      </ul>
      <div style="margin-top: auto; padding-top: 1.5rem; display: flex; flex-direction: column; gap: 0.75rem;">
        <a href="tel:9775096842" class="btn-nav-whatsapp" style="background: linear-gradient(135deg, #2563eb, #1d4ed8); justify-content: center;">
          <span>📞</span> Call: 9775096842
        </a>
        <a href="https://wa.me/919775096842" target="_blank" class="btn-nav-whatsapp" style="justify-content: center;">
          <span>💬</span> Chat on WhatsApp
        </a>
      </div>
    </div>
    `;
  }

  // 4. Footer HTML Template (with dark animated glow background & interactive SVG icons)
  function getFooterHTML() {
    const currentYear = new Date().getFullYear();

    return `
    <!-- Animated Glow Background Effect -->
    <div class="footer-glow-bg"></div>

    <div class="footer-container">
      <div class="footer-grid">
        <!-- Col 1: Brand Info & Business Details -->
        <div class="footer-col">
          <div class="footer-brand-title">
            <span style="color: var(--brand-primary-light);">⚡</span> PRAGATI TELECOM
          </div>
          <p class="footer-bio">
            Your trusted Digital Seva, Cyber &amp; AI Studio in Murshidabad. Providing instant passport photo generation, high-precision searchable PDF creation, online government form fill-up, banking, and 30+ smart utility tools.
          </p>

          <div class="business-info-card">
            <div class="business-info-row">
              <span class="business-info-icon">📍</span>
              <div>
                <strong>Location:</strong> Kalupur Middle Para, Murshidabad, West Bengal
              </div>
            </div>
            <div class="business-info-row">
              <span class="business-info-icon">📞</span>
              <div>
                <strong>Phone / Care:</strong> <a href="tel:9775096842" style="color: #60a5fa; font-weight:700;">+91 9775096842</a>
              </div>
            </div>
            <div class="business-info-row">
              <span class="business-info-icon">⏰</span>
              <div>
                <strong>Working Hours:</strong> Mon - Sun: 8:00 AM – 9:30 PM
              </div>
            </div>
          </div>
        </div>

        <!-- Col 2: Top AI & Studio Tools -->
        <div class="footer-col">
          <div class="footer-col-title">Popular Tools</div>
          <ul class="footer-links-list">
            <li><a href="${basePath}tools/photo-studio.html" class="footer-link">📸 AI Photo Studio Pro</a></li>
            <li><a href="${basePath}tools/pdf-maker.html" class="footer-link">📄 Searchable PDF Maker</a></li>
            <li><a href="${basePath}index.html#tools-directory" class="footer-link">🪪 Passport 4x6 / A4 Grid</a></li>
            <li><a href="${basePath}index.html#tools-directory" class="footer-link">✂️ Instant BG Remover</a></li>
            <li><a href="${basePath}index.html#tools-directory" class="footer-link">📉 Image &amp; Signature Resizer</a></li>
            <li><a href="${basePath}index.html#tools-directory" class="footer-link">📑 Voter EPIC PDF Splitter</a></li>
            <li><a href="${basePath}index.html#tools-directory" class="footer-link">🔒 Aadhaar Masking Helper</a></li>
          </ul>
        </div>

        <!-- Col 3: CSC & Online Services -->
        <div class="footer-col">
          <div class="footer-col-title">Center Services</div>
          <ul class="footer-links-list">
            <li><a href="${basePath}index.html#services-section" class="footer-link">🖨️ High-Quality Xerox &amp; Color Print</a></li>
            <li><a href="${basePath}index.html#services-section" class="footer-link">💳 PVC Smart ID Card Printing</a></li>
            <li><a href="${basePath}index.html#services-section" class="footer-link">📝 Govt Job &amp; Scheme Form Fill-up</a></li>
            <li><a href="${basePath}index.html#services-section" class="footer-link">🏧 AEPS Money Transfer &amp; Micro ATM</a></li>
            <li><a href="${basePath}index.html#services-section" class="footer-link">📜 Lamination &amp; Spiral Binding</a></li>
            <li><a href="${basePath}index.html#services-section" class="footer-link">⚡ Electricity Bill Payment &amp; Recharge</a></li>
          </ul>
        </div>

        <!-- Col 4: Connect, Social Media SVGs & Quick Support -->
        <div class="footer-col">
          <div class="footer-col-title">Connect With Us</div>
          <div class="footer-social-title">Social Media &amp; Fast Support</div>

          <div class="social-icons-row">
            <!-- WhatsApp SVG Icon with Scale & Glow Hover -->
            <a href="https://wa.me/919775096842?text=Hello%20Pragati%20Telecom" target="_blank" rel="noopener" class="social-icon-btn whatsapp" title="Chat on WhatsApp (+91 9775096842)" aria-label="WhatsApp">
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M12.031 0C5.394 0 0 5.394 0 12.031c0 2.122.553 4.184 1.602 6.008L.069 23.931l6.059-1.589a11.97 11.97 0 005.903 1.543h.005c6.632 0 12.026-5.394 12.026-12.031A12.03 12.03 0 0012.031 0zm-.005 21.884h-.004a9.96 9.96 0 01-5.074-1.39l-.364-.216-3.771.989 1.006-3.676-.237-.377a9.982 9.982 0 01-1.536-5.183c0-5.508 4.48-9.988 9.99-9.988 2.668 0 5.176 1.039 7.062 2.926a9.932 9.932 0 012.921 7.063c0 5.508-4.48 9.988-9.988 9.988zm5.474-7.483c-.3-.15-1.776-.876-2.051-.976-.275-.1-.475-.15-.675.15-.2.3-.775.976-.95 1.176-.175.2-.35.225-.65.075-.3-.15-1.267-.467-2.413-1.488-.892-.796-1.494-1.78-1.669-2.08-.175-.3-.019-.462.131-.611.135-.134.3-.35.45-.525.15-.175.2-.3.3-.5.1-.2.05-.375-.025-.525-.075-.15-.675-1.626-.925-2.226-.244-.584-.492-.505-.675-.514-.175-.009-.375-.01-.575-.01s-.525.075-.8.375c-.275.3-1.05 1.026-1.05 2.502 0 1.476 1.075 2.899 1.225 3.1.15.2 2.115 3.23 5.124 4.53.716.31 1.275.495 1.71.634.719.229 1.373.197 1.89.12.576-.086 1.776-.726 2.026-1.426.25-.7.25-1.3.175-1.426-.075-.125-.275-.2-.575-.35z"/>
              </svg>
            </a>

            <!-- YouTube SVG Icon with Scale & Glow Hover -->
            <a href="https://www.youtube.com" target="_blank" rel="noopener" class="social-icon-btn youtube" title="Follow Pragati Telecom on YouTube" aria-label="YouTube">
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
              </svg>
            </a>

            <!-- Phone Call Icon -->
            <a href="tel:9775096842" class="social-icon-btn phone" title="Call Us Direct: 9775096842" aria-label="Phone">
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.977.977 0 00-1.01.24l-2.2 2.2a15.044 15.044 0 01-6.59-6.59l2.2-2.21a.96.96 0 00.25-1.01A11.36 11.36 0 018.57 3.9c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1 0 9.39 7.61 17 17 17 .55 0 1-.45 1-1v-3.52c0-.55-.45-1-.99-1z"/>
              </svg>
            </a>

            <!-- Maps Location Icon -->
            <a href="https://maps.google.com/?q=Murshidabad" target="_blank" rel="noopener" class="social-icon-btn maps" title="View Center on Google Maps" aria-label="Map Location">
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 010-5 2.5 2.5 0 010 5z"/>
              </svg>
            </a>
          </div>

          <div class="footer-cta-box">
            <div>💡 <strong>Need urgent printing or form fillup?</strong></div>
            <div>Call us directly at <a href="tel:9775096842">9775096842</a> or visit our Kalupur Middle Para center.</div>
          </div>
        </div>
      </div>

      <!-- Footer Bottom Copyright & Legal -->
      <div class="footer-bottom">
        <div>
          &copy; ${currentYear} <strong>Pragati Telecom</strong>. All Rights Reserved. Kalupur Middle Para, Murshidabad.
        </div>
        <div class="footer-legal-links">
          <a href="${basePath}index.html#tools-directory">Tool Directory</a>
          <a href="${basePath}index.html#services-section">Services</a>
          <a href="${basePath}index.html#contact-section">Visit Center</a>
          <a href="tel:9775096842">Emergency Helpline</a>
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

    // Setup Interactive Event Handlers
    setupLayoutEvents();
  }

  // 6. Mobile Drawer & Global Keyboard Events
  function setupLayoutEvents() {
    const toggleBtn = document.getElementById('mobileNavToggle');
    const closeBtn = document.getElementById('mobileDrawerClose');
    const drawer = document.getElementById('mobileDrawer');
    const overlay = document.getElementById('mobileDrawerOverlay');

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

    // Close drawer when clicking any link inside it
    if (drawer) {
      drawer.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', closeDrawer);
      });
    }

    // Global keyboard shortcut '/' or 'Ctrl+K' to focus search if available
    window.addEventListener('keydown', function (e) {
      if ((e.key === '/' || (e.ctrlKey && e.key === 'k')) && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
        const searchInput = document.getElementById('toolSearchInput');
        if (searchInput) {
          e.preventDefault();
          searchInput.focus();
          searchInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
