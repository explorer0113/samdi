import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReportInstruction, buildRunnerScript } from './claude-code.js';

/**
 * 실행 스크립트를 실제로 돌려서, 프롬프트가 인자로 온전히 전달되는지 확인한다.
 * claude 자리에 인자를 파일로 받아적는 스크립트를 꽂는다.
 */
function runWithFakeClaude(prompt: string, allowedTools = 'Bash(curl *)') {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'samdi-adapter-test-'));
  const argsFile = path.join(dir, 'args.json');
  // claude 자리에 인자를 그대로 JSON으로 적는 스크립트를 꽂는다 (셸 이스케이프 개입 없음)
  const fakeBin = path.join(dir, 'fake-claude.mjs');
  writeFileSync(
    fakeBin,
    `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\n` +
      `writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\n`,
    'utf8',
  );
  chmodSync(fakeBin, 0o700);

  const promptFile = path.join(dir, 'prompt.txt');
  writeFileSync(promptFile, prompt, 'utf8');

  const runner = path.join(dir, 'run.sh');
  writeFileSync(
    runner,
    buildRunnerScript({ bin: fakeBin, cwd: dir, promptFile, allowedTools }),
    'utf8',
  );
  chmodSync(runner, 0o700);
  execFileSync(runner);

  return JSON.parse(readFileSync(argsFile, 'utf8')) as string[];
}

describe('실행 스크립트', () => {
  it('프롬프트를 인자 하나로 온전히 넘긴다 (줄바꿈 포함)', () => {
    const prompt = `이메일 쓰는것좀 도와줘\n\n${buildReportInstruction('http://127.0.0.1:4700/report/t1')}`;
    const args = runWithFakeClaude(prompt);

    expect(args.at(-1)).toBe(prompt);
    expect(args.at(-1)).toContain('samdi 보고 규약');
    expect(args.at(-1)).toContain('http://127.0.0.1:4700/report/t1');
  });

  it('따옴표·$·백틱이 든 프롬프트도 그대로 간다', () => {
    const prompt = `"큰따옴표" '작은따옴표' $HOME \`whoami\` $(id) \\백슬래시`;
    expect(runWithFakeClaude(prompt).at(-1)).toBe(prompt);
  });

  it('allowedTools를 인자로 넘긴다', () => {
    const args = runWithFakeClaude('작업', 'Bash(curl *),Read');
    expect(args).toContain('--allowedTools');
    expect(args).toContain('Bash(curl *),Read');
  });

  it('프롬프트 앞에 `--`를 둔다 — 가변 인자 옵션이 프롬프트를 삼키지 않게', () => {
    // --allowedTools는 가변 인자라 `--` 없이는 프롬프트까지 도구 이름으로 먹는다.
    // 그러면 Claude Code가 프롬프트 없이 빈 세션으로 열린다.
    const args = runWithFakeClaude('go로 헬로월드 짜줘');
    const sep = args.indexOf('--');
    expect(sep).toBeGreaterThan(-1);
    expect(args.slice(sep + 1)).toEqual(['go로 헬로월드 짜줘']);
    // 도구 목록에 프롬프트가 섞여 있지 않아야 한다
    expect(args.slice(0, sep)).not.toContain('go로 헬로월드 짜줘');
  });

  it('permissionMode는 준 경우에만 붙는다', () => {
    const script = buildRunnerScript({
      bin: 'claude',
      cwd: '/tmp',
      promptFile: '/tmp/p.txt',
      allowedTools: 'Bash(curl *)',
    });
    expect(script).not.toContain('--permission-mode');

    const withMode = buildRunnerScript({
      bin: 'claude',
      cwd: '/tmp',
      promptFile: '/tmp/p.txt',
      allowedTools: 'Bash(curl *)',
      permissionMode: 'acceptEdits',
    });
    expect(withMode).toContain("--permission-mode 'acceptEdits'");
  });
});
