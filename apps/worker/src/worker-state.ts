import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 사용자가 화면에서 바꾼 Worker 운영값.
 *
 * 설정 파일이 기준값이고, 화면에서 바꾼 값이 그 위에 얹힌다. 별도 파일에 저장하는
 * 이유는 사용자의 YAML을 프로그램이 고쳐 쓰지 않기 위해서다 — 손으로 적은 설정과
 * 화면에서 만진 값이 같은 파일에서 뒤섞이면 무엇이 진실인지 알 수 없게 된다.
 * 대신 화면이 둘을 함께 보여주고 언제든 되돌릴 수 있게 한다.
 *
 * 여기 있는 것들은 전부 **이 기기의 결정**이다. 무슨 일을 받을지(labels), 한 번에
 * 몇 건까지 감당할지(concurrency)는 자격 증명과 도구를 가진 쪽이 정한다.
 */
export interface WorkerDefaults {
  labels: string[];
  concurrency: number;
  defaultAgent: string;
}

interface Overrides {
  labels?: string[];
  concurrency?: number;
  defaultAgent?: string;
}

export class WorkerState {
  private overrides: Overrides;

  constructor(
    /** samdi.worker.yaml에서 온 값. "되돌리기"의 목적지다. */
    readonly configured: WorkerDefaults,
    private readonly file: string = defaultStateFile(),
  ) {
    this.overrides = read(this.file);
  }

  get labels(): string[] {
    return [...(this.overrides.labels ?? this.configured.labels)];
  }

  get concurrency(): number {
    return this.overrides.concurrency ?? this.configured.concurrency;
  }

  /** Task에 지정이 없을 때 쓸 에이전트 */
  get defaultAgent(): string {
    return this.overrides.defaultAgent ?? this.configured.defaultAgent;
  }

  /** 설정값과 다른 값을 쓰고 있는가 — 화면이 "되돌리기"를 보여줄지 정한다. */
  get overridden(): { labels: boolean; concurrency: boolean; defaultAgent: boolean } {
    return {
      labels: this.overrides.labels !== undefined,
      concurrency: this.overrides.concurrency !== undefined,
      defaultAgent: this.overrides.defaultAgent !== undefined,
    };
  }

  /**
   * 받을 라벨을 바꾼다. 다음 claim부터 적용된다 —
   * 폴링 루프가 매번 이 값을 읽어 가므로 재시작이 필요 없다.
   */
  setLabels(labels: string[]): string[] {
    const cleaned = [...new Set(labels.map((l) => l.trim()).filter(Boolean))];
    if (cleaned.length === 0) throw new Error('라벨이 비어 있으면 아무 Task도 가져올 수 없다');
    this.patch({ labels: sameSet(cleaned, this.configured.labels) ? undefined : cleaned });
    return this.labels;
  }

  /**
   * 동시에 처리할 Task 수를 바꾼다.
   *
   * 늘리면 즉시 그만큼 루프가 더 돈다. 줄이면 **진행 중인 일이 끝난 뒤에** 반영된다 —
   * 사람이 승인하기를 기다리는 작업을 중간에 끊어버릴 수는 없기 때문이다.
   */
  setConcurrency(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > 32) {
      throw new Error('동시 처리 수는 1에서 32 사이의 정수여야 한다');
    }
    this.patch({ concurrency: n === this.configured.concurrency ? undefined : n });
    return this.concurrency;
  }

  /**
   * 기본 에이전트를 바꾼다. 다음에 시작되는 Task부터 적용된다.
   *
   * Task별로 고르는 드롭다운만 있으면 pending인 짧은 순간을 노려야 해서 잘 안 먹는다.
   * "내 일은 다 이걸로 돌린다"는 이쪽에서 정하는 게 맞다.
   */
  setDefaultAgent(agent: string, known: string[]): string {
    if (!known.includes(agent)) throw new Error(`모르는 에이전트다: ${agent}`);
    this.patch({ defaultAgent: agent === this.configured.defaultAgent ? undefined : agent });
    return this.defaultAgent;
  }

  /** 설정 파일 값으로 되돌린다. */
  reset(): void {
    this.overrides = {};
    if (existsSync(this.file)) rmSync(this.file, { force: true });
  }

  private patch(next: Overrides): void {
    this.overrides = { ...this.overrides, ...next };
    // undefined인 키는 "덮어쓴 게 없다"는 뜻이므로 파일에 남기지 않는다.
    for (const key of Object.keys(this.overrides) as (keyof Overrides)[]) {
      if (this.overrides[key] === undefined) delete this.overrides[key];
    }
    if (Object.keys(this.overrides).length === 0) {
      this.reset();
      return;
    }
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.overrides, null, 2)}\n`, 'utf8');
  }
}

function defaultStateFile(): string {
  return path.join(os.homedir(), '.samdi', 'worker-state.json');
}

function read(file: string): Overrides {
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    const raw = parsed as Record<string, unknown>;
    const out: Overrides = {};

    if (Array.isArray(raw.labels)) {
      const labels = raw.labels.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
      if (labels.length > 0) out.labels = labels;
    }
    if (typeof raw.concurrency === 'number' && Number.isInteger(raw.concurrency)) {
      if (raw.concurrency >= 1 && raw.concurrency <= 32) out.concurrency = raw.concurrency;
    }
    if (typeof raw.defaultAgent === 'string' && raw.defaultAgent.trim() !== '') {
      out.defaultAgent = raw.defaultAgent;
    }
    return out;
  } catch {
    // 손상된 파일 때문에 Worker가 못 뜨면 안 된다. 설정값으로 돈다.
    return {};
  }
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((v) => set.has(v));
}
