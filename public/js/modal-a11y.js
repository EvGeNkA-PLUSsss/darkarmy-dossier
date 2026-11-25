/* =========================================================
   modal-a11y.js — единое поведение модалок:
   role=dialog, aria-modal, focus trap, возврат фокуса,
   закрытие по клику на фон, Escape (дополняет обработчики страниц).
   Работает и для статических .modal в HTML, и для динамически созданных.
   ========================================================= */
(function () {
  'use strict';
  var seq = 0;
  var lastFocused = null;
  var activeModal = null;
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function isOpen(el) {
    if (!el || !el.classList || !el.classList.contains('modal')) return false;
    if (el.hidden) return false;
    var d = el.style.display;
    return d !== 'none';
  }

  function focusables(el) {
    return Array.prototype.slice.call(el.querySelectorAll(FOCUSABLE)).filter(function (f) {
      return f.offsetParent !== null && getComputedStyle(f).visibility !== 'hidden';
    });
  }

  function setup(el) {
    if (!el || el.nodeType !== 1) return;
    if (el.classList && el.classList.contains('modal')) {
      if (!el.getAttribute('role')) el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      var head = el.querySelector('.modal-head');
      if (head && !el.getAttribute('aria-labelledby')) {
        if (!head.id) head.id = 'modal-title-' + (++seq);
        el.setAttribute('aria-labelledby', head.id);
      }
      observe(el);
    }
    // вложенные и новые модалки внутри добавленного узла
    el.querySelectorAll && el.querySelectorAll('.modal').forEach(setup);
  }

  function open(el) {
    if (activeModal === el) return;
    lastFocused = document.activeElement;
    activeModal = el;
    setTimeout(function () {
      var f = focusables(el);
      if (f.length) f[0].focus();
      else el.focus();
    }, 30);
  }

  function close() {
    if (!activeModal) return;
    var prev = lastFocused;
    activeModal = null;
    lastFocused = null;
    if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
      try { prev.focus(); } catch (e) {}
    }
  }

  function sync(el) {
    if (isOpen(el)) open(el);
    else if (activeModal === el) close();
  }

  function observe(el) {
    if (el._daModalObserved) return;
    el._daModalObserved = true;
    var mo = new MutationObserver(function () { sync(el); });
    mo.observe(el, { attributes: true, attributeFilter: ['style', 'hidden', 'class'] });
    sync(el);
  }

  document.addEventListener('mousedown', function (e) {
    if (e.target && e.target.classList && e.target.classList.contains('modal') && isOpen(e.target)) {
      e.target.style.display = 'none';
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Tab' && activeModal) {
      var f = focusables(activeModal);
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    if (e.key === 'Escape' && activeModal) {
      activeModal.style.display = 'none';
    }
  });

  function scan() {
    document.querySelectorAll('.modal').forEach(setup);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scan);
  } else {
    scan();
  }
  var bodyObserver = new MutationObserver(function (records) {
    records.forEach(function (r) {
      Array.prototype.forEach.call(r.addedNodes, function (n) {
        if (n.nodeType === 1) setup(n);
      });
    });
  });
  document.addEventListener('DOMContentLoaded', function () {
    if (document.body) bodyObserver.observe(document.body, { childList: true, subtree: true });
  });
})();
