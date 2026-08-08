import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildReportInstruction,
  defaultWorkspace,
  type ClaudeCodeAdapterOptions,
} from './claude-code.js';
import type { AgentAdapter, AgentRunRequest } from './index.js';

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Claude Code를 백그라운드가 아니라 **Terminal 창을 띄워서** 실행하는 어댑터 (macOS).
 * 사용자가 에이전트의 프롬프트/진행 과정을 직접 보고, 권한 요청에도 개입할 수 있다.
 *
 * 완료 판정은 headless와 동일하게 보고 규약(curl → 로컬 보고 API)에 의존한다.
 * 창이 그냥 닫히면 보고가 없으므로 lease 만료 → stalled로 흘러간다 (수동 게이트).
 */
export class ClaudeCodeTerminalAdapter implements AgentAdapter {
  constructor(private readonly opts: ClaudeCodeAdapterOptions = {}) {}

  async start(request: AgentRunRequest): Promise<void> {
    if (process.platform !== 'darwin') {
      throw new Error('claude-code-terminal adapter는 현재 macOS(Terminal.app)만 지원한다');
    }
    const bin = this.opts.bin ?? 'claude';
    const cwd = this.opts.cwd ?? defaultWorkspace();
    mkdirSync(cwd, { recursive: true });

    // 프롬프트는 따옴표/개행 이스케이프 지옥을 피하려고 파일로 전달한다
    const promptFile = path.join(os.tmpdir(), `samdi-prompt-${request.task.id}.txt`);
    writeFileSync(
      promptFile,
      `${request.instruction}\n\n${buildReportInstruction(request.reportUrl)}`,
      'utf8',
    );

    // 대화형 세션으로 시작 — 사용자가 창에서 과정을 보고 이어서 개입할 수 있다.
    // 보고용 curl은 기본 허용해 대화형에서도 권한 확인 없이 보고가 나가게 한다.
    const flags: string[] = ['--allowedTools', shq(this.opts.allowedTools ?? 'Bash(curl *)')];
    if (this.opts.permissionMode) {
      flags.push('--permission-mode', this.opts.permissionMode);
    }
    const shellCmd = `cd ${shq(cwd)} && ${shq(bin)} ${flags.join(' ')} "$(cat ${shq(promptFile)})"`;
    const script = `tell application "Terminal" to do script "${shellCmd
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')}"`;

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('osascript', ['-e', script, '-e', 'tell application "Terminal" to activate']);
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Terminal 실행 실패 (osascript exit ${code})`));
      });
    });
    // 여기서 끝 — 이후의 성패는 에이전트의 명시 보고(또는 lease 만료)가 결정한다.
  }
}
