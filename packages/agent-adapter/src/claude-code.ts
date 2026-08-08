import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentAdapter, AgentRunRequest } from './index.js';

export interface ClaudeCodeAdapterOptions {
  /** claude 실행 파일. PATH에 없으면 절대 경로를 준다. */
  bin?: string;
  /** Claude Code 자체 권한 체계에 위임한다 — SOP: 실행 정책은 에이전트의 것 */
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';
  /** --allowedTools 값. 보고용 curl은 기본으로 허용해야 한다. */
  allowedTools?: string;
  /** 에이전트 작업 디렉토리. 기본은 임시 워크스페이스. */
  cwd?: string;
  timeoutMs?: number;
}

/**
 * 기본 워크스페이스. 임시 디렉토리가 아니라 홈의 고정 경로를 쓴다 —
 * Claude Code의 폴더 신뢰(trust) 수락이 디렉토리 단위로 저장되므로,
 * 경로가 고정돼야 최초 1회 수락 후부터 프롬프트가 바로 실행된다.
 */
export function defaultWorkspace(): string {
  return path.join(os.homedir(), '.samdi', 'agent-workspace');
}

/** 의뢰 프롬프트에 포함되는 보고 규약 (SOP: 완료 판정은 명시 보고) */
export function buildReportInstruction(reportUrl: string): string {
  return [
    '---',
    '[samdi 보고 규약] 작업을 마치면 반드시 아래 형식으로 보고하라.',
    `성공: curl -s -X POST ${reportUrl} -H 'content-type: application/json' -d '{"type":"completed","summary":"<한 줄 요약>"}'`,
    `실패: curl -s -X POST ${reportUrl} -H 'content-type: application/json' -d '{"type":"failed","reason":"<사유>"}'`,
    `민감한 작업 전 승인 요청: 같은 주소로 '{"type":"ask","question":"<질문>"}'을 보내면 응답으로 {"decision":"approve"|"deny"}가 온다. approve일 때만 진행하라.`,
  ].join('\n');
}

/**
 * Claude Code 레퍼런스 어댑터.
 * headless(-p)로 실행하고, 보고 규약을 프롬프트에 포함한다.
 * 에이전트가 보고를 잊은 채 종료하면 종료 코드 기준으로 대신 보고한다
 * (이미 보고된 Task면 404가 오므로 무시 — 이중 보고 방지).
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  constructor(private readonly opts: ClaudeCodeAdapterOptions = {}) {}

  async start(request: AgentRunRequest): Promise<void> {
    const bin = this.opts.bin ?? 'claude';
    const cwd = this.opts.cwd ?? defaultWorkspace();
    mkdirSync(cwd, { recursive: true });

    const prompt = `${request.instruction}\n\n${buildReportInstruction(request.reportUrl)}`;
    const args = ['-p', prompt, '--output-format', 'json'];
    if (this.opts.permissionMode) args.push('--permission-mode', this.opts.permissionMode);
    args.push('--allowedTools', this.opts.allowedTools ?? 'Bash(curl *)');

    const outcome = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
    }>((resolve, reject) => {
      const proc = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
      }, this.opts.timeoutMs ?? 600_000);
      timer.unref?.();
      proc.stdout.on('data', (d: Buffer) => (stdout += d));
      proc.stderr.on('data', (d: Buffer) => (stderr += d));
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err); // spawn 자체 실패 (claude 없음 등) → Worker가 failed 처리
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      });
    });

    await this.reportFallback(request.reportUrl, outcome);
  }

  private async reportFallback(
    reportUrl: string,
    outcome: { code: number | null; stdout: string; stderr: string; timedOut: boolean },
  ): Promise<void> {
    let body: Record<string, unknown>;
    if (outcome.timedOut) {
      body = { type: 'failed', reason: 'claude code 실행 시간 초과' };
    } else if (outcome.code === 0) {
      let summary = 'claude code 실행 완료 (자체 보고 없음)';
      try {
        const parsed = JSON.parse(outcome.stdout) as { result?: string };
        if (parsed.result) summary = parsed.result.slice(0, 200);
      } catch {
        // JSON이 아니어도 fallback 요약으로 충분하다
      }
      body = { type: 'completed', summary };
    } else {
      body = {
        type: 'failed',
        reason: `claude code exit ${outcome.code}: ${outcome.stderr.slice(0, 200)}`,
      };
    }

    const res = await fetch(reportUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    // 404 = 에이전트가 이미 curl로 보고를 마친 Task — 정상이므로 무시
    if (!res.ok && res.status !== 404) {
      throw new Error(`fallback report failed: ${res.status}`);
    }
  }
}
