import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition, isTerminal } from './state-machine.js';

describe('task state machine', () => {
  it('허용: 정상 완료 경로', () => {
    expect(canTransition('pending', 'claimed')).toBe(true);
    expect(canTransition('claimed', 'running')).toBe(true);
    expect(canTransition('running', 'completed')).toBe(true);
  });

  it('허용: 승인 대기 왕복', () => {
    expect(canTransition('running', 'waiting')).toBe(true);
    expect(canTransition('waiting', 'running')).toBe(true);
    expect(canTransition('waiting', 'failed')).toBe(true);
  });

  it('허용: 기각은 claimed에서만, 두 종류로 구분', () => {
    expect(canTransition('claimed', 'triaged_out')).toBe(true);
    expect(canTransition('claimed', 'rejected')).toBe(true);
    expect(canTransition('running', 'rejected')).toBe(false);
    expect(canTransition('pending', 'triaged_out')).toBe(false);
  });

  it('허용: lease 만료 → stalled, 이후엔 사용자 결정만', () => {
    expect(canTransition('claimed', 'stalled')).toBe(true);
    expect(canTransition('running', 'stalled')).toBe(true);
    expect(canTransition('waiting', 'stalled')).toBe(true);
    expect(canTransition('stalled', 'pending')).toBe(true);
    expect(canTransition('stalled', 'failed')).toBe(true);
  });

  it('금지: stalled에서 자동 재실행 경로는 없다', () => {
    expect(canTransition('stalled', 'claimed')).toBe(false);
    expect(canTransition('stalled', 'running')).toBe(false);
  });

  it('금지: 종결 상태에서는 어디로도 못 간다', () => {
    for (const from of ['completed', 'failed', 'rejected', 'triaged_out'] as const) {
      expect(isTerminal(from)).toBe(true);
      for (const to of ['pending', 'claimed', 'running', 'completed'] as const) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it('assertTransition은 불법 전이에 InvalidTransitionError를 던진다', () => {
    expect(() => assertTransition('pending', 'running')).toThrowError(
      'invalid task transition: pending -> running',
    );
    expect(() => assertTransition('pending', 'claimed')).not.toThrow();
  });
});
