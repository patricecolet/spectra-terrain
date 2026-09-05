// Wraps the Web Audio API's native real-time FFT (AnalyserNode) around a
// loaded sound file: decode once, play in stereo, and read the left/right
// frequency spectra separately every frame while it plays.
//
// The AnalyserNode itself is linear-frequency (each raw bin is the same
// number of Hz wide), which crushes bass and low-mid into a handful of bins
// out of thousands while treble — where the ear tells frequencies apart far
// less precisely — gets most of the bins. We run the FFT at high resolution
// (RAW_BINS) and then resample it down to `bins` log-spaced bands, so bass /
// low-mid / mid each get a fair, visually distinguishable share of the
// terrain's width instead of being squeezed into its first sliver.
const RAW_BINS = 4096;
const MIN_FREQ = 30; // Hz — below this is mostly inaudible rumble, not worth a band

export class AudioAnalyser {
  constructor(bins = 128) {
    this.bins = bins;
    this.context = null;
    this.splitter = null;
    this.analyserL = null;
    this.analyserR = null;
    this.rawL = new Uint8Array(RAW_BINS);
    this.rawR = new Uint8Array(RAW_BINS);
    this.freqDataL = new Uint8Array(bins);
    this.freqDataR = new Uint8Array(bins);
    this.bandRanges = null;
    this.isPlaying = false;

    // Sources that are playing or waiting for their scheduled start time.
    // Normally one; two during the overlap where the next track is already
    // scheduled and the current one hasn't run out yet.
    this.scheduled = [];
    this.endsAt = 0; // context time at which the last scheduled source ends
    this.queuedUrl = null;
    this._queueing = false;
    this._prepared = null; // { url, buffer } — at most one, see prepare()

    this.onEnded = null;   // nothing left to play (not fired by stop())
    this.onAdvance = null; // a queued track has just taken over, seamlessly
  }

  async loadFile(file) {
    await this._ensureContext();
    const arrayBuffer = await file.arrayBuffer();
    this._play(await this.context.decodeAudioData(arrayBuffer));
  }

  async loadURL(url) {
    await this._ensureContext();
    this._play(await this._take(url));
  }

  // Schedules `url` to start at the exact sample the current track ends on.
  // This is what removes the gap between tracks: fetching and decoding both
  // happen while the current track is still playing, and the handover is a
  // start time given to the audio clock rather than a reaction to an 'ended'
  // event, which only fires once the silence has already begun.
  async queueNext(url) {
    if (this._queueing || this.queuedUrl === url || !this.scheduled.length) return;
    this._queueing = true;
    try {
      const buffer = await this._take(url);
      if (!this.scheduled.length) return; // stopped while we were decoding
      this.queuedUrl = url;
      this._startBuffer(buffer, this.endsAt);
    } finally {
      this._queueing = false;
    }
  }

  // Seconds of sound still scheduled ahead of the playhead.
  get remaining() {
    if (!this.context || !this.scheduled.length) return Infinity;
    return this.endsAt - this.context.currentTime;
  }

  // Decoding works fine on a still-suspended context, so a track armed by a
  // deep link can be fetched and decoded while we wait for the first user
  // gesture, and then start instantly. Only ever one buffer is kept here: a
  // decoded album track is ~100 MB of raw PCM, so caching them all is out.
  async prepare(url) {
    this.ensureContext();
    if (this._prepared && this._prepared.url === url) return;
    this._prepared = { url, buffer: await this._decode(url) };
  }

  async _take(url) {
    if (this._prepared && this._prepared.url === url) {
      const { buffer } = this._prepared;
      this._prepared = null;
      return buffer;
    }
    return this._decode(url);
  }

  async _decode(url) {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    return this.context.decodeAudioData(arrayBuffer);
  }

  ensureContext() {
    if (!this.context) {
      this.context = new (window.AudioContext || window.webkitAudioContext)();
    }
    return this.context;
  }

  // Browsers only let an AudioContext leave 'suspended' from inside a user
  // gesture, and Chrome's resume() promise simply never settles when called
  // outside one. Callers must therefore check this BEFORE awaiting anything:
  // otherwise a deep link (#slug) hangs mid-load forever, with no rejection
  // to catch and so no way to even offer a fallback.
  canStart() {
    return this.ensureContext().state === 'running';
  }

  // Must be called from inside a user gesture: that is the only moment the
  // browser lets the context leave 'suspended', and until it has, canStart()
  // stays false no matter how many gestures have already happened.
  async unlock() {
    await this._ensureContext();
  }

  async _ensureContext() {
    this.ensureContext();
    if (this.context.state === 'suspended') {
      await this.context.resume();
    }
  }

  // Precomputes, for each of the `bins` output bands, which range of raw
  // (linear-frequency) FFT bins to fold together. Band edges are spaced
  // logarithmically from MIN_FREQ to Nyquist, matching how the ear divides
  // up the spectrum, so e.g. 30-60Hz gets its own band just like 3-6kHz does.
  _buildBandRanges(sampleRate) {
    const nyquist = sampleRate / 2;
    const fftSize = RAW_BINS * 2;
    const edges = new Array(this.bins + 1);
    for (let i = 0; i <= this.bins; i++) {
      const t = i / this.bins;
      edges[i] = MIN_FREQ * Math.pow(nyquist / MIN_FREQ, t);
    }
    this.bandRanges = [];
    for (let i = 0; i < this.bins; i++) {
      let start = Math.floor((edges[i] * fftSize) / sampleRate);
      let end = Math.floor((edges[i + 1] * fftSize) / sampleRate);
      start = Math.max(0, Math.min(RAW_BINS - 1, start));
      end = Math.max(start + 1, Math.min(RAW_BINS, end));
      this.bandRanges.push([start, end]);
    }
  }

  _foldToBands(raw, out) {
    for (let i = 0; i < this.bandRanges.length; i++) {
      const [start, end] = this.bandRanges[i];
      let max = 0;
      for (let j = start; j < end; j++) {
        if (raw[j] > max) max = raw[j];
      }
      out[i] = max;
    }
  }

  _ensureGraph() {
    if (this.splitter) return;
    this.splitter = this.context.createChannelSplitter(2);
    this.analyserL = this.context.createAnalyser();
    this.analyserR = this.context.createAnalyser();
    this.analyserL.fftSize = RAW_BINS * 2;
    this.analyserR.fftSize = RAW_BINS * 2;
    this.analyserL.smoothingTimeConstant = 0.6;
    this.analyserR.smoothingTimeConstant = 0.6;
    this.splitter.connect(this.analyserL, 0);
    this.splitter.connect(this.analyserR, 1);
    this._buildBandRanges(this.context.sampleRate);
  }

  // Starts now, dropping whatever was playing or queued: this is a deliberate
  // jump (a click on another track), not the seamless chain of queueNext().
  _play(audioBuffer) {
    this._stopAll();
    this._startBuffer(audioBuffer, 0);
  }

  _startBuffer(audioBuffer, when) {
    this._ensureGraph();
    const source = this.context.createBufferSource();
    source.buffer = audioBuffer;

    // Actual playback goes straight to the speakers; the splitter+analysers
    // are a parallel, non-destructive tap used only for reading the spectrum.
    source.connect(this.context.destination);
    source.connect(this.splitter);

    const at = Math.max(when, this.context.currentTime);
    source.start(at);

    const entry = { source, endsAt: at + audioBuffer.duration, cancelled: false };
    this.scheduled.push(entry);
    this.endsAt = entry.endsAt;
    this.isPlaying = true;

    source.onended = () => {
      const i = this.scheduled.indexOf(entry);
      if (i !== -1) this.scheduled.splice(i, 1);
      if (entry.cancelled) return;
      if (this.scheduled.length) {
        // A queued track took over at this very instant — nothing to restart,
        // only the display has to catch up.
        this.queuedUrl = null;
        if (this.onAdvance) this.onAdvance();
        return;
      }
      this.isPlaying = false;
      if (this.onEnded) this.onEnded();
    };
  }

  _stopAll() {
    for (const entry of this.scheduled) {
      entry.cancelled = true;
      try { entry.source.stop(); } catch (e) { /* already stopped */ }
    }
    this.scheduled.length = 0;
    this.queuedUrl = null;
    this.isPlaying = false;
  }

  stop() {
    this._stopAll();
  }

  getFrequencyData() {
    if (this.analyserL) {
      this.analyserL.getByteFrequencyData(this.rawL);
      this._foldToBands(this.rawL, this.freqDataL);
    }
    if (this.analyserR) {
      this.analyserR.getByteFrequencyData(this.rawR);
      this._foldToBands(this.rawR, this.freqDataR);
    }
    return { left: this.freqDataL, right: this.freqDataR };
  }

  // How many of the low-end bands (out of `bins`) fall below freqHz -- the
  // exact count for a given cutoff depends on the real sample rate, not a
  // guessed constant, since the bands are log-spaced from MIN_FREQ to
  // Nyquist (see _buildBandRanges). Only meaningful once the graph exists
  // (i.e. during playback, which is the only time callers need this).
  binsUpTo(freqHz) {
    const nyquist = this.context.sampleRate / 2;
    return Math.round(this.bins * Math.log(freqHz / MIN_FREQ) / Math.log(nyquist / MIN_FREQ));
  }
}
