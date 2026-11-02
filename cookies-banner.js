(() => {
  if (window.location.pathname.includes('politica-cookies')) return;

  const consentCookieName = 'labad_cookies_consent';
  const analyticsMeasurementId = 'G-MFEF1S653S';

  function getConsent() {
    const cookie = document.cookie
      .split(';')
      .map(value => value.trim())
      .find(value => value.startsWith(`${consentCookieName}=`));

    return cookie ? cookie.slice(consentCookieName.length + 1) : null;
  }

  function loadAnalytics() {
    if (window.gtag) return;

    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag() {
      window.dataLayer.push(arguments);
    };
    window.gtag('js', new Date());
    window.gtag('config', analyticsMeasurementId);

    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${analyticsMeasurementId}`;
    document.head.appendChild(script);
  }

  const existingConsent = getConsent();
  if (existingConsent === 'accepted') {
    loadAnalytics();
    return;
  }
  if (existingConsent === 'rejected') return;

  const container = document.getElementById('cookies-banner-container');
  if (!container) {
    console.error('No se encontró #cookies-banner-container para mostrar el aviso de cookies.');
    return;
  }

  const style = document.createElement('style');
  style.textContent = `
    #cookies-banner-container .cookies-banner {
      position: fixed;
      right: 0;
      bottom: 0;
      left: 0;
      z-index: 9999;
      width: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 24px;
      padding: 22px max(24px, calc((100vw - 1180px) / 2));
      background: #1B4332;
      color: #fff;
      font: 14px/1.6 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      box-shadow: 0 -8px 30px rgba(0, 0, 0, .18);
      opacity: 0;
      transform: translateY(100%);
      transition: opacity .3s ease, transform .3s ease;
    }
    #cookies-banner-container .cookies-banner.is-visible {
      opacity: 1;
      transform: translateY(0);
    }
    #cookies-banner-container .cookies-banner-copy {
      max-width: 760px;
    }
    #cookies-banner-container .cookies-banner-title {
      margin: 0 0 4px;
      color: #fff;
      font-size: 16px;
      font-weight: 700;
    }
    #cookies-banner-container .cookies-banner-copy p {
      margin: 0;
      color: #fff;
    }
    #cookies-banner-container .cookies-banner-copy a {
      color: #D8E9A8;
      font-weight: 600;
      text-decoration: underline;
      text-underline-offset: 3px;
    }
    #cookies-banner-container .cookies-banner-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    #cookies-banner-container .cookies-banner button {
      min-height: 44px;
      padding: 10px 18px;
      border: 1px solid #fff;
      border-radius: 5px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    #cookies-banner-container .cookies-accept {
      background: #fff;
      color: #1B4332;
    }
    #cookies-banner-container .cookies-reject {
      background: transparent;
      color: #fff;
    }
    #cookies-banner-container .cookies-banner button:focus-visible,
    #cookies-banner-container .cookies-banner a:focus-visible {
      outline: 2px solid #D8E9A8;
      outline-offset: 3px;
    }
    @media (max-width: 700px) {
      #cookies-banner-container .cookies-banner {
        grid-template-columns: 1fr;
        gap: 16px;
        padding: 20px;
      }
      #cookies-banner-container .cookies-banner-actions {
        flex-direction: column;
      }
      #cookies-banner-container .cookies-banner button {
        width: 100%;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      #cookies-banner-container .cookies-banner {
        transition: none;
      }
    }
  `;
  document.head.appendChild(style);

  const banner = document.createElement('section');
  banner.className = 'cookies-banner';
  banner.setAttribute('role', 'dialog');
  banner.setAttribute('aria-label', 'Preferencias de cookies');
  banner.innerHTML = `
    <div class="cookies-banner-copy">
      <p class="cookies-banner-title">🍪 Usamos cookies</p>
      <p>Utilizamos cookies propias y de terceros para analizar el uso del sitio web y mejorar tu experiencia. Puedes aceptar todas las cookies o configurar tus preferencias. <a href="${new URL('politica-cookies.html', document.currentScript.src).href}">Más información</a></p>
    </div>
    <div class="cookies-banner-actions">
      <button class="cookies-accept" type="button">Aceptar todas</button>
      <button class="cookies-reject" type="button">Solo necesarias</button>
    </div>
  `;
  container.appendChild(banner);

  function saveConsent(value) {
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${consentCookieName}=${value}; Max-Age=31536000; Path=/; SameSite=Lax${secure}`;
    if (value === 'accepted') loadAnalytics();
    banner.classList.remove('is-visible');
    window.setTimeout(() => banner.remove(), 300);
  }

  banner.querySelector('.cookies-accept').addEventListener('click', () => saveConsent('accepted'));
  banner.querySelector('.cookies-reject').addEventListener('click', () => saveConsent('rejected'));
  window.requestAnimationFrame(() => banner.classList.add('is-visible'));
})();
