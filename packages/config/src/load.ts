import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z, type ZodError, type ZodTypeAny } from 'zod';
import { serverConfigSchema, workerConfigSchema, type ServerConfig, type WorkerConfig } from './schema.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface LoadOptions {
  /** 명시 경로. 주면 그 파일이 반드시 있어야 한다. */
  path?: string;
  env?: Record<string, string | undefined>;
  /** 설정 파일 탐색 기준 디렉토리 */
  cwd?: string;
}

export interface Loaded<T> {
  config: T;
  /** 읽은 파일 경로. 설정 파일 없이 기본값으로 돌면 null. */
  source: string | null;
}

type Plain = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Plain =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** base 위에 patch를 덮는다 (undefined는 무시). env가 파일을 이기는 규칙의 구현. */
function deepMerge(base: Plain, patch: Plain): Plain {
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const prev = out[key];
    out[key] = isPlainObject(value) && isPlainObject(prev) ? deepMerge(prev, value) : value;
  }
  return out;
}

/** undefined 값만 든 객체는 통째로 버린다 — 빈 오버라이드가 기본값을 덮지 않게. */
function compact(obj: Plain): Plain | undefined {
  const out: Plain = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (isPlainObject(value)) {
      const inner = compact(value);
      if (inner) out[key] = inner;
      continue;
    }
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function formatIssues(err: ZodError, source: string | null): string {
  const where = source ? `설정 파일 ${source}` : '설정(기본값 + 환경변수)';
  const lines = err.issues.map((i) => {
    const key = i.path.length > 0 ? i.path.join('.') : '(root)';
    return `  - ${key}: ${i.message}`;
  });
  return `${where}가 올바르지 않다:\n${lines.join('\n')}`;
}

function readYamlFile(file: string): Plain {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new ConfigError(`설정 파일을 읽을 수 없다: ${file} (${String(err)})`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`YAML 문법 오류: ${file}\n  ${reason}`);
  }
  if (parsed === null || parsed === undefined) return {}; // 빈 파일은 기본값으로
  if (!isPlainObject(parsed)) {
    throw new ConfigError(`설정 파일의 최상위는 매핑(key: value)이어야 한다: ${file}`);
  }
  return parsed;
}

function resolveSource(
  opts: LoadOptions,
  envVar: string,
  candidates: string[],
): string | null {
  const env = opts.env ?? process.env;
  const explicit = opts.path ?? env[envVar];
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!existsSync(resolved)) {
      throw new ConfigError(`설정 파일이 없다: ${resolved} (${envVar}로 지정됨)`);
    }
    return resolved;
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function load<S extends ZodTypeAny>(
  schema: S,
  source: string | null,
  overrides: Plain,
): z.infer<S> {
  const fromFile = source ? readYamlFile(source) : {};
  const merged = deepMerge(fromFile, overrides);
  const result = schema.safeParse(merged);
  if (!result.success) {
    throw new ConfigError(formatIssues(result.error, source));
  }
  return result.data as z.infer<S>;
}

/**
 * Control Plane 설정.
 * 탐색 순서: SAMDI_SERVER_CONFIG(또는 opts.path) → ./samdi.server.yaml → ~/.samdi/server.yaml → 기본값
 */
export function loadServerConfig(opts: LoadOptions = {}): Loaded<ServerConfig> {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const source = resolveSource(opts, 'SAMDI_SERVER_CONFIG', [
    path.join(cwd, 'samdi.server.yaml'),
    path.join(os.homedir(), '.samdi', 'server.yaml'),
  ]);

  const overrides = compact({
    port: env.PORT,
    host: env.SAMDI_HOST,
    dbPath: env.SAMDI_DB_PATH,
    workerKey: env.SAMDI_WORKER_KEY,
    sweepIntervalMs: env.SAMDI_SWEEP_INTERVAL_MS,
  }) ?? {};

  const config = load(serverConfigSchema, source, overrides);

  // 레거시 편의: SAMDI_CHANNEL_KEY는 데모 채널(id: demo)의 키만 덮는다.
  if (env.SAMDI_CHANNEL_KEY) {
    config.channels = config.channels.map((c) =>
      c.id === 'demo' ? { ...c, key: env.SAMDI_CHANNEL_KEY as string } : c,
    );
  }
  return { config, source };
}

/**
 * Worker 설정.
 * 탐색 순서: SAMDI_WORKER_CONFIG(또는 opts.path) → ./samdi.worker.yaml → ~/.samdi/worker.yaml → 기본값
 */
export function loadWorkerConfig(opts: LoadOptions = {}): Loaded<WorkerConfig> {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const source = resolveSource(opts, 'SAMDI_WORKER_CONFIG', [
    path.join(cwd, 'samdi.worker.yaml'),
    path.join(os.homedir(), '.samdi', 'worker.yaml'),
  ]);

  // SAMDI_CLAUDE_* 는 두 claude 어댑터에 함께 적용된다.
  const claudeOverride = compact({
    bin: env.SAMDI_CLAUDE_BIN,
    permissionMode: env.SAMDI_CLAUDE_PERMISSION_MODE,
    allowedTools: env.SAMDI_CLAUDE_ALLOWED_TOOLS,
    cwd: env.SAMDI_CLAUDE_CWD,
    timeoutMs: env.SAMDI_CLAUDE_TIMEOUT_MS,
  });

  const overrides =
    compact({
      controlPlane: {
        url: env.SAMDI_CONTROL_PLANE_URL,
        workerKey: env.SAMDI_WORKER_KEY,
        channelKey: env.SAMDI_CHANNEL_KEY,
      },
      worker: {
        id: env.SAMDI_WORKER_ID,
        labels: env.SAMDI_LABELS,
        pollIntervalMs: env.SAMDI_POLL_INTERVAL_MS,
        leaseSeconds: env.SAMDI_LEASE_SECONDS,
        reportPort: env.SAMDI_REPORT_PORT,
        reportHost: env.SAMDI_REPORT_HOST,
        concurrency: env.SAMDI_CONCURRENCY,
      },
      startGate: {
        requireApproval: env.SAMDI_REQUIRE_APPROVAL
          ? env.SAMDI_REQUIRE_APPROVAL !== 'false'
          : undefined,
      },
      uiDist: env.SAMDI_UI_DIST,
      defaultAgent: env.SAMDI_AGENT,
      agents: claudeOverride
        ? { 'claude-code': claudeOverride }
        : undefined,
    }) ?? {};

  return { config: load(workerConfigSchema, source, overrides), source };
}
