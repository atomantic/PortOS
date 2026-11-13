/**
 * Drawing what the storyboard animatic's figure shows onto a canvas, for the
 * overlays that repaint it on a cut (TransitionGlitch, WipeOverlay).
 */

/** Draw a picture element the way its CSS object-fit lays it out in the frame. */
export function drawFitted(ctx, el, width, height) {
  const w = el.videoWidth || el.naturalWidth;
  const h = el.videoHeight || el.naturalHeight;
  if (!w || !h) return;
  const fit = getComputedStyle(el).objectFit;
  const scale = fit === 'cover' ? Math.max(width / w, height / h) : fit === 'contain' ? Math.min(width / w, height / h) : null;
  if (scale == null) { ctx.drawImage(el, 0, 0, width, height); return; }
  const dw = w * scale;
  const dh = h * scale;
  ctx.drawImage(el, (width - dw) / 2, (height - dh) / 2, dw, dh);
}

// #14277: a stacked photo sequence, composed as the renders compose it — each
// visible layer oldest first; a laid-out one (data-layout "x,y,scale,rotation,opacity")
// fitted whole about its centre, otherwise cover-fitted.
export function drawPhotoStack(ctx, stack, width, height) {
  let drawn = false;
  for (const img of stack.querySelectorAll('img')) {
    if (img.style.display === 'none' || !img.complete || !img.naturalWidth) continue;
    const [x, y, scale, rotation, opacity] = (img.dataset.layout || '').split(',').map(Number);
    if (!img.dataset.layout) { drawFitted(ctx, img, width, height); drawn = true; continue; }
    const fit = Math.min(width / img.naturalWidth, height / img.naturalHeight) * scale;
    const dw = img.naturalWidth * fit; const dh = img.naturalHeight * fit;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(width / 2 + x * width, height / 2 + y * height);
    if (rotation) ctx.rotate(rotation * Math.PI / 180);
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
    drawn = true;
  }
  return drawn;
}

/**
 * Whether the figure's clip is between frames: on screen but seeking, so it
 * cannot be copied and drawFigurePicture would fall back to the shot's still.
 * A reversed clip is stepped back by a seek on every frame, and its still is the
 * shot's LAST picture, so that fallback flashes the end of the shot.
 */
export function figureClipSettling(figure) {
  const clip = figure?.querySelector('video[data-ready="true"]:not([aria-hidden="true"])');
  return !!clip && (clip.seeking || clip.readyState < 2);
}

/**
 * Draw the figure's current picture (its photo stack or still, then a ready clip
 * over it) onto `ctx`. False when nothing has decoded yet.
 */
export function drawFigurePicture(ctx, figure, width, height) {
  // The picture as the frame shows it: the still, then the clip over it once it has a frame.
  // The current shot's photo stack renders first; an incoming shot preloaded later is not it.
  // Its own end frame (an end-frame image effect, a sibling of the stack) replaces it once shown.
  const firstStack = figure?.querySelector('[data-photo-stack]');
  const endFrame = firstStack ? [...firstStack.parentElement.children].find(el => el.tagName === 'IMG' && el.dataset.shown === 'true') : null;
  const stack = endFrame ? null : firstStack;
  const still = stack ? null : endFrame || figure?.querySelector('img[data-shown="true"]') || figure?.querySelector('img');
  const clip = figure?.querySelector('video[data-ready="true"]:not([aria-hidden="true"])');
  const stillReady = stack ? drawPhotoStack(ctx, stack, width, height) : !!still?.complete && still.naturalWidth > 0;
  const clipReady = !!clip && clip.readyState >= 2;
  if (!stillReady && !clipReady) return false;
  if (stillReady && still) drawFitted(ctx, still, width, height);
  if (clipReady) drawFitted(ctx, clip, width, height);

  return true;
}
