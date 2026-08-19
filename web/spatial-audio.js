// spatial-audio.js — the room's voice.
//
// Five cues, all synthesized: an oscillator and a gain envelope each, no
// sample files. That is a few hundred bytes of code against a few
// hundred kilobytes of audio, it needs no CDN and no build step, and
// retuning the room's mood is a matter of changing two numbers rather
// than re-recording anything.
//
// Every cue is a *shape* rather than a note. A rising interval reads as
// arriving and a falling one as leaving without anybody being told which
// is which, and that is the whole reason these are worth having: they
// report fleet events to the half of your attention that is not reading
// a transcript.
//
// Off by default, and persisted. Sound on a web page is an imposition
// until it has been asked for, and a fleet console is exactly the kind
// of thing that ends up on a shared desk.
//
// Loaded by spatial.html only; index.html does not know this file
// exists, and spatial.js treats it as optional.

(function () {
  'use strict';

  const KEY = 'mast-web:room-audio';

  // Quiet. This is peripheral information, at the same volume the floor
  // casts are peripheral light.
  const MASTER = 0.085;

  // Past a few simultaneous voices a cue stops being a cue and becomes
  // noise, and a staggered "open all" would otherwise stack one boot
  // sweep per panel on top of itself.
  const MAX_VOICES = 5;

  const CUES = {
    // Arriving: a short rise.
    focus: { type: 'triangle', from: 520, to: 780, dur: 0.11, gain: 0.5 },
    // Powering on: a low sweep up through a lowpass, so it reads as a
    // machine coming up rather than as a beep.
    boot: { type: 'sawtooth', from: 90, to: 460, dur: 0.34, gain: 0.26, filter: 1400 },
    // Leaving: the focus blip, backwards and lower.
    close: { type: 'triangle', from: 480, to: 190, dur: 0.16, gain: 0.42 },
    // A turn landing. The one pleasant sound in the set, and the one
    // you'll hear most — a fifth above the root, struck just late enough
    // to ring rather than beat.
    turn: { type: 'sine', from: 880, to: 880, dur: 0.42, gain: 0.32, second: 1320 },
    // Something dropped. Detuned, low and deliberately unmusical: this
    // is the only cue that should be able to interrupt a thought.
    error: { type: 'square', from: 190, to: 96, dur: 0.3, gain: 0.3, filter: 620 },
  };

  let ctx = null;
  let master = null;
  let voices = 0;
  let on = read();

  function read() {
    try {
      return localStorage.getItem(KEY) === '1';
    } catch {
      /* blocked storage — stay quiet, which is the safe default */
      return false;
    }
  }

  // Built on first play rather than at load: browsers refuse to start an
  // AudioContext outside a user gesture, and one constructed too early
  // lands in 'suspended' and stays there.
  function context() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!ctx) {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = MASTER;
      master.connect(ctx.destination);
    }
    // Suspended again every time the tab is backgrounded.
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function voice(c, cue, at, from, to) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = cue.type;
    osc.frequency.setValueAtTime(from, at);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, at + cue.dur);

    // An 8ms attack, and a floor of 0.0001 because exponential ramps
    // cannot touch zero. Starting a gain at full volume clicks — the
    // discontinuity is a broadband transient, and it is the whole
    // difference between a cue and a pop.
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(cue.gain, at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + cue.dur);

    let node = osc;
    if (cue.filter) {
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = cue.filter;
      osc.connect(lp);
      node = lp;
    }
    node.connect(gain);
    gain.connect(master);

    voices += 1;
    osc.onended = function () {
      voices -= 1;
    };
    osc.start(at);
    osc.stop(at + cue.dur + 0.02);
  }

  function play(name) {
    if (!on) return;
    const cue = CUES[name];
    if (!cue) return;
    if (voices >= MAX_VOICES) return;
    let c = null;
    try {
      c = context();
    } catch {
      /* no audio device, or the context was refused — stay silent */
      return;
    }
    if (!c) return;
    const at = c.currentTime;
    voice(c, cue, at, cue.from, cue.to);
    if (cue.second) voice(c, cue, at + 0.055, cue.second, cue.second);
  }

  function setEnabled(next) {
    on = !!next;
    try {
      localStorage.setItem(KEY, on ? '1' : '0');
    } catch {
      /* the setting won't survive a reload; the session still works */
    }
    // Switching it on is itself the user gesture the AudioContext needs,
    // and answering the click is the only way to know it worked.
    if (on) play('focus');
  }

  window.MastRoomAudio = {
    enabled: function () {
      return on;
    },
    setEnabled: setEnabled,
    play: play,
  };
})();
