import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { LabelStore } from './labels.js';

let file: string;

beforeEach(() => {
  file = path.join(mkdtempSync(path.join(os.tmpdir(), 'samdi-labels-')), 'labels.json');
});

const store = (configured: string[] = ['demo']) => new LabelStore(configured, file);

describe('기본 동작', () => {
  it('덮어쓴 게 없으면 설정값을 쓴다', () => {
    const s = store(['demo', 'mail']);
    expect(s.get()).toEqual(['demo', 'mail']);
    expect(s.overridden).toBe(false);
  });

  it('바꾸면 그 값을 쓰고, 설정값과 다르다고 표시한다', () => {
    const s = store(['demo']);
    expect(s.set(['demo', 'sample'])).toEqual(['demo', 'sample']);
    expect(s.overridden).toBe(true);
    // 설정값은 되돌릴 목적지로 남아 있어야 한다
    expect(s.configured).toEqual(['demo']);
  });

  it('되돌리면 설정값으로 간다', () => {
    const s = store(['demo']);
    s.set(['other']);
    expect(s.reset()).toEqual(['demo']);
    expect(s.overridden).toBe(false);
  });

  it('공백을 다듬고 중복을 없앤다', () => {
    expect(store().set([' demo ', 'mail', 'demo', ''])).toEqual(['demo', 'mail']);
  });

  it('빈 라벨은 거부한다 — 아무 Task도 못 가져오게 되므로', () => {
    expect(() => store().set([])).toThrow();
    expect(() => store().set(['  ', ''])).toThrow();
  });
});

describe('재시작을 견딘다', () => {
  it('바꾼 값이 다음 실행에서도 유지된다', () => {
    store(['demo']).set(['demo', 'sample']);
    expect(store(['demo']).get()).toEqual(['demo', 'sample']);
  });

  it('되돌린 뒤에는 설정 파일 값을 따른다 — 덮어쓴 흔적을 남기지 않는다', () => {
    store(['demo']).set(['other']);
    store(['demo']).reset();

    expect(existsSync(file)).toBe(false);
    // 설정이 바뀌면 그 새 값을 따라가야 한다
    expect(store(['demo', 'new']).get()).toEqual(['demo', 'new']);
  });

  it('설정값과 같은 값으로 바꾸면 덮어쓴 것으로 치지 않는다', () => {
    const s = store(['demo', 'mail']);
    s.set(['mail', 'demo']); // 순서만 다르다
    expect(s.overridden).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it('저장 파일이 깨져 있어도 설정값으로 뜬다 — 파일 하나 때문에 못 뜨면 안 된다', () => {
    writeFileSync(file, '{ 이건 JSON이 아니다', 'utf8');
    expect(store(['demo']).get()).toEqual(['demo']);
  });
});
