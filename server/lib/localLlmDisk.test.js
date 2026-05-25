import { describe, it, expect } from 'vitest';
import {
  parseOllamaManifest, digestToBlobFilename, parseOllamaModelRef, ollamaManifestRelPath,
  sanitizeOllamaName, dirIsMlx, selectPrimaryGguf, selectProjectorGguf, isShardedGguf,
  lmStudioPublisherRepo, buildModelfile,
  OLLAMA_MODEL_MEDIATYPE, OLLAMA_PROJECTOR_MEDIATYPE
} from './localLlmDisk.js';

describe('localLlmDisk', () => {
  describe('parseOllamaManifest', () => {
    it('extracts the model + projector digests by media type', () => {
      const manifest = {
        layers: [
          { mediaType: 'application/vnd.ollama.image.template', digest: 'sha256:tpl' },
          { mediaType: OLLAMA_MODEL_MEDIATYPE, digest: 'sha256:weights' },
          { mediaType: OLLAMA_PROJECTOR_MEDIATYPE, digest: 'sha256:proj' }
        ]
      };
      expect(parseOllamaManifest(manifest)).toEqual({ modelDigest: 'sha256:weights', projectorDigest: 'sha256:proj' });
    });
    it('returns nulls for a text-only model and a malformed manifest', () => {
      expect(parseOllamaManifest({ layers: [{ mediaType: OLLAMA_MODEL_MEDIATYPE, digest: 'sha256:w' }] }))
        .toEqual({ modelDigest: 'sha256:w', projectorDigest: null });
      expect(parseOllamaManifest(null)).toEqual({ modelDigest: null, projectorDigest: null });
      expect(parseOllamaManifest({})).toEqual({ modelDigest: null, projectorDigest: null });
    });
  });

  describe('digestToBlobFilename', () => {
    it('rewrites the sha256 separator', () => {
      expect(digestToBlobFilename('sha256:abc123')).toBe('sha256-abc123');
      expect(digestToBlobFilename(null)).toBe('');
    });
  });

  describe('parseOllamaModelRef', () => {
    it('defaults a bare name to library/<name>:latest', () => {
      expect(parseOllamaModelRef('llama3.2')).toEqual({ registry: 'registry.ollama.ai', namespace: 'library', name: 'llama3.2', tag: 'latest' });
    });
    it('keeps a meaningful tag like 20b', () => {
      expect(parseOllamaModelRef('gpt-oss:20b')).toEqual({ registry: 'registry.ollama.ai', namespace: 'library', name: 'gpt-oss', tag: '20b' });
    });
    it('handles namespace/name:tag', () => {
      expect(parseOllamaModelRef('myorg/mymodel:v2')).toEqual({ registry: 'registry.ollama.ai', namespace: 'myorg', name: 'mymodel', tag: 'v2' });
    });
    it('does not mistake a registry host:port for a tag', () => {
      expect(parseOllamaModelRef('localhost:5000/team/m')).toEqual({ registry: 'localhost:5000', namespace: 'team', name: 'm', tag: 'latest' });
    });
  });

  describe('ollamaManifestRelPath', () => {
    it('joins the manifest path the way Ollama lays it out', () => {
      expect(ollamaManifestRelPath(parseOllamaModelRef('llama3.2:latest')))
        .toBe('manifests/registry.ollama.ai/library/llama3.2/latest');
    });
  });

  describe('sanitizeOllamaName', () => {
    it('lowercases and strips path + bad chars', () => {
      expect(sanitizeOllamaName('lmstudio-community/Llama-3.2-3B-Instruct-GGUF')).toBe('llama-3.2-3b-instruct-gguf');
      expect(sanitizeOllamaName('My Model!!')).toBe('my-model');
      expect(sanitizeOllamaName('')).toBe('imported-model');
    });
  });

  describe('dirIsMlx', () => {
    it('flags safetensors-only dirs and clears GGUF dirs', () => {
      expect(dirIsMlx(['model.safetensors', 'config.json', 'tokenizer.json'])).toBe(true);
      expect(dirIsMlx(['gpt-oss-20b-MXFP4.gguf'])).toBe(false);
      expect(dirIsMlx(['model.safetensors', 'extra.gguf'])).toBe(false); // has a gguf → usable
      expect(dirIsMlx([])).toBe(false);
    });
  });

  describe('selectPrimaryGguf / selectProjectorGguf', () => {
    it('picks the weights gguf and skips the projector', () => {
      const files = ['llava-v1.5-7b-mmproj-f16.gguf', 'llava-v1.5-7b-Q4_K_M.gguf', 'README.md'];
      expect(selectPrimaryGguf(files)).toBe('llava-v1.5-7b-Q4_K_M.gguf');
      expect(selectProjectorGguf(files)).toBe('llava-v1.5-7b-mmproj-f16.gguf');
    });
    it('prefers the first shard of a sharded model', () => {
      const files = ['model-00002-of-00003.gguf', 'model-00001-of-00003.gguf', 'model-00003-of-00003.gguf'];
      expect(selectPrimaryGguf(files)).toBe('model-00001-of-00003.gguf');
      expect(isShardedGguf(selectPrimaryGguf(files))).toBe(true);
    });
    it('returns null when there is no weights gguf', () => {
      expect(selectPrimaryGguf(['only-mmproj.gguf', 'notes.txt'])).toBe(null);
      expect(selectProjectorGguf(['weights.gguf'])).toBe(null);
    });
    it('single plain gguf is not flagged sharded', () => {
      expect(isShardedGguf('mistral-7b-instruct-Q4_K_M.gguf')).toBe(false);
    });
  });

  describe('lmStudioPublisherRepo', () => {
    it('splits publisher/repo and falls back for bare ids', () => {
      expect(lmStudioPublisherRepo('lmstudio-community/Llama-3.2-3B-Instruct-GGUF'))
        .toEqual({ publisher: 'lmstudio-community', repo: 'Llama-3.2-3B-Instruct-GGUF' });
      expect(lmStudioPublisherRepo('justaname')).toEqual({ publisher: 'imported', repo: 'justaname' });
    });
    it('sanitizes path-unsafe chars (e.g. Ollama tag colons) into filesystem-safe segments', () => {
      // a migration-generated id like `imported/llama3.2:latest` must not put `:` in a dir name
      expect(lmStudioPublisherRepo('imported/llama3.2:latest')).toEqual({ publisher: 'imported', repo: 'llama3.2-latest' });
      expect(lmStudioPublisherRepo('gpt-oss:20b')).toEqual({ publisher: 'imported', repo: 'gpt-oss-20b' });
    });
  });

  describe('buildModelfile', () => {
    it('emits a FROM line for a local gguf path', () => {
      expect(buildModelfile('/abs/path/model.gguf')).toBe('FROM /abs/path/model.gguf\n');
    });
  });
});
