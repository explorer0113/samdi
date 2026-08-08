import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadServerConfig, loadWorkerConfig } from './load.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'samdi-config-test-'));
});

/** 탐색 대상이 되도록 임시 cwd에 설정 파일을 쓴다 */
function writeConfig(name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, body, 'utf8');
  return file;
}

describe('loadServerConfig', () => {
  it('설정 파일이 없으면 기본값으로 동작한다', () => {
    const { config, source } = loadServerConfig({ cwd: dir, env: {} });
    expect(source).toBeNull();
    expect(config.port).toBe(3000);
    expect(config.dbPath).toBe('samdi.sqlite');
    expect(config.workerKey).toBe('demo-worker-key');
    expect(config.channels).toEqual([{ id: 'demo', label: 'demo', key: 'demo-channel-key' }]);
  });

  it('samdi.server.yaml을 cwd에서 찾아 읽는다', () => {
    const file = writeConfig(
      'samdi.server.yaml',
      `port: 4000
workerKey: from-file
channels:
  - id: mail
    label: inbox
    key: mail-key
`,
    );
    const { config, source } = loadServerConfig({ cwd: dir, env: {} });
    expect(source).toBe(file);
    expect(config.port).toBe(4000);
    expect(config.workerKey).toBe('from-file');
    expect(config.channels).toEqual([{ id: 'mail', label: 'inbox', key: 'mail-key' }]);
  });

  it('환경변수가 설정 파일을 덮는다', () => {
    writeConfig('samdi.server.yaml', 'port: 4000\nworkerKey: from-file\n');
    const { config } = loadServerConfig({
      cwd: dir,
      env: { PORT: '5001', SAMDI_WORKER_KEY: 'from-env' },
    });
    expect(config.port).toBe(5001);
    expect(config.workerKey).toBe('from-env');
  });

  it('SAMDI_CHANNEL_KEY는 데모 채널의 키만 덮는다', () => {
    writeConfig(
      'samdi.server.yaml',
      `channels:
  - id: demo
    key: old
  - id: mail
    key: keep-me
`,
    );
    const { config } = loadServerConfig({ cwd: dir, env: { SAMDI_CHANNEL_KEY: 'new' } });
    expect(config.channels).toEqual([
      { id: 'demo', key: 'new' },
      { id: 'mail', key: 'keep-me' },
    ]);
  });

  it('빈 파일은 기본값으로 처리한다', () => {
    writeConfig('samdi.server.yaml', '\n');
    expect(loadServerConfig({ cwd: dir, env: {} }).config.port).toBe(3000);
  });

  it('~ 경로를 홈으로 펼친다', () => {
    writeConfig('samdi.server.yaml', 'dbPath: ~/samdi/state.sqlite\n');
    const { config } = loadServerConfig({ cwd: dir, env: {} });
    expect(config.dbPath).toBe(path.join(os.homedir(), 'samdi/state.sqlite'));
  });
});

describe('loadWorkerConfig', () => {
  it('기본값: mock 에이전트, demo 라벨', () => {
    const { config } = loadWorkerConfig({ cwd: dir, env: {} });
    expect(config.defaultAgent).toBe('mock');
    expect(config.worker.labels).toEqual(['demo']);
    expect(config.worker.reportPort).toBe(4700);
    expect(config.agents['claude-code'].allowedTools).toBe('Bash(curl *)');
    expect(config.agents['claude-code'].timeoutMs).toBe(600_000);
  });

  it('중첩 키를 파일에서 읽고, 지정하지 않은 형제 키는 기본값을 유지한다', () => {
    writeConfig(
      'samdi.worker.yaml',
      `controlPlane:
  url: http://10.0.0.5:3000
worker:
  labels: [mail, ops]
defaultAgent: claude-code
agents:
  claude-code:
    permissionMode: acceptEdits
`,
    );
    const { config } = loadWorkerConfig({ cwd: dir, env: {} });
    expect(config.controlPlane.url).toBe('http://10.0.0.5:3000');
    expect(config.controlPlane.workerKey).toBe('demo-worker-key'); // 기본값 유지
    expect(config.worker.labels).toEqual(['mail', 'ops']);
    expect(config.worker.pollIntervalMs).toBe(2000); // 기본값 유지
    expect(config.defaultAgent).toBe('claude-code');
    expect(config.agents['claude-code'].permissionMode).toBe('acceptEdits');
    expect(config.agents['claude-code'].allowedTools).toBe('Bash(curl *)'); // 기본값 유지
  });

  it('SAMDI_LABELS는 콤마 구분 문자열을 배열로 바꾼다', () => {
    const { config } = loadWorkerConfig({ cwd: dir, env: { SAMDI_LABELS: 'mail, ops ,dev' } });
    expect(config.worker.labels).toEqual(['mail', 'ops', 'dev']);
  });

  it('SAMDI_CLAUDE_* 는 두 claude 어댑터에 함께 적용된다', () => {
    const { config } = loadWorkerConfig({
      cwd: dir,
      env: { SAMDI_CLAUDE_BIN: '/opt/claude', SAMDI_CLAUDE_ALLOWED_TOOLS: 'Bash,Read' },
    });
    for (const key of ['claude-code', 'claude-code-terminal'] as const) {
      expect(config.agents[key].bin).toBe('/opt/claude');
      expect(config.agents[key].allowedTools).toBe('Bash,Read');
    }
  });

  it('env가 파일의 에이전트 설정을 덮는다', () => {
    writeConfig('samdi.worker.yaml', 'agents:\n  claude-code:\n    bin: /from/file\n');
    const { config } = loadWorkerConfig({ cwd: dir, env: { SAMDI_CLAUDE_BIN: '/from/env' } });
    expect(config.agents['claude-code'].bin).toBe('/from/env');
  });
});

describe('설정 오류', () => {
  it('모르는 defaultAgent는 키 이름과 함께 거부된다', () => {
    writeConfig('samdi.worker.yaml', 'defaultAgent: gpt\n');
    expect(() => loadWorkerConfig({ cwd: dir, env: {} })).toThrowError(/defaultAgent/);
  });

  it('숫자 자리에 문자열이 오면 거부된다', () => {
    expect(() => loadServerConfig({ cwd: dir, env: { PORT: 'abc' } })).toThrowError(ConfigError);
  });

  it('YAML 문법 오류는 파일 경로와 함께 알려준다', () => {
    writeConfig('samdi.worker.yaml', 'worker:\n  labels: [unclosed\n');
    expect(() => loadWorkerConfig({ cwd: dir, env: {} })).toThrowError(/YAML 문법 오류/);
  });

  it('최상위가 매핑이 아니면 거부된다', () => {
    writeConfig('samdi.server.yaml', '- just\n- a list\n');
    expect(() => loadServerConfig({ cwd: dir, env: {} })).toThrowError(/최상위는 매핑/);
  });

  it('명시한 설정 파일이 없으면 조용히 기본값으로 가지 않는다', () => {
    expect(() =>
      loadWorkerConfig({ cwd: dir, env: { SAMDI_WORKER_CONFIG: path.join(dir, 'nope.yaml') } }),
    ).toThrowError(/설정 파일이 없다/);
  });

  it('채널에 키가 없으면 거부된다', () => {
    writeConfig('samdi.server.yaml', 'channels:\n  - id: mail\n');
    expect(() => loadServerConfig({ cwd: dir, env: {} })).toThrowError(/channels\.0\.key/);
  });
});
