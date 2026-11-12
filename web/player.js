// CameraView player: plays a go2rtc stream in a <video> element.
// Tries WebRTC first (lowest latency), then falls back to MSE over WebSocket.

const MSE_CODECS = [
  'avc1.640029', // H.264 high 4.1
  'avc1.64002A', // H.264 high 4.2
  'avc1.640033', // H.264 high 5.1
  'hvc1.1.6.L153.B0', // H.265 main 5.1
  'mp4a.40.2', // AAC LC
  'mp4a.40.5', // AAC HE
  'flac',
  'opus',
];

// Hint for Chrome's Local Network Access checks (ignored by other browsers).
export function lnaOptions(url) {
  try {
    const host = new URL(url).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
      return { targetAddressSpace: 'loopback' };
    }
    return { targetAddressSpace: 'local' };
  } catch {
    return {};
  }
}

function waitIceGathering(pc, timeoutMs = 2500) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

export class StreamPlayer {
  /**
   * @param {HTMLVideoElement} video
   * @param {{gateway: string, stream: string, modes?: string[], onStatus?: (s: {state: string, mode?: string, detail?: string}) => void}} opts
   */
  constructor(video, opts) {
    this.video = video;
    this.gateway = opts.gateway.replace(/\/+$/, '');
    this.stream = opts.stream;
    this.modes = opts.modes || ['webrtc', 'mse'];
    this.audio = opts.audio ?? true;
    this.onStatus = opts.onStatus || (() => {});
    this.pc = null;
    this.ws = null;
    this.ms = null;
    this.stopped = true;
    this.retryTimer = 0;
    this.retryDelay = 2000;
    this.watchdog = 0;
    this.mode = '';
  }

  status(state, detail) {
    this.onStatus({ state, mode: this.mode, detail });
  }

  async start() {
    this.stopped = false;
    clearTimeout(this.retryTimer);
    this.cleanup();
    this.status('connecting');

    let lastError = null;
    for (const mode of this.modes) {
      if (this.stopped) return;
      try {
        if (mode === 'webrtc' && 'RTCPeerConnection' in window) {
          await this.startWebRTC();
        } else if (mode === 'mse' && ('MediaSource' in window || 'ManagedMediaSource' in window)) {
          await this.startMSE();
        } else {
          continue;
        }
        this.mode = mode;
        this.retryDelay = 2000;
        this.status('playing');
        this.armWatchdog();
        return;
      } catch (err) {
        lastError = err;
        this.cleanup();
      }
    }
    if (this.stopped) return;
    this.mode = '';
    this.status('error', lastError ? lastError.message : 'No supported playback mode');
    this.scheduleRetry();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.cleanup();
    this.mode = '';
    this.status('stopped');
  }

  restart() {
    this.retryDelay = 2000;
    this.start();
  }

  scheduleRetry() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.start(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 30000);
  }

  fail(reason) {
    if (this.stopped) return;
    this.cleanup();
    this.mode = '';
    this.status('error', reason);
    this.scheduleRetry();
  }

  // Detect frozen streams: if currentTime stops advancing, reconnect.
  armWatchdog() {
    clearInterval(this.watchdog);
    let last = -1;
    let stalls = 0;
    this.watchdog = setInterval(() => {
      if (this.stopped || document.hidden) return;
      const t = this.video.currentTime;
      if (t === last) {
        stalls += 1;
        if (stalls >= 3) this.fail('Stream stalled');
      } else {
        stalls = 0;
      }
      last = t;
    }, 5000);
  }

  cleanup() {
    clearInterval(this.watchdog);
    if (this.pc) {
      try { this.pc.close(); } catch { /* ignore */ }
      this.pc = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onmessage = null;
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    if (this.ms) {
      try { if (this.ms.readyState === 'open') this.ms.endOfStream(); } catch { /* ignore */ }
      this.ms = null;
    }
    if (this.video.src && this.video.src.startsWith('blob:')) URL.revokeObjectURL(this.video.src);
    this.video.removeAttribute('src');
    this.video.srcObject = null;
    try { this.video.load(); } catch { /* ignore */ }
  }

  async play() {
    try {
      await this.video.play();
    } catch {
      // Autoplay with sound blocked: mute and retry.
      this.video.muted = true;
      try { await this.video.play(); } catch { /* ignore */ }
    }
  }

  async startWebRTC() {
    const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
    this.pc = pc;
    pc.addTransceiver('video', { direction: 'recvonly' });
    if (this.audio) pc.addTransceiver('audio', { direction: 'recvonly' });

    const stream = new MediaStream();
    pc.addEventListener('track', (ev) => stream.addTrack(ev.track));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceGathering(pc);

    const url = `${this.gateway}/api/webrtc?src=${encodeURIComponent(this.stream)}`;
    const res = await fetch(url, {
      method: 'POST',
      body: pc.localDescription.sdp, // sent as text/plain to avoid a CORS preflight
      ...lnaOptions(url),
    });
    if (!res.ok) throw new Error(`WebRTC: ${res.status} ${(await res.text()).trim() || res.statusText}`);
    const answer = await res.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebRTC: connection timeout')), 10000);
      const onState = () => {
        const s = pc.connectionState;
        if (s === 'connected') {
          clearTimeout(timer);
          resolve();
        } else if (s === 'failed' || s === 'closed') {
          clearTimeout(timer);
          reject(new Error(`WebRTC: ${s}`));
        }
      };
      pc.addEventListener('connectionstatechange', onState);
      onState();
    });

    if (!stream.getVideoTracks().length) throw new Error('WebRTC: no video track');

    pc.addEventListener('connectionstatechange', () => {
      if (pc === this.pc && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected')) {
        this.fail('WebRTC connection lost');
      }
    });

    this.video.srcObject = stream;
    await this.play();
  }

  startMSE() {
    return new Promise((resolve, reject) => {
      const Managed = window.ManagedMediaSource;
      const MS = Managed || window.MediaSource;
      const ms = new MS();
      this.ms = ms;

      const wsUrl = `${this.gateway.replace(/^http/, 'ws')}/api/ws?src=${encodeURIComponent(this.stream)}`;
      let settled = false;
      const timer = setTimeout(() => finish(new Error('MSE: timeout waiting for video')), 10000);
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };

      ms.addEventListener('sourceopen', () => {
        if (Managed) {
          // nothing to revoke
        } else {
          URL.revokeObjectURL(this.video.src);
        }
        let ws;
        try {
          ws = new WebSocket(wsUrl);
        } catch (e) {
          finish(new Error(`MSE: ${e.message}`));
          return;
        }
        ws.binaryType = 'arraybuffer';
        this.ws = ws;

        let sb = null;
        const queue = [];
        const flush = () => {
          if (!sb || sb.updating || !queue.length) return;
          const total = queue.reduce((n, b) => n + b.byteLength, 0);
          const data = new Uint8Array(total);
          let off = 0;
          for (const b of queue) {
            data.set(new Uint8Array(b), off);
            off += b.byteLength;
          }
          queue.length = 0;
          try {
            sb.appendBuffer(data);
          } catch (e) {
            this.fail(`MSE: ${e.message}`);
          }
        };

        ws.onopen = () => {
          const codecs = MSE_CODECS
            .filter((c) => this.audio || c.includes('vc1'))
            .filter((c) => MS.isTypeSupported(`video/mp4; codecs="${c}"`)).join();
          ws.send(JSON.stringify({ type: 'mse', value: codecs }));
        };
        ws.onerror = () => finish(new Error('MSE: WebSocket error'));
        ws.onclose = () => {
          finish(new Error('MSE: WebSocket closed'));
          if (settled && ws === this.ws) this.fail('Stream closed');
        };
        ws.onmessage = (ev) => {
          if (typeof ev.data === 'string') {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            if (msg.type === 'mse') {
              try {
                sb = ms.addSourceBuffer(msg.value);
              } catch (e) {
                finish(new Error(`MSE: unsupported codec ${msg.value}`));
                return;
              }
              sb.mode = 'segments';
              sb.addEventListener('updateend', () => {
                // Keep latency low: trim old data and chase the live edge.
                if (!sb.updating && sb.buffered.length) {
                  const end = sb.buffered.end(sb.buffered.length - 1);
                  const start0 = sb.buffered.start(0);
                  const keepFrom = end - 5;
                  if (keepFrom > start0) {
                    try {
                      sb.remove(start0, keepFrom);
                      if (ms.setLiveSeekableRange) ms.setLiveSeekableRange(keepFrom, end);
                    } catch { /* ignore */ }
                  }
                  if (this.video.currentTime < keepFrom) this.video.currentTime = keepFrom;
                  const gap = end - this.video.currentTime;
                  this.video.playbackRate = gap > 1.5 ? 1.25 : 1;
                  if (!settled && this.video.readyState >= 2) finish();
                }
                flush();
              });
              this.play();
            } else if (msg.type === 'error') {
              finish(new Error(`MSE: ${msg.value}`));
            }
          } else {
            queue.push(ev.data);
            flush();
          }
        };
      }, { once: true });

      if (Managed) {
        this.video.disableRemotePlayback = true;
        this.video.srcObject = ms;
      } else {
        this.video.src = URL.createObjectURL(ms);
      }
      this.video.addEventListener('loadeddata', () => finish(), { once: true });
    });
  }
}
