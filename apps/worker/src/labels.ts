import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 이 Worker가 claim할 라벨.
 *
 * 설정 파일이 기준값이고, 화면에서 바꾼 값이 그 위에 얹힌다. 별도 파일에 저장하는
 * 이유는 사용자의 YAML을 프로그램이 고쳐 쓰지 않기 위해서다 — 손으로 적은 설정과
 * 화면에서 만진 값이 같은 파일에서 뒤섞이면 무엇이 진실인지 알 수 없게 된다.
 *
 * 대신 화면은 둘을 함께 보여주고, 언제든 설정값으로 되돌릴 수 있게 한다.
 *
 * 라벨을 화면에서 바꿀 수 있어야 하는 이유는, 채널이 운영 중에 생기기 때문이다.
 * 새 채널의 라벨을 이 Worker가 받으려면 지금까지는 재시작해야 했다.
 */
export class LabelStore {
  private current: string[];

  constructor(
    /** samdi.worker.yaml에서 온 값. "되돌리기"의 목적지다. */
    readonly configured: string[],
    private readonly file: string = defaultOverrideFile(),
  ) {
    this.current = readOverride(this.file) ?? [...configured];
  }

  get(): string[] {
    return [...this.current];
  }

  /** 설정값과 다른 값을 쓰고 있는가 — 화면이 "되돌리기"를 보여줄지 정한다. */
  get overridden(): boolean {
    return !sameSet(this.current, this.configured);
  }

  /**
   * 라벨을 바꾼다. 다음 claim부터 적용된다 —
   * 폴링 루프가 매번 이 값을 읽어 가므로 재시작이 필요 없다.
   */
  set(labels: string[]): string[] {
    const cleaned = [...new Set(labels.map((l) => l.trim()).filter(Boolean))];
    if (cleaned.length === 0) throw new Error('라벨이 비어 있으면 아무 Task도 가져올 수 없다');
    this.current = cleaned;
    if (sameSet(cleaned, this.configured)) clearOverride(this.file);
    else writeOverride(this.file, cleaned);
    return this.get();
  }

  /** 설정 파일 값으로 되돌린다. */
  reset(): string[] {
    this.current = [...this.configured];
    clearOverride(this.file);
    return this.get();
  }
}

function defaultOverrideFile(): string {
  return path.join(os.homedir(), '.samdi', 'worker-labels.json');
}

function readOverride(file: string): string[] | null {
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return null;
    const labels = parsed.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
    return labels.length > 0 ? labels : null;
  } catch {
    // 손상된 파일 때문에 Worker가 못 뜨면 안 된다. 설정값으로 돈다.
    return null;
  }
}

function writeOverride(file: string, labels: string[]): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(labels, null, 2)}\n`, 'utf8');
}

function clearOverride(file: string): void {
  // 설정값과 같아졌으면 파일을 남기지 않는다 — 없는 게 "덮어쓴 게 없다"의 정확한 표현이다.
  if (existsSync(file)) rmSync(file, { force: true });
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((v) => set.has(v));
}
