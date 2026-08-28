// @vitest-environment node
/**
 * Only the pure resolution helpers are unit-tested; spawn/afplay is a side
 * effect exercised by hand. What a reader cannot see: the env override must beat
 * the standard install paths, and a missing model must degrade (null) rather
 * than throw, so the renderer can fall back to speechSynthesis.
 */
import { describe, expect, it } from 'vitest';
import {
  buildPiperArgs,
  isPiperAvailable,
  piperModelCandidates,
  resolvePiperBin,
  resolvePiperModel,
} from '../PiperSpeechService';

describe('resolvePiperBin', () => {
  it('defaults to the PATH binary', () => {
    expect(resolvePiperBin({})).toBe('piper');
  });

  it('honours the env override', () => {
    expect(resolvePiperBin({ NIMBALYST_PIPER_BIN: '/opt/piper' })).toBe('/opt/piper');
  });
});

describe('piperModelCandidates', () => {
  it('puts the env override first, then the standard locations', () => {
    const list = piperModelCandidates({ NIMBALYST_PIPER_MODEL: '/models/x.onnx' }, '/home/u');
    expect(list[0]).toBe('/models/x.onnx');
    expect(list).toContain('/home/u/.local/share/piper/en_US-amy-medium.onnx');
  });

  it('probes the standard locations when unset', () => {
    const list = piperModelCandidates({}, '/home/u');
    expect(list[0]).toBe('/home/u/.local/share/piper/en_US-amy-medium.onnx');
  });
});

describe('resolvePiperModel', () => {
  it('returns the first candidate that exists', () => {
    const exists = (p: string): boolean => p === '/home/u/piper/en_US-amy-medium.onnx';
    expect(resolvePiperModel({}, exists, '/home/u')).toBe('/home/u/piper/en_US-amy-medium.onnx');
  });

  it('returns null when no model is on disk', () => {
    expect(resolvePiperModel({}, () => false, '/home/u')).toBeNull();
  });
});

describe('buildPiperArgs', () => {
  it('names the model and the wav output', () => {
    expect(buildPiperArgs('/m.onnx', '/tmp/o.wav')).toEqual([
      '--model',
      '/m.onnx',
      '--output_file',
      '/tmp/o.wav',
    ]);
  });
});

describe('isPiperAvailable', () => {
  it('is true when a model resolves', () => {
    expect(isPiperAvailable({ NIMBALYST_PIPER_MODEL: '/m.onnx' }, (p) => p === '/m.onnx')).toBe(true);
  });

  it('is false when no model is found', () => {
    expect(isPiperAvailable({}, () => false)).toBe(false);
  });
});
