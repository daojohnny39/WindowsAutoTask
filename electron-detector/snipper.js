(function () {
  'use strict';

  const canvas = document.getElementById('bg');
  const hud = document.getElementById('hud');
  const ctx = canvas.getContext('2d');

  let state = null; // { captureId, displayBounds, virtualBounds, scaleFactor, img }
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let curX = 0;
  let curY = 0;

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = w;
    canvas.height = h;
    if (state && state.img) {
      redraw();
    }
  }

  function drawFrame() {
    if (!state || !state.img) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(state.img, 0, 0, canvas.width, canvas.height);
  }

  function redraw() {
    if (!state || !state.img) return;

    drawFrame();

    if (dragging) {
      const rx = Math.min(startX, curX);
      const ry = Math.min(startY, curY);
      const rw = Math.abs(curX - startX);
      const rh = Math.abs(curY - startY);

      // Dim overlay over whole canvas
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Clear selection rectangle to show preview through it
      ctx.clearRect(rx, ry, rw, rh);

      // Redraw preview image clipped to the selection rect only
      ctx.save();
      ctx.beginPath();
      ctx.rect(rx, ry, rw, rh);
      ctx.clip();
      ctx.drawImage(state.img, 0, 0, canvas.width, canvas.height);
      ctx.restore();

      // Stroke selection border
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);

      // Update HUD
      const hudText = rw + '×' + rh;
      hud.textContent = hudText;
      hud.style.display = 'block';

      let hx = curX + 12;
      let hy = curY + 12;
      const hudW = hud.offsetWidth;
      const hudH = hud.offsetHeight;
      if (hx + hudW > canvas.width) hx = curX - hudW - 8;
      if (hy + hudH > canvas.height) hy = curY - hudH - 8;
      if (hx < 0) hx = 4;
      if (hy < 0) hy = 4;
      hud.style.left = hx + 'px';
      hud.style.top = hy + 'px';
    } else {
      // Not dragging — show dim overlay
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      hud.style.display = 'none';
    }
  }

  function cancel() {
    if (!state) return;
    dragging = false;
    hud.style.display = 'none';
    window.snipper.submitRegion({ captureId: state.captureId, canceled: true });
  }

  window.snipper.onInit(function (data) {
    state = {
      captureId: data.captureId,
      displayBounds: data.displayBounds,
      virtualBounds: data.virtualBounds,
      scaleFactor: data.scaleFactor,
      img: null,
    };

    const img = new Image();
    img.onload = function () {
      state.img = img;
      resize();
      redraw();
    };
    img.src = data.previewDataUrl;
  });

  window.addEventListener('resize', resize);

  canvas.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    if (!state || !state.img) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    curX = e.clientX;
    curY = e.clientY;
    redraw();
  });

  canvas.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    curX = e.clientX;
    curY = e.clientY;
    redraw();
  });

  canvas.addEventListener('mouseup', function (e) {
    if (e.button !== 0) return;
    if (!dragging) return;
    dragging = false;
    hud.style.display = 'none';

    if (!state) return;

    // Normalize rect
    let x1 = Math.min(startX, e.clientX);
    let y1 = Math.min(startY, e.clientY);
    let x2 = Math.max(startX, e.clientX);
    let y2 = Math.max(startY, e.clientY);
    const rw = x2 - x1;
    const rh = y2 - y1;

    // Minimum size check
    if (rw < 3 || rh < 3) {
      window.snipper.submitRegion({ captureId: state.captureId, canceled: true });
      return;
    }

    // Convert display-local DIP to global DIP
    const gx = x1 + state.displayBounds.x;
    const gy = y1 + state.displayBounds.y;

    window.snipper.submitRegion({
      captureId: state.captureId,
      canceled: false,
      rectDip: { x: gx, y: gy, width: rw, height: rh },
    });
  });

  canvas.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    cancel();
  });

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      cancel();
    }
  });

  // Initial size
  resize();
})();
