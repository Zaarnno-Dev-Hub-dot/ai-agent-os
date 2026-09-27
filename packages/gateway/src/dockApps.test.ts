import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isLoopbackUrl, loadDockApps } from './dockApps.js';

function withDataDir(fn: (dataDir: string) => void) {
  const dataDir = mkdtempSync(join(tmpdir(), 'dock-apps-test-'));
  try {
    fn(dataDir);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe('isLoopbackUrl', () => {
  it('accepts 127.0.0.1, localhost, and ::1', () => {
    expect(isLoopbackUrl('http://127.0.0.1:3100')).toBe(true);
    expect(isLoopbackUrl('http://localhost:3100')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:3100')).toBe(true);
  });

  it('rejects a non-loopback host', () => {
    expect(isLoopbackUrl('http://example.com:3100')).toBe(false);
    expect(isLoopbackUrl('http://192.168.1.5:3100')).toBe(false);
  });

  it('rejects an unparseable URL', () => {
    expect(isLoopbackUrl('not-a-url')).toBe(false);
    expect(isLoopbackUrl('')).toBe(false);
  });
});

describe('loadDockApps', () => {
  it('returns an empty array when the registry file does not exist', () => {
    withDataDir((dataDir) => {
      expect(loadDockApps(dataDir)).toEqual([]);
    });
  });

  it('loads a valid mix of route and iframe entries', () => {
    withDataDir((dataDir) => {
      writeFileSync(
        join(dataDir, 'dock-apps.json'),
        JSON.stringify([
          { id: 'memory-galaxy', label: 'Memory', icon: 'sparkle', kind: 'route' },
          { id: 'paperclip', label: 'Paperclip', icon: 'clip', kind: 'iframe', url: 'http://127.0.0.1:3100' },
        ])
      );
      const apps = loadDockApps(dataDir);
      expect(apps).toHaveLength(2);
      expect(apps[0].id).toBe('memory-galaxy');
      expect(apps[1]).toMatchObject({ id: 'paperclip', kind: 'iframe', url: 'http://127.0.0.1:3100' });
    });
  });

  it('drops an iframe entry with a non-loopback url, keeping valid siblings', () => {
    withDataDir((dataDir) => {
      writeFileSync(
        join(dataDir, 'dock-apps.json'),
        JSON.stringify([
          { id: 'evil', label: 'Evil', icon: 'x', kind: 'iframe', url: 'http://evil.example.com' },
          { id: 'memory-galaxy', label: 'Memory', icon: 'sparkle', kind: 'route' },
        ])
      );
      const apps = loadDockApps(dataDir);
      expect(apps.map((a) => a.id)).toEqual(['memory-galaxy']);
    });
  });

  it('drops an iframe entry with a missing url', () => {
    withDataDir((dataDir) => {
      writeFileSync(
        join(dataDir, 'dock-apps.json'),
        JSON.stringify([{ id: 'broken', label: 'Broken', icon: 'x', kind: 'iframe' }])
      );
      expect(loadDockApps(dataDir)).toEqual([]);
    });
  });

  it('drops entries missing required fields (id/label/icon) or an invalid kind', () => {
    withDataDir((dataDir) => {
      writeFileSync(
        join(dataDir, 'dock-apps.json'),
        JSON.stringify([
          { label: 'No id', icon: 'x', kind: 'route' },
          { id: 'no-label', icon: 'x', kind: 'route' },
          { id: 'no-icon', label: 'No icon', kind: 'route' },
          { id: 'bad-kind', label: 'Bad kind', icon: 'x', kind: 'popup' },
          { id: 'ok', label: 'OK', icon: 'x', kind: 'route' },
        ])
      );
      expect(loadDockApps(dataDir).map((a) => a.id)).toEqual(['ok']);
    });
  });

  it('tolerates a malformed (non-JSON) file, returning an empty registry', () => {
    withDataDir((dataDir) => {
      writeFileSync(join(dataDir, 'dock-apps.json'), 'not json {{{');
      expect(loadDockApps(dataDir)).toEqual([]);
    });
  });

  it('tolerates a JSON file that is not an array', () => {
    withDataDir((dataDir) => {
      writeFileSync(join(dataDir, 'dock-apps.json'), JSON.stringify({ not: 'an array' }));
      expect(loadDockApps(dataDir)).toEqual([]);
    });
  });

  it('respects an explicit enabled:false without dropping the entry', () => {
    withDataDir((dataDir) => {
      writeFileSync(
        join(dataDir, 'dock-apps.json'),
        JSON.stringify([{ id: 'lumina', label: 'Lumina', icon: 'chat', kind: 'iframe', url: 'http://127.0.0.1:9', enabled: false }])
      );
      const apps = loadDockApps(dataDir);
      expect(apps).toHaveLength(1);
      expect(apps[0].enabled).toBe(false);
    });
  });
});
