// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// mast-web // spatial shell — a 3D workspace of live mast terminals,
// built from CSS perspective transforms rather than WebGL.
//
// Why not Three.js / react-three-fiber: the panels here are the real
// product surface (transcript markdown, tool-call disclosure, a working
// prompt line, [COPY] / [RETRY] buttons). Getting live DOM onto a WebGL
// quad means rendering it to a texture, and no browser API does that
// for arbitrary DOM — html2canvas re-implements layout and drops most
// of it, SVG foreignObject snapshots aren't live. The usual escape
// hatch is Xterm.js, which owns its own <canvas>; mast-web's transcript
// is not a character grid, so that door is closed. CSS 3D keeps every
// panel as ordinary DOM — selectable, focusable, typable,
// screen-reader-visible — at any camera angle, with no bundler in a
// repo that has deliberately never had one.
//
// The trade is real: no volumetric bloom, no depth-of-field, no
// shadows. Those are faked with layered box-shadows and a vignette,
// which reads convincingly at these panel counts.
//
// Each panel hosts a MastTerminal instance (terminal.js) with its own
// AttachClient, so N sessions stream side by side. The sidebar lists
// every session on every attached daemon; clicking one opens or
// re-centers its terminal.

(function () {
  'use strict';

  const world = document.getElementById('scene-world');
  const viewport = document.getElementById('scene-viewport');
  const floor = document.getElementById('grid-floor');
  const hudPanels = document.getElementById('hud-panels');
  const hudCamera = document.getElementById('hud-camera');
  const statusFocus = document.getElementById('status-focus');
  const statusClock = document.getElementById('status-clock');
  const daemonList = document.getElementById('daemon-list');
  const sidebar = document.getElementById('spatial-sidebar');
  // Up here with the rest of the lookups rather than down in the radar
  // section: applyCamera() writes the heading, and it runs during init
  // before that section's declarations would have been evaluated.
  const radar = document.getElementById('hud-radar');
  const radarBlips = radar.querySelector('.radar-blips');

  // ─── Camera ───────────────────────────────────────────────────────
  // Orbit is applied to the world, not to a camera object: rotateY is
  // the turntable, rotateX the tilt, translateZ the dolly. Pitch is
  // clamped hard because past ~30° the floor plane edge-ons and the
  // illusion collapses.

  const HOME = { yaw: 0, pitch: 4, dolly: 0 };
  const cam = Object.assign({}, HOME);

  // Must match #scene-viewport's `perspective`. The eye sits this far
  // in front of the world origin, which is what makes a panel's facing
  // angle computable rather than guessable. EYE_Y tracks
  // perspective-origin's 44% — the vanishing point is above centre, so
  // the eye is too.
  const PERSPECTIVE = 1250;
  const EYE_Y = -50;

  // Angle a panel at (x, y, z) has to hold to look straight at the eye.
  // Deriving this instead of authoring it per slot is what turns a
  // scatter of tilted windows into a cockpit: every panel sits on a
  // cylinder around the viewer, so none of them is ever edge-on. Pitch
  // is damped — full vertical facing over-rotates the near slots into
  // something that reads as a dropped card.
  function facingFor(pos) {
    const depth = Math.max(PERSPECTIVE - pos.z, 240);
    const deg = 180 / Math.PI;
    return {
      ry: -Math.atan2(pos.x, depth) * deg,
      rx: Math.atan2(pos.y - EYE_Y, depth) * deg * 0.7,
    };
  }

  // Panel placements are authored against a 1440×860 stage. Rather
  // than reflow them per breakpoint, the whole world scales to fit —
  // the layout is a composition, and a composition should shrink, not
  // rearrange.
  function fitScale() {
    const s = Math.min(window.innerWidth / 1440, window.innerHeight / 860);
    return clamp(s, 0.5, 1.25);
  }

  // ─── Parallax ─────────────────────────────────────────────────────
  // A few degrees of camera lean tracking the pointer. It is the
  // cheapest thing in this file and the one that does the most work: a
  // 3D scene that never answers the mouse reads as a picture of a room,
  // and one that leans a little reads as a room. Kept small and heavily
  // damped — this is peripheral, not a control.

  const PARALLAX_YAW = 3.2;
  const PARALLAX_PITCH = 1.8;
  const parallax = { yaw: 0, pitch: 0 };
  const parallaxAim = { yaw: 0, pitch: 0 };
  const stillness = window.matchMedia('(prefers-reduced-motion: reduce)');
  let parallaxFrame = 0;

  function aimParallax(e) {
    // Dragging a panel or spinning the turntable is a deliberate camera
    // act; parallax must not fight it.
    if (drag || orbit || stillness.matches) return;
    const nx = (e.clientX / window.innerWidth) * 2 - 1;
    const ny = (e.clientY / window.innerHeight) * 2 - 1;
    // Halved while reading a centered transcript — the lean is there
    // for the room, and the room is not what you're looking at.
    const damp = active ? 0.45 : 1;
    parallaxAim.yaw = nx * PARALLAX_YAW * damp;
    parallaxAim.pitch = -ny * PARALLAX_PITCH * damp;
    if (!parallaxFrame) parallaxFrame = window.requestAnimationFrame(stepParallax);
  }

  function stepParallax() {
    parallaxFrame = 0;
    const dy = parallaxAim.yaw - parallax.yaw;
    const dp = parallaxAim.pitch - parallax.pitch;
    if (Math.abs(dy) < 0.008 && Math.abs(dp) < 0.008) {
      parallax.yaw = parallaxAim.yaw;
      parallax.pitch = parallaxAim.pitch;
      applyCamera();
      return;
    }
    // Exponential ease. Low coefficient = the room has mass.
    parallax.yaw += dy * 0.075;
    parallax.pitch += dp * 0.075;
    applyCamera();
    parallaxFrame = window.requestAnimationFrame(stepParallax);
  }

  function applyCamera() {
    const yaw = cam.yaw + parallax.yaw;
    const pitch = clamp(cam.pitch + parallax.pitch, -22, 34);
    world.style.setProperty('--cam-yaw', yaw.toFixed(2) + 'deg');
    world.style.setProperty('--cam-pitch', pitch.toFixed(2) + 'deg');
    world.style.setProperty('--cam-dolly', cam.dolly.toFixed(0) + 'px');
    world.style.setProperty('--cam-scale', fitScale().toFixed(3));
    // The HUD reports where *you* put the camera, not where the lean
    // happens to be this frame — otherwise the readout never settles.
    // Same argument for the radar wedge: it is a heading, and a heading
    // that wobbles a couple of degrees with the mouse is not one.
    hudCamera.textContent = 'yaw ' + Math.round(cam.yaw) + '° pitch ' + Math.round(cam.pitch) + '°';
    radar.style.setProperty('--radar-yaw', cam.yaw.toFixed(2) + 'deg');
  }

  // Camera limits live here so nudging, orbiting and restoring a saved
  // view all agree on what a legal camera is.
  const YAW_LIMIT = 55;
  const PITCH_MIN = -18;
  const PITCH_MAX = 30;
  const DOLLY_MIN = -700;
  const DOLLY_MAX = 520;

  function nudgeCamera(dYaw, dPitch, dDolly) {
    cam.yaw = clamp(cam.yaw + dYaw, -YAW_LIMIT, YAW_LIMIT);
    cam.pitch = clamp(cam.pitch + dPitch, PITCH_MIN, PITCH_MAX);
    cam.dolly = clamp(cam.dolly + dDolly, DOLLY_MIN, DOLLY_MAX);
    applyCamera();
    saveWorkspace();
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  // spatial-audio.js is loaded by spatial.html and by nothing else, and
  // it is allowed to be absent — a browser without Web Audio, or a page
  // served without the tag, gets a silent room rather than an error.
  // The module itself is muted until the operator asks for it.
  function sound(name) {
    if (window.MastRoomAudio) window.MastRoomAudio.play(name);
  }

  // ─── Panels ───────────────────────────────────────────────────────

  const panels = new Map();
  let active = null;

  // Parking slots for newly-opened terminals: the four corners first,
  // then the two depth slots down the middle. Corners lead so that the
  // common case — a handful of sessions — leaves the stage centre
  // clear for whichever terminal is active, and nothing sits directly
  // behind anything else. Past the last slot, placement wraps back and
  // to the side. Each x is chosen so the panel's magnified footprint
  // clears the sidebar on the left and the window edge on the right:
  // on-screen half-width is fitScale × 1250/(1250 − z) × PANEL_W/2, so
  // the further forward a slot sits, the closer in its x has to be.
  //
  // Only position is authored; facing comes from facingFor().
  const SLOTS = [
    { x: -450, y: -190, z: -260 },
    { x: 450, y: -190, z: -260 },
    { x: -360, y: 190, z: 30 },
    { x: 330, y: 190, z: 30 },
    { x: -10, y: -230, z: -520 },
    { x: 0, y: 235, z: -430 },
  ];

  // Panel colours come from dedicated slots rather than the status
  // palette. --green/--yellow/--red have ~25 semantic consumers in
  // styles.css (success text, error text, connection dots), so borrowing
  // them meant a theme could not recolour terminals without recolouring
  // every "connected" dot in the sidebar too.
  const HUES = ['--hue-1', '--hue-2', '--hue-3', '--hue-4'];

  const PANEL_W = 440;
  const PANEL_H = 320;

  let spawnCount = 0;

  function slotFor(index) {
    const base = SLOTS[index % SLOTS.length];
    const wrap = Math.floor(index / SLOTS.length);
    // Slots are authored against the *visible* stage, so the whole
    // arrangement slides right by half the sidebar when it's open.
    const inset = stageInset() / 2 / fitScale();
    // Later wraps step back and to the side rather than overlapping.
    const pos = {
      x: base.x + inset + wrap * 46,
      y: base.y + wrap * 34,
      z: base.z - wrap * 180,
    };
    return Object.assign(pos, facingFor(pos));
  }

  // Aerial perspective. Everything else in this room says "further
  // away" with size, and size alone is a weak cue when the panels are
  // all the same size to begin with: the near slots read as big rather
  // than as close. Hazing a panel toward the room's own colour as it
  // recedes is the cue that actually lands, and it costs one number.
  //
  // FOG_NEAR is the nearest authored slot; FOG_FAR is past the second
  // wrap, so even a heavily-populated room still has depth left to
  // spend rather than saturating at the back. The CSS half of this sum
  // is --fog-boost, which covers the 240px recede.
  const FOG_NEAR = 40;
  const FOG_FAR = -1200;

  function fogFor(z) {
    return clamp((FOG_NEAR - z) / (FOG_NEAR - FOG_FAR), 0, 1);
  }

  function place(p) {
    const el = p.el;
    el.style.setProperty('--tx', Math.round(p.pos.x) + 'px');
    el.style.setProperty('--ty', Math.round(p.pos.y) + 'px');
    el.style.setProperty('--tz', Math.round(p.pos.z) + 'px');
    el.style.setProperty('--ry', p.pos.ry.toFixed(1) + 'deg');
    el.style.setProperty('--rx', p.pos.rx.toFixed(1) + 'deg');
    el.style.setProperty('--fog', fogFor(p.pos.z).toFixed(3));
    placeCast(p);
    placeBlip(p);
  }

  // ─── Floor casts ──────────────────────────────────────────────────
  // Each panel spills a pool of its own neon onto the grid below it.
  // There is no lighting model here — it's a radial gradient lying flat
  // on the floor plane at the panel's x/z — but faked bounce is what
  // makes the panels read as objects standing in a room rather than
  // images pasted on a backdrop. The pool also brightens while that
  // session is streaming, so fleet activity is legible from the floor
  // alone, peripherally, without reading a single transcript.
  //
  // Casts live in their own layer rather than inside .panel-anchor:
  // nested, they would inherit the panel's facing rotation and lift off
  // the floor.

  const castLayer = document.createElement('div');
  castLayer.id = 'panel-casts';
  castLayer.setAttribute('aria-hidden', 'true');
  world.appendChild(castLayer);

  // Keep in step with #grid-floor's translateY in spatial.css.
  const FLOOR_Y = 420;

  function makeCast(p) {
    const cast = document.createElement('div');
    cast.className = 'panel-cast';
    cast.style.setProperty('--hue', 'var(' + HUES[p.index % HUES.length] + ')');
    // Mirrors the panel's own slot pair, so a theme that paints the
    // panel edge as a gradient slice can put the same slice on the floor.
    cast.style.setProperty('--hue-next', 'var(' + HUES[(p.index + 1) % HUES.length] + ')');
    castLayer.appendChild(cast);
    return cast;
  }

  function placeCast(p) {
    if (!p.cast) return;
    p.cast.style.setProperty('--cx', Math.round(p.pos.x) + 'px');
    p.cast.style.setProperty('--cz', Math.round(p.pos.z) + 'px');
    // A panel hovering well above the floor throws a wider, fainter
    // pool than one sitting close to it — the one bit of real light
    // behaviour worth imitating.
    const drop = clamp((FLOOR_Y - p.pos.y) / 520, 0.6, 1.6);
    p.cast.style.setProperty('--cspread', drop.toFixed(2));
  }

  function updateCast(p) {
    if (!p.cast) return;
    p.cast.classList.toggle('cast-busy', !!p.term.state.running);
    p.cast.classList.toggle('cast-active', active === p);
    p.cast.dataset.conn = p.term.state.connState;
    updateBlip(p);
  }

  // ─── Radar ────────────────────────────────────────────────────────
  // An overhead plan of the room. The scene answers "what is this
  // terminal saying" and answers it well; nothing in it answers "what
  // else is out there and which way am I facing", and once the camera
  // has yawed 40° the panels behind you have left the frame entirely.
  // The radar is the cheap fix — every position it needs is already in
  // p.pos, so plotting one costs two divisions.

  // The plotted box, deliberately wider and deeper than the authored
  // slots: SLOTS spans x ±450 and z −520…+30, wrapping steps 180px
  // further back each time, and dragging has no bounds at all. Sizing
  // the dish to the slots alone would pin half a busy room to its rim.
  const RADAR_X = 1000;
  const RADAR_Z_NEAR = 320;
  const RADAR_Z_FAR = -1400;

  function makeBlip(p) {
    const b = document.createElement('div');
    b.className = 'radar-blip';
    b.style.setProperty('--hue', 'var(' + HUES[p.index % HUES.length] + ')');
    radarBlips.appendChild(b);
    return b;
  }

  function placeBlip(p) {
    if (!p.blip) return;
    // The eye sits at the bottom of the dish looking up it, so near is
    // the bottom edge and the back wall is the top. Clamped into the
    // dish rather than dropped: a panel dragged out of range is still
    // open, and "there is one over there somewhere" beats no blip.
    const bx = clamp((p.pos.x / RADAR_X + 1) / 2, 0.05, 0.95);
    const by = clamp((p.pos.z - RADAR_Z_FAR) / (RADAR_Z_NEAR - RADAR_Z_FAR), 0.05, 0.95);
    p.blip.style.setProperty('--bx', (bx * 100).toFixed(1) + '%');
    p.blip.style.setProperty('--by', (by * 100).toFixed(1) + '%');
  }

  function updateBlip(p) {
    if (!p.blip) return;
    p.blip.classList.toggle('blip-active', active === p);
    p.blip.classList.toggle('blip-busy', !!p.term.state.running);
    // Read the panel's own damage class rather than connState directly.
    // That class is already gated on the boot window, and a radar that
    // showed every terminal as dead for the first second of its life
    // would be worse than no radar.
    p.blip.classList.toggle('blip-dead', p.panel.classList.contains('panel-dead'));
  }

  // ─── Focus model ──────────────────────────────────────────────────
  // One terminal at a time is "active": it squares up to the camera at
  // the stage centre, grows to reading size, stops drifting, and takes
  // the keyboard. Everything else recesses so its neon doesn't compete
  // with the transcript you just asked to read. Clicking any panel
  // hands it the active slot; Escape sends it back to its parking spot.

  // The centred panel stays at z = 0, and it is the one number in this
  // file worth defending. Pulling it toward the camera instead is the
  // obvious way to say "this is the one you're reading", and it was how
  // this worked: z = 250 under a 1250px perspective magnifies by 1.26.
  // But the browser rasterises a panel at its *layout* size and lets
  // the 3D pipeline resample the result, so 1.26× magnification is
  // 1.26× upscaling of already-rendered text — which is exactly the
  // soft, smeared transcript this was reported for. Growing --pw/--ph
  // instead lands the same rectangle on screen with every glyph drawn
  // at native resolution. The depth cue survives: the other panels
  // still recede 240px when one goes active, so the active one reads as
  // nearest without being blown up.
  const CENTER_Z = 0;

  function centerMagnification() {
    return fitScale() * (PERSPECTIVE / (PERSPECTIVE - CENTER_Z));
  }

  function stageInset() {
    return document.body.classList.contains('side-hidden') ? 0 : sidebar.offsetWidth;
  }

  function centeredPos() {
    // Shift right by half the sidebar so the enlarged panel is centred
    // in the *visible* stage rather than under the agent list.
    const shift = stageInset() / 2 / centerMagnification();
    return { x: shift, y: 4 / centerMagnification(), z: CENTER_Z, ry: 0, rx: 0 };
  }

  function centeredSize() {
    // Stop well short of the edges: the room behind the terminal — and
    // specifically the other terminals parked in it — is what makes
    // this a workspace rather than a full-screen page. Wide enough to
    // read comfortably, narrow enough that the corner slots still show
    // past it.
    //
    // The bounds are on-screen pixels, clamped before the divide, so
    // they keep meaning the same thing whatever CENTER_Z and fitScale()
    // do to the magnification.
    const m = centerMagnification();
    const availW = (window.innerWidth - stageInset() - 96) * 0.72;
    const availH = (window.innerHeight - 128) * 0.88;
    return {
      w: clamp(availW, 480, 1140) / m,
      h: clamp(availH, 354, 835) / m,
    };
  }

  // Secondary motion: the panel's frame banks against the direction it
  // is travelling and catches up. Restarting the animation needs the
  // class off for a frame — assigning the same animation name to an
  // element already running it is a no-op, so a second activate inside
  // half a second would otherwise do nothing.
  const SETTLE_MS = 460;

  function settle(p, fromX) {
    const dir = p.pos.x < fromX ? -1 : 1;
    p.el.style.setProperty('--settle-dir', String(dir));
    p.el.classList.remove('settling');
    // Read a layout property to force the removal to take effect before
    // the class goes back on; without it both mutations coalesce.
    void p.el.offsetWidth;
    p.el.classList.add('settling');
    window.clearTimeout(p.settleTimer);
    p.settleTimer = window.setTimeout(function () {
      p.el.classList.remove('settling');
    }, SETTLE_MS);
  }

  function activate(p) {
    if (active === p) return;
    if (active) park(active);
    active = p;
    if (!p) {
      document.body.classList.remove('has-active');
      statusFocus.textContent = 'active: —';
      updateSidebar();
      saveWorkspace();
      return;
    }
    p.el.classList.add('active');
    p.parked = Object.assign({}, p.pos);
    const fromX = p.pos.x;
    p.pos = centeredPos();
    resizeActive();
    place(p);
    settle(p, fromX);
    updateCast(p);
    document.body.classList.add('has-active');
    statusFocus.textContent = 'active: ' + p.title;
    sound('focus');
    // The size change animates; pin the transcript to the bottom once
    // it has settled, and hand over the keyboard. Tracks the 0.52s
    // spring on .panel's width/height, plus a frame of slack.
    window.setTimeout(function () {
      p.term.reflow();
      p.term.focusInput();
    }, 560);
    updateSidebar();
    saveWorkspace();
  }

  function park(p) {
    p.el.classList.remove('active');
    const fromX = p.pos.x;
    if (p.parked) p.pos = Object.assign({}, p.parked);
    p.panel.style.setProperty('--pw', PANEL_W + 'px');
    p.panel.style.setProperty('--ph', PANEL_H + 'px');
    if (active === p) {
      active = null;
      document.body.classList.remove('has-active');
      statusFocus.textContent = 'active: —';
    }
    place(p);
    settle(p, fromX);
    updateCast(p);
    saveWorkspace();
  }

  function toggleActive(p) {
    if (active === p) {
      park(p);
      updateSidebar();
    } else {
      activate(p);
    }
  }

  // ─── Terminal panels ──────────────────────────────────────────────

  function panelKey(endpoint, sessionId) {
    return endpoint + '#' + sessionId;
  }

  // Tracks panel-boot's duration in spatial.css, plus a frame of slack.
  const BOOT_MS = 700;

  // How far apart a batch of terminals comes up. Long enough to read as
  // a sequence, short enough that four of them are all on inside a
  // second — any slower and it stops being flourish and starts being a
  // wait.
  const BOOT_STAGGER_MS = 110;

  // opts.focus === false opens the panel straight into its parking
  // slot instead of taking the centre — that's what lets "open all"
  // fill the room without every terminal fighting for the camera.
  // opts.index and opts.pos are the restore path: they pin the hue and
  // the resting spot a reloaded panel had before, instead of handing it
  // the next free slot. opts.bootDelay staggers the power-on.
  function openTerminal(daemon, session, opts) {
    const focus = !opts || opts.focus !== false;
    const key = panelKey(daemon.endpoint, session.id);
    const existing = panels.get(key);
    if (existing) {
      if (focus) activate(existing);
      return existing;
    }

    const index = opts && Number.isInteger(opts.index) ? opts.index : spawnCount;
    spawnCount = Math.max(spawnCount, index + 1);

    const anchor = document.createElement('div');
    anchor.className = 'panel-anchor';
    anchor.dataset.panel = key;

    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.dataset.kind = 'term';
    panel.style.setProperty('--hue', 'var(' + HUES[index % HUES.length] + ')');
    // The following slot, so a theme can paint this panel's edge as a
    // slice of a gradient running between the two. Only the themes that
    // ask for it read this; the rest never mention --hue-next and get a
    // flat edge from --hue alone.
    panel.style.setProperty('--hue-next', 'var(' + HUES[(index + 1) % HUES.length] + ')');
    panel.style.setProperty('--pw', PANEL_W + 'px');
    panel.style.setProperty('--ph', PANEL_H + 'px');
    // Negative delay desynchronises the drift so the panels never
    // breathe in lockstep, which instantly reads as fake.
    panel.style.setProperty('--drift-delay', (index * -3.7).toFixed(1) + 's');

    const title = (session.app ? session.app + ' // ' : '') + session.id;

    const bar = document.createElement('header');
    bar.className = 'panel-bar';
    const titleEl = document.createElement('span');
    titleEl.className = 'panel-title';
    titleEl.textContent = title;
    titleEl.title = daemon.alias + ' · ' + session.id;
    bar.appendChild(titleEl);

    const controls = document.createElement('span');
    controls.className = 'panel-controls';
    controls.appendChild(ctlButton('□', 'Center or park ' + title));
    controls.appendChild(ctlButton('×', 'Close ' + title));
    bar.appendChild(controls);

    const body = document.createElement('div');
    body.className = 'panel-body';

    panel.appendChild(bar);
    panel.appendChild(body);
    anchor.appendChild(panel);
    world.appendChild(anchor);

    // A terminal reports 'disconnected' from the moment it is built,
    // before connect() has been anywhere, so damage has to wait for the
    // boot window to close. After that the two cases the operator cares
    // about — a session that dropped, and one that never came up —
    // both land here and both show as a broken screen.
    let booted = false;
    let wasDead = false;
    let wasRunning = false;

    function updateDamage() {
      // A terminal reports one last 'disconnected' as it is torn down,
      // which arrives here looking exactly like a session that dropped.
      // Closing a panel on purpose is not a failure and must not sound
      // like one.
      if (p && p.closing) return;
      const dead = booted && panel.dataset.conn === 'disconnected';
      panel.classList.toggle('panel-dead', dead);
      // The radar blip reads this class, so it has to be told whenever
      // the class moves — including from the boot timeout below, which
      // is the only caller that isn't already on the onChange path.
      if (p) updateBlip(p);
      // Edge, not level: onChange fires on every connection report, and
      // a session that stays down would otherwise sound the alarm on
      // each one.
      if (dead && !wasDead) sound('error');
      wasDead = dead;
    }

    // Power-on. opts.bootDelay staggers a batch so "open all" reads as
    // the room coming up one station at a time; the class comes back off
    // once the keyframe is spent, because .booting owns .panel's single
    // animation slot and would otherwise suppress the idle drift.
    const bootDelay = (opts && opts.bootDelay) || 0;
    anchor.classList.add('booting');
    if (bootDelay) anchor.style.setProperty('--boot-delay', bootDelay + 'ms');
    // The sweep runs with the CSS keyframe, not after it, so a staggered
    // "open all" sounds like the room coming up one station at a time
    // rather than four thuds once it already has.
    if (bootDelay) {
      window.setTimeout(function () {
        sound('boot');
      }, bootDelay);
    } else {
      sound('boot');
    }
    window.setTimeout(function () {
      anchor.classList.remove('booting');
      anchor.style.removeProperty('--boot-delay');
      booted = true;
      updateDamage();
    }, bootDelay + BOOT_MS);

    // Declared up here, not at the assignment below: MastTerminal.create
    // calls onChange synchronously while it builds (it seeds the status
    // line with 'disconnected'), so a `const p` further down would still
    // be in its temporal dead zone when the callback first runs.
    let p = null;

    const term = window.MastTerminal.create({
      endpoint: daemon.endpoint,
      token: daemon.token,
      sessionId: session.id,
      label: title,
      onChange: function (t, what) {
        if (what === 'conn') {
          panel.dataset.conn = t.state.connState;
          updateDamage();
        }
        if (what === 'busy') {
          panel.classList.toggle('panel-busy', t.state.running);
          // The falling edge is the interesting one: a turn landing is
          // the event you'd otherwise sit watching a panel to catch.
          if (wasRunning && !t.state.running) sound('turn');
          wasRunning = t.state.running;
        }
        if (p) updateCast(p);
      },
    });
    body.appendChild(term.el);

    p = {
      key: key,
      index: index,
      title: title,
      daemon: daemon,
      session: session,
      el: anchor,
      panel: panel,
      body: body,
      term: term,
      pos: slotFor(index),
      home: slotFor(index),
      parked: null,
      cast: null,
      blip: null,
      closing: false,
    };
    if (opts && opts.pos) {
      // Restored: drop it back where it was, re-deriving the facing
      // rather than trusting a saved angle, so a viewport resize since
      // the last visit still produces a panel aimed at the camera.
      p.pos = Object.assign({ x: opts.pos.x, y: opts.pos.y, z: opts.pos.z }, facingFor(opts.pos));
      p.parked = Object.assign({}, p.pos);
    }
    p.cast = makeCast(p);
    p.blip = makeBlip(p);
    place(p);
    updateCast(p);
    panels.set(key, p);
    updateCount();

    const buttons = controls.querySelectorAll('.panel-ctl');
    buttons[0].addEventListener('click', function (e) {
      e.stopPropagation();
      toggleActive(p);
    });
    buttons[1].addEventListener('click', function (e) {
      e.stopPropagation();
      closePanel(p);
    });

    // Click-to-activate, distinguished from drag-to-move by distance:
    // a press that travels less than a few pixels was a click, and a
    // click anywhere on a terminal means "this is the one I'm using".
    // Resolved in endPointer rather than here — a title-bar press takes
    // pointer capture on the viewport, so the matching pointerup never
    // reaches the anchor.
    anchor.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      press = { panel: p, x: e.clientX, y: e.clientY, ctl: !!e.target.closest('.panel-ctl') };
    });

    bar.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.panel-ctl')) return;
      startPanelDrag(p, e);
    });

    term.connect().catch(function () {
      // connect() already painted the failure into the transcript.
    });

    if (focus) activate(p);
    updateSidebar();
    saveWorkspace();
    return p;
  }

  // Open every session the daemon reported, parked, so the operator
  // can see the whole fleet at once. The first one takes the centre
  // only if nothing else already has it.
  function openAll(d) {
    const claim = !active;
    // Only count the ones that will actually boot: re-running "open all"
    // over an already-full room must not stagger the panels that are
    // merely being re-focused.
    let n = 0;
    d.sessions.forEach(function (s, i) {
      const fresh = !panels.has(panelKey(d.endpoint, s.id));
      openTerminal(d, s, {
        focus: claim && i === 0,
        bootDelay: fresh ? n * BOOT_STAGGER_MS : 0,
      });
      if (fresh) n += 1;
    });
  }

  function ctlButton(glyph, label) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'panel-ctl';
    b.textContent = glyph;
    b.title = label;
    b.setAttribute('aria-label', label);
    return b;
  }

  function closePanel(p) {
    // Set before destroy(): tearing the client down reports a
    // disconnect, and updateDamage reads this to tell "I closed it"
    // apart from "it fell over".
    p.closing = true;
    p.term.destroy();
    p.el.classList.add('closing');
    sound('close');
    if (p.cast) {
      const cast = p.cast;
      p.cast = null;
      cast.classList.add('closing');
      window.setTimeout(function () {
        cast.remove();
      }, 320);
    }
    if (p.blip) {
      p.blip.remove();
      p.blip = null;
    }
    if (active === p) {
      active = null;
      document.body.classList.remove('has-active');
      statusFocus.textContent = 'active: —';
    }
    panels.delete(p.key);
    updateCount();
    updateSidebar();
    saveWorkspace();
    window.setTimeout(function () {
      p.el.remove();
    }, 320);
  }

  function updateCount() {
    const n = panels.size;
    hudPanels.textContent = n + (n === 1 ? ' terminal' : ' terminals');
  }

  // Re-park everything into fresh slots, in open order.
  function tile() {
    let i = 0;
    panels.forEach(function (p) {
      const slot = slotFor(i);
      i += 1;
      p.home = Object.assign({}, slot);
      p.parked = Object.assign({}, slot);
      if (p !== active) {
        p.pos = Object.assign({}, slot);
        place(p);
      }
    });
    saveWorkspace();
  }

  // ─── Dragging ─────────────────────────────────────────────────────
  // Screen-space drag deltas are rotated back into world space by the
  // camera yaw, so a panel tracks the pointer instead of sliding off
  // sideways once the turntable has been spun. Pitch is ignored — at
  // the clamped tilt the vertical error is a couple of pixels.

  let drag = null;
  let press = null;

  function startPanelDrag(p, e) {
    drag = {
      panel: p,
      startX: e.clientX,
      startY: e.clientY,
      origin: Object.assign({}, p.pos),
    };
    p.el.classList.add('dragging');
    viewport.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  let orbit = null;

  function startOrbit(e) {
    orbit = { x: e.clientX, y: e.clientY, yaw: cam.yaw, pitch: cam.pitch };
    document.body.classList.add('dragging-camera');
    viewport.setPointerCapture(e.pointerId);
  }

  viewport.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    // Anything that isn't a panel is background: orbit the turntable.
    if (!e.target.closest('.panel')) startOrbit(e);
  });

  viewport.addEventListener('pointermove', function (e) {
    if (drag) {
      // Undo the fit-scale so a 100px pointer move is a 100px world
      // move on a laptop as well as a monitor. Perspective
      // foreshortening at depth is left uncorrected — far panels track
      // slightly fast, which reads as intentional inertia.
      const s = fitScale();
      const dx = (e.clientX - drag.startX) / s;
      const dy = (e.clientY - drag.startY) / s;
      const yaw = (cam.yaw * Math.PI) / 180;
      const p = drag.panel;
      p.pos.x = drag.origin.x + dx * Math.cos(yaw);
      p.pos.z = drag.origin.z + dx * Math.sin(yaw);
      p.pos.y = drag.origin.y + dy;
      // Re-face as it moves: a panel dragged across the room turns to
      // keep looking at you, the way it would on a real curved rig.
      // The active panel stays square — it's being read.
      if (p !== active) Object.assign(p.pos, facingFor(p.pos));
      place(p);
      return;
    }
    if (orbit) {
      cam.yaw = clamp(orbit.yaw + (e.clientX - orbit.x) * 0.13, -YAW_LIMIT, YAW_LIMIT);
      cam.pitch = clamp(orbit.pitch - (e.clientY - orbit.y) * 0.08, PITCH_MIN, PITCH_MAX);
      applyCamera();
    }
  });

  function endPointer(e) {
    if (drag) {
      // A dragged panel keeps its new spot: if it was the active one,
      // that becomes the centre it snaps back to next time.
      const p = drag.panel;
      p.el.classList.remove('dragging');
      if (p !== active) p.parked = Object.assign({}, p.pos);
      drag = null;
      saveWorkspace();
    }
    if (orbit) {
      orbit = null;
      document.body.classList.remove('dragging-camera');
      saveWorkspace();
    }
    if (press) {
      const hit = press;
      press = null;
      // A control button owns its own click; a travelled press was a
      // drag. Anything else is "make this the terminal I'm using".
      if (e.type !== 'pointerup' || hit.ctl) return;
      const moved = Math.hypot(e.clientX - hit.x, e.clientY - hit.y);
      if (moved <= 5 && panels.has(hit.panel.key) && active !== hit.panel) activate(hit.panel);
    }
  }

  viewport.addEventListener('pointerup', endPointer);
  viewport.addEventListener('pointercancel', endPointer);

  // On window, not the viewport: the lean should keep tracking while
  // the pointer is over the sidebar or the HUD.
  window.addEventListener('pointermove', aimParallax);

  viewport.addEventListener(
    'wheel',
    function (e) {
      // Scrolling a transcript is not a dolly.
      if (e.target.closest('.panel-body')) return;
      e.preventDefault();
      nudgeCamera(0, 0, -e.deltaY * 0.6);
    },
    { passive: false }
  );

  // ─── Free-look ────────────────────────────────────────────────────
  // The arrow keys move the camera one fixed step per press, which is
  // the right shape for a small correction and the wrong one for
  // crossing the room: it takes a dozen taps to get from the back wall
  // out to a corner slot, and the OS key-repeat rate that would
  // otherwise cover the gap is both slow and configured somewhere else.
  //
  // WASD is held instead of tapped, driven off rAF, and ramps: a stab
  // is a nudge, a hold builds to full speed in half a second. Same
  // clamps as every other camera
  // path — nudgeCamera, orbit and the restored view all agree on what a
  // legal camera is, and free-look is not the one that gets to differ.

  const LOOK_KEYS = {
    w: [0, 0, 1],
    s: [0, 0, -1],
    a: [-1, 0, 0],
    d: [1, 0, 0],
    q: [0, 1, 0],
    e: [0, -1, 0],
  };

  // Rates are per *second*, and the step below integrates against the
  // clock rather than counting frames. Per-frame rates would fly the
  // camera twice as fast on a 120Hz display as on a 60Hz one and crawl
  // in a throttled tab, and unlike the parallax ease — which is bounded
  // by its target however often it runs — free-look travel is open
  // ended, so the difference is the whole width of the room.
  const LOOK_YAW_DPS = 33;
  const LOOK_PITCH_DPS = 21;
  const LOOK_DOLLY_PPS = 540;
  const LOOK_RAMP_S = 0.5;

  // A frame longer than this was a stall — a tab coming back from the
  // background, a long paint — and integrating it whole would teleport
  // the camera. Clamped, the stall costs travel instead.
  const LOOK_MAX_STEP = 0.05;

  const held = new Set();
  let lookFrame = 0;
  let lookSpeed = 0;
  let lookLast = 0;
  let lookSaveTimer = 0;

  function stepLook(now) {
    if (!held.size) {
      lookFrame = 0;
      lookSpeed = 0;
      lookLast = 0;
      return;
    }
    const dt = Math.min(lookLast ? (now - lookLast) / 1000 : 1 / 60, LOOK_MAX_STEP);
    lookLast = now;
    lookSpeed = Math.min(1, lookSpeed + dt / LOOK_RAMP_S);
    let dy = 0;
    let dp = 0;
    let dd = 0;
    // Summed rather than switched, so opposing keys cancel and W+D is a
    // curve rather than whichever one the browser reported last.
    held.forEach(function (k) {
      const v = LOOK_KEYS[k];
      dy += v[0];
      dp += v[1];
      dd += v[2];
    });
    const step = lookSpeed * dt;
    cam.yaw = clamp(cam.yaw + dy * LOOK_YAW_DPS * step, -YAW_LIMIT, YAW_LIMIT);
    cam.pitch = clamp(cam.pitch + dp * LOOK_PITCH_DPS * step, PITCH_MIN, PITCH_MAX);
    cam.dolly = clamp(cam.dolly + dd * LOOK_DOLLY_PPS * step, DOLLY_MIN, DOLLY_MAX);
    // Deliberately not nudgeCamera(): that saves the workspace, and this
    // runs every frame. The save happens on release.
    applyCamera();
    lookFrame = window.requestAnimationFrame(stepLook);
  }

  function releaseLook(k) {
    if (!held.delete(k)) return;
    window.clearTimeout(lookSaveTimer);
    lookSaveTimer = window.setTimeout(saveWorkspace, 220);
  }

  document.addEventListener('keyup', function (e) {
    releaseLook(e.key.toLowerCase());
  });

  // A key held while the tab loses focus never delivers its keyup, and
  // the camera would still be travelling when you came back.
  window.addEventListener('blur', function () {
    if (!held.size) return;
    held.clear();
    lookSpeed = 0;
    lookLast = 0;
    saveWorkspace();
  });

  document.addEventListener('keydown', function (e) {
    // Escape works from inside a prompt — it's the way back out of a
    // centered terminal. Every other binding yields to the text field.
    if (e.key === 'Escape') {
      if (active) {
        park(active);
        updateSidebar();
        viewport.focus({ preventScroll: true });
        e.preventDefault();
      }
      return;
    }
    if (e.target.closest('input, textarea')) return;

    // Free-look, before the switch: these are held keys, and letting the
    // browser's auto-repeat drive them would move the camera at the
    // user's key-repeat setting instead of at the frame rate. Modified
    // presses are the browser's (⌘D, ⌃W) and are left alone.
    const look = !e.metaKey && !e.ctrlKey && !e.altKey && LOOK_KEYS[e.key.toLowerCase()];
    if (look) {
      if (!held.has(e.key.toLowerCase())) {
        held.add(e.key.toLowerCase());
        if (!lookFrame) lookFrame = window.requestAnimationFrame(stepLook);
      }
      e.preventDefault();
      return;
    }

    switch (e.key) {
      case 'ArrowLeft':
        nudgeCamera(-4, 0, 0);
        break;
      case 'ArrowRight':
        nudgeCamera(4, 0, 0);
        break;
      case 'ArrowUp':
        nudgeCamera(0, 2, 0);
        break;
      case 'ArrowDown':
        nudgeCamera(0, -2, 0);
        break;
      case '+':
      case '=':
        nudgeCamera(0, 0, 60);
        break;
      case '-':
        nudgeCamera(0, 0, -60);
        break;
      case 'r':
      case 'R':
      case '0':
        resetView();
        break;
      // 'o' rather than 'a': WASD wants the left hand's home row, and
      // "open all" is a once-a-session command that can afford to move.
      case 'o':
      case 'O':
        daemons.forEach(openAll);
        break;
      default:
        return;
    }
    e.preventDefault();
  });

  function resetView() {
    Object.assign(cam, HOME);
    applyCamera();
    if (active) park(active);
    tile();
    updateSidebar();
  }

  // ─── Workspace persistence ────────────────────────────────────────
  // A refresh used to land you in an empty room: the daemon list came
  // back but every open terminal was gone. The layout is the thing the
  // operator arranged by hand, so it is worth keeping — which sessions
  // were open, where each one rests, which one had the camera, and
  // where the camera was. Panel *contents* are not saved; each restored
  // terminal reconnects and replays its own event log, which is the
  // authoritative transcript anyway.

  const WORKSPACE_KEY = 'mast-web:spatial-workspace';
  const saved = readWorkspace();
  let restoring = false;
  let saveTimer = 0;

  // Endpoints whose saved panels have not been restored yet. A daemon
  // that hasn't answered yet looks exactly like a daemon whose sessions
  // are gone, and guessing wrong is expensive: concluding "gone" throws
  // the layout away, and the next save makes that permanent. So rows
  // stay armed here until the daemon actually reports a session list —
  // they survive every write in the meantime, and each refresh gets
  // another go at them.
  const pending = new Set();
  if (saved) {
    saved.panels.forEach(function (r) {
      pending.add(r.endpoint);
    });
  }

  function rowKey(r) {
    return r.endpoint + '#' + r.id;
  }

  function readWorkspace() {
    try {
      const raw = localStorage.getItem(WORKSPACE_KEY);
      const w = raw ? JSON.parse(raw) : null;
      if (w && w.v === 1 && Array.isArray(w.panels)) return w;
    } catch {
      /* corrupt or blocked storage — open an empty room */
    }
    return null;
  }

  // The durable spot is where a panel *rests*, not where it is right
  // now: the active one is temporarily at the stage centre, and its
  // parking slot is what should come back on reload.
  function restingPos(p) {
    return p.parked || p.pos;
  }

  function writeWorkspace() {
    const rows = [];
    panels.forEach(function (p) {
      const at = restingPos(p);
      rows.push({
        endpoint: p.daemon.endpoint,
        id: p.session.id,
        index: p.index,
        x: Math.round(at.x),
        y: Math.round(at.y),
        z: Math.round(at.z),
      });
    });
    // Carry forward anything still waiting on an unreachable daemon, so
    // a save triggered while it is down doesn't erase the layout.
    if (saved && pending.size) {
      const live = new Set(rows.map(rowKey));
      saved.panels.forEach(function (r) {
        if (pending.has(r.endpoint) && !live.has(rowKey(r))) rows.push(r);
      });
    }

    try {
      localStorage.setItem(
        WORKSPACE_KEY,
        JSON.stringify({
          v: 1,
          cam: { yaw: cam.yaw, pitch: cam.pitch, dolly: cam.dolly },
          active: active ? active.key : pending.size && saved ? saved.active : null,
          panels: rows,
        })
      );
    } catch {
      /* blocked storage — the room is still live in memory */
    }
  }

  // Coalesced: a drag fires this on every pointerup and a restore fires
  // it once per panel, and none of that needs its own storage write.
  function saveWorkspace() {
    if (restoring || saveTimer) return;
    saveTimer = window.setTimeout(function () {
      saveTimer = 0;
      writeWorkspace();
    }, 250);
  }

  function restoreCamera() {
    if (!saved || !saved.cam) return;
    cam.yaw = clamp(Number(saved.cam.yaw) || 0, -YAW_LIMIT, YAW_LIMIT);
    cam.pitch = clamp(Number(saved.cam.pitch) || 0, PITCH_MIN, PITCH_MAX);
    cam.dolly = clamp(Number(saved.cam.dolly) || 0, DOLLY_MIN, DOLLY_MAX);
    applyCamera();
  }

  // Called every time a daemon's session list lands — at boot, on the
  // 30s poll, on ↻, and when one is attached. It is a no-op unless that
  // endpoint still has rows armed, so a re-list never reopens a
  // terminal the operator deliberately closed.
  //
  // A saved session that has genuinely disappeared upstream is dropped
  // rather than opened against a dead id; one whose daemon merely
  // failed to answer is left armed for the next attempt.
  function restoreInto(d) {
    if (!saved || !pending.has(d.endpoint) || d.state !== 'connected') return;
    pending.delete(d.endpoint);

    const mine = saved.panels.filter(function (r) {
      return r.endpoint === d.endpoint;
    });
    if (mine.length === 0) return;

    restoring = true;
    let toFocus = null;
    let boot = 0;
    mine.forEach(function (r) {
      const session = d.sessions.find(function (s) {
        return s.id === r.id;
      });
      if (!session) return;
      const p = openTerminal(d, session, {
        focus: false,
        index: r.index,
        pos: { x: r.x, y: r.y, z: r.z },
        // A restored room powers back up in the order it was saved,
        // which is a much better answer to "did my layout survive?"
        // than four panels blinking into existence at once.
        bootDelay: boot,
      });
      boot += BOOT_STAGGER_MS;
      if (p && saved.active === p.key) toFocus = p;
    });
    restoring = false;

    // No save here: a restore reproduces what is already on disk, and
    // writing at this point is what used to flatten the layout when the
    // list came back short.
    if (toFocus) activate(toFocus);
  }

  // ─── Daemons + sessions ───────────────────────────────────────────
  // The registry, its persistence and the sidebar that lists it live in
  // agents.js, shared with solo.html: which daemons are attached and
  // what sessions they hold is the same question in any shell, and only
  // the answer to "what happens when you click one" differs. This shell
  // opens a floating panel in the room and paints rows from the panel
  // map; the module knows neither.

  const agents = window.MastAgents.create({
    listEl: daemonList,
    onOpen: openTerminal,
    onOpenAll: openAll,
    // Detaching a daemon takes its terminals down with it.
    onDetach: function (d) {
      panels.forEach(function (p) {
        if (p.daemon.endpoint === d.endpoint) closePanel(p);
      });
    },
    onRefreshed: restoreInto,
    sessionState: function (d, s) {
      const p = panels.get(panelKey(d.endpoint, s.id));
      return { open: !!p, active: !!p && p === active };
    },
  });

  const daemons = agents.daemons;

  function updateSidebar() {
    agents.render();
  }

  // ─── Wiring ───────────────────────────────────────────────────────

  document.getElementById('btn-tile').addEventListener('click', function () {
    if (active) park(active);
    tile();
    updateSidebar();
  });
  document.getElementById('btn-reset').addEventListener('click', resetView);
  document.getElementById('btn-refresh').addEventListener('click', agents.refreshAll);

  const btnAudio = document.getElementById('btn-audio');

  function paintAudioButton() {
    const lit = !!(window.MastRoomAudio && window.MastRoomAudio.enabled());
    btnAudio.setAttribute('aria-pressed', lit ? 'true' : 'false');
    btnAudio.title = 'Room audio (' + (lit ? 'on' : 'off') + ')';
  }

  if (window.MastRoomAudio) {
    btnAudio.addEventListener('click', function () {
      window.MastRoomAudio.setEnabled(!window.MastRoomAudio.enabled());
      paintAudioButton();
    });
    paintAudioButton();
  } else {
    // No audio module and no way to get one — a control that cannot do
    // anything is worse than no control.
    btnAudio.remove();
  }
  document.getElementById('btn-sidebar').addEventListener('click', function () {
    const before = stageInset();
    document.body.classList.toggle('side-hidden');
    // The visible stage just changed width. Slide the arrangement to
    // match rather than re-tiling — a panel the operator dragged
    // somewhere deliberate should stay where they put it, relative to
    // the room.
    const shift = (stageInset() - before) / 2 / fitScale();
    panels.forEach(function (p) {
      if (p.parked) p.parked.x += shift;
      p.home.x += shift;
      if (p !== active) {
        p.pos.x += shift;
        place(p);
      }
    });
    if (active) {
      active.pos = centeredPos();
      resizeActive();
      place(active);
    }
  });

  function resizeActive() {
    if (!active) return;
    const size = centeredSize();
    active.panel.style.setProperty('--pw', Math.round(size.w) + 'px');
    active.panel.style.setProperty('--ph', Math.round(size.h) + 'px');
  }

  document.getElementById('add-daemon').addEventListener('submit', function (e) {
    e.preventDefault();
    const epEl = document.getElementById('add-endpoint');
    const tokEl = document.getElementById('add-token');
    const d = agents.add(epEl.value, tokEl.value);
    tokEl.value = '';
    agents.refresh(d);
  });

  window.setInterval(function () {
    statusClock.textContent = new Date().toLocaleTimeString('en-GB');
  }, 1000);

  window.addEventListener('resize', function () {
    applyCamera();
    if (active) {
      resizeActive();
      active.pos = centeredPos();
      place(active);
    }
  });

  // The floor is the largest orbit target; give it a cursor hint.
  floor.style.cursor = 'grab';

  // ─── Theme ────────────────────────────────────────────────────────
  // The room follows the theme all the way — backdrop, panel surfaces,
  // shadows and cast strength all come from the --room-* / --panel-*
  // knobs in styles.css, so a light theme gets a light room instead of
  // light windows floating in a black void. The registry and the
  // storage key live in theme.js, shared with the other shells.

  window.MastTheme.mount(document.getElementById('hud-theme'));

  // A refresh can land inside the 250ms coalescing window, which would
  // lose the last drag or focus change. pagehide fires for reloads,
  // navigations and tab close alike, and unlike unload it survives
  // bfcache — so flush there.
  window.addEventListener('pagehide', function () {
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveTimer = 0;
    }
    writeWorkspace();
  });

  // The room is a fixed-size viewport, never a scrolling document, so
  // there is no scroll position worth restoring — and restoring one is
  // actively harmful: an offset picked up once (a focus, a tab through
  // the HUD) would be reinstated by every subsequent refresh, leaving
  // the HUD scrolled off the top. Where the camera was looking is the
  // real "scroll position" here, and restoreCamera() handles that.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  window.scrollTo(0, 0);

  restoreCamera();
  applyCamera();
  updateCount();
  // Panels come back from inside the module's refresh, via
  // onRefreshed → restoreInto, as soon as a daemon reports which
  // sessions still exist.
  agents.boot().then(function (endpoints) {
    const registered = new Set(endpoints);
    // Rows for a daemon that is no longer attached have nothing left to
    // wait for; disarm them so they stop being carried forward.
    pending.forEach(function (endpoint) {
      if (!registered.has(endpoint)) pending.delete(endpoint);
    });
    // Offer the attach form the path this deployment actually serves,
    // rather than the same-origin default in the markup — behind a BFF
    // that default is the one address that is certainly wrong.
    const found = agents.site();
    if (found && found.endpoint) document.getElementById('add-endpoint').value = found.endpoint;
  });

  // ─── Public seam ──────────────────────────────────────────────────
  window.MastSpatial = {
    panels: panels,
    daemons: daemons,
    open: openTerminal,
    openAll: openAll,
    activate: activate,
    camera: cam,
    resetView: resetView,
    refreshAll: agents.refreshAll,
  };
})();
