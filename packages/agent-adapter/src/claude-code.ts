import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentAdapter, AgentRunRequest } from './index.js';

export interface ClaudeCodeAdapterOptions {
  /** 생략 시 PATH의 `claude` */
  bin?: string;
  /** Claude Code 자체 권한 체계에 위임한다 — SOP: 실행 정책은 에이전트의 것 */
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';
  /** --allowedTools 값. 보고용 curl은 기본으로 허용해야 한다. */
  allowedTools?: string;
  /** 에이전트 작업 디렉토리. 고정 경로여야 폴더 신뢰 수락이 재사용된다. */
  cwd?: string;
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

/** 셸 작은따옴표 인용 */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * 실행 스크립트를 만든다. Terminal에는 이 파일 경로 하나만 넘기므로
 * 프롬프트의 따옴표·줄바꿈이 AppleScript 이스케이프를 거치지 않는다.
 * (예전에는 명령 전체를 문자열로 조립해 넘기다가 프롬프트가 유실됐다.)
 */
export function buildRunnerScript(opts: {
  bin: string;
  cwd: string;
  promptFile: string;
  allowedTools: string;
  permissionMode?: string;
}): string {
  const flags = ['--allowedTools', shq(opts.allowedTools)];
  if (opts.permissionMode) flags.push('--permission-mode', shq(opts.permissionMode));
  return [
    '#!/bin/bash',
    '# samdi가 만든 실행 스크립트. Claude Code에 작업 지시를 넘긴다.',
    `cd ${shq(opts.cwd)} || exit 1`,
    `prompt=$(cat ${shq(opts.promptFile)})`,
    `exec ${shq(opts.bin)} ${flags.join(' ')} "$prompt"`,
    '',
  ].join('\n');
}

/**
 * Claude Code 어댑터 — Terminal 창을 띄워 대화형으로 실행한다 (macOS).
 *
 * 백그라운드로 돌리지 않는 이유는 사용자가 진행 과정을 보고 개입할 수 있어야 하기
 * 때문이다. 완료 판정은 프롬프트에 넣은 보고 규약(curl → 로컬 보고 API)에 의존한다.
 * 창을 그냥 닫으면 보고가 없으므로 lease 만료 → stalled로 흘러간다 (수동 게이트).
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  constructor(private readonly opts: ClaudeCodeAdapterOptions = {}) {}

  async start(request: AgentRunRequest): Promise<void> {
    if (process.platform !== 'darwin') {
      throw new Error('claude-code 어댑터는 현재 macOS(Terminal.app)만 지원한다');
    }
    const bin = this.opts.bin ?? 'claude';
    const cwd = this.opts.cwd ?? defaultWorkspace();
    mkdirSync(cwd, { recursive: true });

    const dir = mkdirSync(path.join(os.tmpdir(), 'samdi'), { recursive: true })
      ? path.join(os.tmpdir(), 'samdi')
      : path.join(os.tmpdir(), 'samdi');
    const promptFile = path.join(dir, `prompt-${request.task.id}.txt`);
    const runnerFile = path.join(dir, `run-${request.task.id}.sh`);

    writeFileSync(
      promptFile,
      `${request.instruction}\n\n${buildReportInstruction(request.reportUrl)}`,
      'utf8',
    );
    writeFileSync(
      runnerFile,
      buildRunnerScript({
        bin,
        cwd,
        promptFile,
        allowedTools: this.opts.allowedTools ?? 'Bash(curl *)',
        permissionMode: this.opts.permissionMode,
      }),
      'utf8',
    );
    chmodSync(runnerFile, 0o700);

    // Terminal에는 스크립트 경로만 넘긴다 — 이스케이프할 게 없다.
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('osascript', [
        '-e',
        `tell application "Terminal" to do script ${JSON.stringify(runnerFile)}`,
        '-e',
        'tell application "Terminal" to activate',
      ]);
      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => (stderr += d));
      proc.on('error', reject);
      proc.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`Terminal 실행 실패 (osascript exit ${code}): ${stderr.trim()}`)),
      );
    });
    // 여기서 끝 — 이후의 성패는 에이전트의 명시 보고(또는 lease 만료)가 결정한다.
  }
}
