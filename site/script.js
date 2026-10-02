(() => {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Nav border once scrolled
  const nav = document.querySelector('.nav');
  const onScrollNav = () => nav.classList.toggle('scrolled', window.scrollY > 8);
  onScrollNav();
  window.addEventListener('scroll', onScrollNav, { passive: true });

  // Scroll reveal, staggered within each parent
  const items = document.querySelectorAll('.reveal');
  if (reduce || !('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('in'));
  } else {
    const seen = new Map();
    items.forEach((el) => {
      const i = seen.get(el.parentElement) || 0;
      seen.set(el.parentElement, i + 1);
      el.style.setProperty('--d', Math.min(i, 8) * 60 + 'ms');
    });
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    items.forEach((el) => io.observe(el));
  }

  // Hero frame: flattens out as you scroll
  const frame = document.querySelector('.frame');
  const stage = document.getElementById('stage');
  if (frame && stage && !reduce) {
    let ticking = false;
    const update = () => {
      ticking = false;
      const r = stage.getBoundingClientRect();
      const vh = window.innerHeight;
      const p = Math.min(1, Math.max(0, (vh - r.top) / (vh * 0.9)));
      const max = window.innerWidth < 640 ? 14 : 22;
      frame.style.setProperty('--tilt', (max * (1 - p)).toFixed(2) + 'deg');
    };
    update();
    window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    window.addEventListener('resize', update, { passive: true });
  }

  // Launch video: only used once assets/launch.mp4 exists
  const video = document.getElementById('launch');
  const fallback = document.getElementById('launch-fallback');
  if (video && fallback && video.dataset.src) {
    fetch(video.dataset.src, { method: 'HEAD' }).then((res) => {
      const type = res.headers.get('content-type') || '';
      if (!res.ok || type.startsWith('text/')) return;
      video.poster = video.dataset.poster;
      video.src = video.dataset.src;
      if (reduce) { video.controls = true; } else { video.autoplay = true; }
      video.addEventListener('loadeddata', () => {
        video.hidden = false;
        fallback.hidden = true;
        if (!reduce) video.play().catch(() => {});
      }, { once: true });
      video.load();
    }).catch(() => {});
  }

  // GitHub stars with cache + graceful fallback
  const starEls = document.querySelectorAll('[data-stars]');
  const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(n));
  const show = (n) => {
    if (typeof n !== 'number' || n < 1) return;
    starEls.forEach((el) => { el.textContent = fmt(n); el.hidden = false; el.setAttribute('aria-label', n + ' stars'); });
  };
  const KEY = 'ridealong-stars';
  let cached = null;
  try { cached = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (_) {}
  if (cached && Date.now() - cached.t < 10 * 60 * 1000) {
    show(cached.n);
  } else {
    fetch('https://api.github.com/repos/killerz3/ridealong', { headers: { Accept: 'application/vnd.github+json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d || typeof d.stargazers_count !== 'number') return;
        show(d.stargazers_count);
        try { sessionStorage.setItem(KEY, JSON.stringify({ n: d.stargazers_count, t: Date.now() })); } catch (_) {}
      })
      .catch(() => {});
  }

  // Code tabs
  document.querySelectorAll('[data-tabs]').forEach((root) => {
    const tabs = [...root.querySelectorAll('[role="tab"]')];
    const select = (tab, focus) => {
      tabs.forEach((t) => {
        const on = t === tab;
        t.setAttribute('aria-selected', on);
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
      });
      if (focus) tab.focus();
    };
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => select(t));
      t.addEventListener('keydown', (e) => {
        let j = null;
        if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
        if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
        if (e.key === 'Home') j = 0;
        if (e.key === 'End') j = tabs.length - 1;
        if (j !== null) { e.preventDefault(); select(tabs[j], true); }
      });
    });
  });

  // Copy buttons
  const copyText = async (text) => {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } finally { ta.remove(); }
  };
  document.querySelectorAll('.copy').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const code = btn.parentElement.querySelector('pre code');
      try {
        await copyText(code.textContent);
        btn.textContent = 'Copied';
        btn.classList.add('done');
      } catch (_) {
        btn.textContent = 'Press Ctrl+C';
      }
      clearTimeout(btn._t);
      btn._t = setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1600);
    });
  });
})();
