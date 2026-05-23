/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export class AudioEngine {
  private context: AudioContext;
  private inputNode: MediaStreamAudioSourceNode | null = null;
  private filterNode: BiquadFilterNode;
  private compressorNode: DynamicsCompressorNode;
  private outputNode: GainNode;
  private analyzerNode: AnalyserNode;
  private stream: MediaStream | null = null;

  constructor() {
    this.context = new (window.AudioContext || (window as any).webkitAudioContext)();
    
    // Bandpass filter for that limited frequency radio sound (300Hz - 3400Hz)
    this.filterNode = this.context.createBiquadFilter();
    this.filterNode.type = 'bandpass';
    this.filterNode.frequency.value = 1600; 
    this.filterNode.Q.value = 1.5;

    // Distortion node for gritty radio feel
    const waveShaper = this.context.createWaveShaper();
    waveShaper.curve = this.makeDistortionCurve(20);
    waveShaper.oversample = '4x';

    // Compressor to level the voice
    this.compressorNode = this.context.createDynamicsCompressor();
    this.compressorNode.threshold.setValueAtTime(-24, this.context.currentTime);
    this.compressorNode.knee.setValueAtTime(40, this.context.currentTime);
    this.compressorNode.ratio.setValueAtTime(12, this.context.currentTime);
    this.compressorNode.attack.setValueAtTime(0, this.context.currentTime);
    this.compressorNode.release.setValueAtTime(0.25, this.context.currentTime);

    this.analyzerNode = this.context.createAnalyser();
    this.analyzerNode.fftSize = 256;

    this.outputNode = this.context.createGain();
    this.outputNode.gain.value = 0; // Silent by default

    // Chain: Filter -> WaveShaper -> Compressor -> Analyzer -> Output -> Destination
    this.filterNode.connect(waveShaper);
    waveShaper.connect(this.compressorNode);
    this.compressorNode.connect(this.analyzerNode);
    this.analyzerNode.connect(this.outputNode);
    this.outputNode.connect(this.context.destination);
  }

  private makeDistortionCurve(amount: number) {
    const k = amount;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0 ; i < n_samples; ++i ) {
      const x = i * 2 / n_samples - 1;
      curve[i] = ( 3 + k ) * x * 20 * deg / ( Math.PI + k * Math.abs(x) );
    }
    return curve;
  }

  async startMic() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      this.inputNode = this.context.createMediaStreamSource(this.stream);
      this.inputNode.connect(this.filterNode);
      if (this.context.state === 'suspended') {
        await this.context.resume();
      }
      return true;
    } catch (err) {
      console.error('Failed to get mic access', err);
      return false;
    }
  }

  setMute(mute: boolean) {
    this.outputNode.gain.setTargetAtTime(mute ? 0 : 1, this.context.currentTime, 0.05);
  }

  getAnalyzerData() {
    const dataArray = new Uint8Array(this.analyzerNode.frequencyBinCount);
    this.analyzerNode.getByteFrequencyData(dataArray);
    return dataArray;
  }

  playBeep(frequency: number = 880, duration: number = 0.1) {
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

  close() {
    this.stream?.getTracks().forEach(track => track.stop());
    this.context.close();
  }
}
