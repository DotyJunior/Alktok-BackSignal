/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export class AudioEngine {
  private context: AudioContext;
  private stream: MediaStream | null = null;
  private inputNode: MediaStreamAudioSourceNode | null = null;

  // --- Clean Split Stream Architecture ---
  // A. Visualization Stream (Fed directly by raw microphone source)
  private analyzerNode: AnalyserNode;

  // B. Optional Tactical Filter Chain (Isolated to prevent noise crashes)
  private filterNode: BiquadFilterNode;
  private distortionNode: WaveShaperNode;
  private compressorNode: DynamicsCompressorNode;
  private outputGainNode: GainNode;
  private processedGainNode: GainNode;
  private isFilterEnabled: boolean = true;

  // C. WebRTC Transmission Destination (Fully compatible output)
  private processedDestinationNode: MediaStreamAudioDestinationNode | null = null;

  constructor() {
    // Standard AudioContext initialization with fallback
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    this.context = new AudioContextClass();

    // 1. Initialize core AnalyzerNode for direct real-time rendering of raw vocal streams.
    this.analyzerNode = this.context.createAnalyser();
    this.analyzerNode.fftSize = 256;

    // 2. Build the high-quality Bandpass Filter (300Hz to 3400Hz) mimicking radio speech characteristics.
    this.filterNode = this.context.createBiquadFilter();
    this.filterNode.type = 'bandpass';
    this.filterNode.frequency.value = 1600;
    this.filterNode.Q.value = 1.5;

    // 3. Build WaveShaperNode for authentic, non-destructive low-fidelity clip/saturation.
    this.distortionNode = this.context.createWaveShaper();
    this.distortionNode.curve = this.makeDistortionCurve(20);
    this.distortionNode.oversample = '4x';

    // 4. Build standard DynamicsCompressorNode to compress level peaks and clean raw volume surges.
    this.compressorNode = this.context.createDynamicsCompressor();
    this.compressorNode.threshold.setValueAtTime(-24, this.context.currentTime);
    this.compressorNode.knee.setValueAtTime(40, this.context.currentTime);
    this.compressorNode.ratio.setValueAtTime(12, this.context.currentTime);
    this.compressorNode.attack.setValueAtTime(0.005, this.context.currentTime);
    this.compressorNode.release.setValueAtTime(0.25, this.context.currentTime);

    // 5. Create local monitoring and processed streaming output gain nodes.
    // Local monitor gain is silenced (0.0) by default to prevent audio feedback/howl.
    this.outputGainNode = this.context.createGain();
    this.outputGainNode.gain.value = 0.0;

    this.processedGainNode = this.context.createGain();
    this.processedGainNode.gain.value = 1.0;

    // 6. Set up the WebRTC compatible media stream destination context.
    try {
      this.processedDestinationNode = this.context.createMediaStreamDestination();
    } catch (e) {
      console.warn('WebRTC MediaStreamAudioDestinationNode is not supported, reverting to raw stream fallback.', e);
    }

    // Connect the tactical filter processing sub-chain:
    // filterNode ➔ distortionNode ➔ compressorNode ➔ outputs
    this.filterNode.connect(this.distortionNode);
    this.distortionNode.connect(this.compressorNode);
    this.compressorNode.connect(this.outputGainNode);
    this.compressorNode.connect(this.processedGainNode);

    // Route safe outputs to computer speakers/headphones
    this.outputGainNode.connect(this.context.destination);

    // Route active output to the WebRTC transmission channel
    if (this.processedDestinationNode) {
      this.processedGainNode.connect(this.processedDestinationNode);
    }
  }

  /**
   * Generates a stable clip-shaping curve for radio distortion.
   */
  private makeDistortionCurve(amount: number) {
    const k = typeof amount === 'number' && !isNaN(amount) ? amount : 20;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    for (let i = 0; i < n_samples; ++i) {
      const x = (i * 2) / n_samples - 1;
      // Stable wave shaping calculation avoiding any divide-by-zero errors
      curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  /**
   * Safe getter to fetch real-time WebRTC compatible stream.
   */
  public getProcessedStream(): MediaStream | null {
    if (this.processedDestinationNode) {
      return this.processedDestinationNode.stream;
    }
    return this.stream;
  }

  /**
   * Non-destructive tactical filter toggling on-the-fly.
   */
  public setFilterEnabled(enabled: boolean) {
    this.isFilterEnabled = enabled;
    if (this.inputNode) {
      try {
        // Disconnect output routing branches before rewiring (retaining raw analyzer branch)
        this.inputNode.disconnect(this.filterNode);
        this.inputNode.disconnect(this.outputGainNode);
        this.inputNode.disconnect(this.processedGainNode);
      } catch (_) {}

      if (this.isFilterEnabled) {
        this.inputNode.connect(this.filterNode);
      } else {
        this.inputNode.connect(this.outputGainNode);
        this.inputNode.connect(this.processedGainNode);
      }
    }
  }

  /**
   * Enables or disables stream level audio tracks.
   */
  public setMicActive(active: boolean) {
    if (this.stream) {
      this.stream.getAudioTracks().forEach(track => {
        try {
          track.enabled = active;
        } catch (_) {}
      });
    }
  }

  /**
   * Gracefully starts low-leak capture of browser mic and splits audio.
   */
  public async startMic(): Promise<boolean> {
    if (this.context.state === 'suspended') {
      await this.context.resume().catch(() => {});
    }

    try {
      // Release current tracks and inputs to prevent duplicate allocations/feedback
      this.stopMic();

      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });

      this.inputNode = this.context.createMediaStreamSource(this.stream);

      // --- Split Stream Routing (Branch A) ---
      // Direct raw input connection to analyzer.
      // High UI integrity: Visualization always works and reacts even on filter failures!
      this.inputNode.connect(this.analyzerNode);

      // --- Split Stream Routing (Branch B) ---
      // Selectively route input stream based on dynamic processing configurations
      if (this.isFilterEnabled) {
        this.inputNode.connect(this.filterNode);
      } else {
        this.inputNode.connect(this.outputGainNode);
        this.inputNode.connect(this.processedGainNode);
      }

      if (this.context.state === 'suspended') {
        await this.context.resume().catch(() => {});
      }
      return true;
    } catch (err) {
      console.error('Failed to initialize microphone devices or connect audio pipeline branches:', err);
      return false;
    }
  }

  /**
   * Releases and halts active audio stream tracks cleanly.
   */
  public stopMic() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => {
        try {
          track.stop();
        } catch (_) {}
      });
      this.stream = null;
    }
    if (this.inputNode) {
      try {
        this.inputNode.disconnect();
      } catch (_) {}
      this.inputNode = null;
    }
  }

  /**
   * Keeps parameter compatible with potential legacy elements.
   */
  public setMute(mute: boolean) {
    const targetValue = mute ? 0.0 : 0.0; // Local listening remains silent within feedback loop context
    this.outputGainNode.gain.setTargetAtTime(targetValue, this.context.currentTime, 0.05);
  }

  /**
   * Returns clean real-time frequency distribution data.
   */
  public getAnalyzerData(): Uint8Array {
    const dataArray = new Uint8Array(this.analyzerNode.frequencyBinCount);
    this.analyzerNode.getByteFrequencyData(dataArray);
    return dataArray;
  }

  /**
   * Beep generation sequence triggered during PTT state transactions.
   */
  public playBeep(frequency: number = 880, duration: number = 0.1) {
    if (this.context.state === 'suspended') {
      this.context.resume().catch(() => {});
    }
    const osc = this.context.createOscillator();
    const gain = this.context.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequency, this.context.currentTime);

    gain.gain.setValueAtTime(0.1, this.context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.context.currentTime + duration);

    osc.connect(gain);
    gain.connect(this.context.destination);

    osc.start();
    osc.stop(this.context.currentTime + duration);
  }

  /**
   * Generates white noise sequence for simulated static squelch noise.
   */
  public playNoise(duration: number = 0.2, volume: number = 0.08) {
    if (this.context.state === 'suspended') {
      this.context.resume().catch(() => {});
    }
    try {
      const bufferSize = this.context.sampleRate * duration;
      const buffer = this.context.createBuffer(1, bufferSize, this.context.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }

      const noise = this.context.createBufferSource();
      noise.buffer = buffer;

      const noiseFilter = this.context.createBiquadFilter();
      noiseFilter.type = 'bandpass';
      noiseFilter.frequency.setValueAtTime(1200, this.context.currentTime);
      noiseFilter.Q.setValueAtTime(1.2, this.context.currentTime);

      const gain = this.context.createGain();
      gain.gain.setValueAtTime(volume, this.context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.context.currentTime + duration);

      noise.connect(noiseFilter);
      noiseFilter.connect(gain);
      gain.connect(this.context.destination);

      noise.start();
      noise.stop(this.context.currentTime + duration);
    } catch (e) {
      console.error('Failed to generate white noise static squelch burst:', e);
    }
  }

  /**
   * Final cleanup of contextual systems.
   */
  public close() {
    this.stopMic();
    if (this.context) {
      this.context.close().catch(() => {});
    }
  }
}
