import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { WorkerState } from './worker-state.js';

let file: string;

beforeEach(() => {
  file = path.join(mkdtempSync(path.join(os.tmpdir(), 'samdi-state-')), 'state.json');
});

const state = (labels = ['demo'], concurrency = 1) =>
  new WorkerState({ labels, concurrency }, file);

describe('기본값', () => {
  it('덮어쓴 게 없으면 설정값을 쓴다', () => {
    const s = state(['demo', 'mail'], 3);
    expect(s.labels).toEqual(['demo', 'mail']);
    expect(s.concurrency).toBe(3);
    expect(s.overridden).toEqual({ labels: false, concurrency: false });
  });
});

describe('라벨', () => {
  it('바꾸면 그 값을 쓰고 설정값은 되돌릴 목적지로 남는다', () => {
    const s = state(['demo']);
    expect(s.setLabels(['demo', 'sample'])).toEqual(['demo', 'sample']);
    expect(s.overridden.labels).toBe(true);
    expect(s.configured.labels).toEqual(['demo']);
  });

  it('공백을 다듬고 중복을 없앤다', () => {
    expect(state().setLabels([' demo ', 'mail', 'demo', ''])).toEqual(['demo', 'mail']);
  });

  it('빈 라벨은 거부한다 — 아무 Task도 못 가져오게 되므로', () => {
    expect(() => state().setLabels([])).toThrow();
    expect(() => state().setLabels(['  '])).toThrow();
  });

  it('설정값과 같아지면 덮어쓴 것으로 치지 않는다', () => {
    const s = state(['demo', 'mail']);
    s.setLabels(['mail', 'demo']); // 순서만 다르다
    expect(s.overridden.labels).toBe(false);
  });
});

describe('동시 처리 수', () => {
  it('바꾸면 그 값을 쓴다', () => {
    const s = state(['demo'], 1);
    expect(s.setConcurrency(4)).toBe(4);
    expect(s.overridden.concurrency).toBe(true);
  });

  it('범위 밖이면 거부한다', () => {
    for (const bad of [0, -1, 33, 1.5, Number.NaN]) {
      expect(() => state().setConcurrency(bad), String(bad)).toThrow();
    }
  });

  it('설정값과 같아지면 덮어쓴 것으로 치지 않는다', () => {
    const s = state(['demo'], 2);
    s.setConcurrency(5);
    s.setConcurrency(2);
    expect(s.overridden.concurrency).toBe(false);
  });
});

describe('재시작을 견딘다', () => {
  it('둘 다 다음 실행에서도 유지된다', () => {
    const s = state(['demo'], 1);
    s.setLabels(['demo', 'ops']);
    s.setConcurrency(3);

    const after = state(['demo'], 1);
    expect(after.labels).toEqual(['demo', 'ops']);
    expect(after.concurrency).toBe(3);
  });

  it('하나만 바꿔도 나머지는 설정값을 따라간다', () => {
    state(['demo'], 1).setConcurrency(3);
    // 설정 파일의 라벨이 바뀌면 그 새 값을 써야 한다
    const after = state(['demo', 'new'], 1);
    expect(after.labels).toEqual(['demo', 'new']);
    expect(after.concurrency).toBe(3);
  });

  it('되돌리면 흔적을 남기지 않는다', () => {
    const s = state(['demo'], 1);
    s.setLabels(['other']);
    s.setConcurrency(5);
    s.reset();

    expect(existsSync(file)).toBe(false);
    expect(s.labels).toEqual(['demo']);
    expect(s.concurrency).toBe(1);
  });

  it('저장 파일이 깨져 있어도 설정값으로 뜬다 — 파일 하나 때문에 못 뜨면 안 된다', () => {
    writeFileSync(file, '{ 이건 JSON이 아니다', 'utf8');
    const s = state(['demo'], 2);
    expect(s.labels).toEqual(['demo']);
    expect(s.concurrency).toBe(2);
  });

  it('말이 안 되는 값이 저장돼 있으면 무시한다', () => {
    writeFileSync(file, JSON.stringify({ labels: [], concurrency: 999 }), 'utf8');
    const s = state(['demo'], 2);
    expect(s.labels).toEqual(['demo']);
    expect(s.concurrency).toBe(2);
  });
});
