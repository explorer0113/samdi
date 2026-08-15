import type { AskDecision, LocalReport, Task, TaskReport } from '@samdi/protocol';
import type { AgentAdapter } from '@samdi/agent-adapter';
import type { StartGate } from '@samdi/policy-gateway';
import type { ActivityLog } from './activity-log.js';

/** Worker가 Control Plane에 필요로 하는 최소 계약. 실제 구현은 ControlPlaneClient. */
export interface WorkerClient {
  claim(
    workerId: string,
    labels: string[],
    leaseSeconds: number,
  ): Promise<{ task: Task | null; payload: string | null }>;
  report(taskId: string, report: TaskReport): Promise<void>;
}

export type WorkerPhase = 'gate' | 'agent_running' | 'awaiting_approval' | 'reporting';

export interface CurrentTask {
  taskId: string;
  label: string;
  phase: WorkerPhase;
  startedAt: string;
}

export interface PendingApproval {
  taskId: string;
  question: string;
  askedAt: string;
}

interface QueueItem {
  report: LocalReport;
  /** ask 보고의 HTTP 응답을 풀어주는 콜백 — 사용자 결정이 내려지면 호출된다. */
  respondDecision?: (decision: AskDecision) => void;
}

/** 에이전트 보고를 순서대로 소비하기 위한 단일 소비자 큐. */
class ReportQueue {
  private items: QueueItem[] = [];
  private waiter: ((item: QueueItem) => void) | null = null;

  push(item: QueueItem): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(item);
      return;
    }
    this.items.push(item);
  }

  next(timeoutMs: number): Promise<QueueItem | null> {
    const head = this.items.shift();
    if (head) return Promise.resolve(head);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.waiter = (item) => {
        clearTimeout(timer);
        resolve(item);
      };
    });
  }
}

export interface WorkerDeps {
  client: WorkerClient;
  gate: StartGate;
  /** 이름 → 어댑터 레지스트리. Task의 agent 필드로 선택하고, 없거나 모르면 defaultAgent. */
  adapters: Record<string, AgentAdapter>;
  defaultAgent: string;
  activity: ActivityLog;
  workerId: string;
  labels: string[];
  leaseSeconds: number;
  /** 로컬 보고 API의 베이스 URL. 에이전트 의뢰 시 `${reportBaseUrl}/report/:taskId`를 알려준다. */
  reportBaseUrl: string;
  log: { info: (o: object, msg?: string) => void; error: (o: object, msg?: string) => void };
}

/**
 * Execution Plane의 본체.
 * claim → Triage(로컬) → Start Gate → Agent Adapter 실행 → 로컬 보고 수신 → Control Plane 중계.
 * 에이전트가 ask를 보내면 Task를 waiting으로 올리고 사용자 결정(승인/거부)을 기다린다.
 */
export class Worker {
  private readonly queues = new Map<string, ReportQueue>();
  // 동시에 여러 Task를 처리하므로 진행 상태와 승인 대기를 Task별로 들고 있는다.
  private readonly currentTasks = new Map<string, CurrentTask>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly approvalResolvers = new Map<string, (decision: AskDecision) => void>();

  constructor(private readonly deps: WorkerDeps) {}

  /** 지금 처리 중인 Task들 (시작한 순서) */
  get current(): CurrentTask[] {
    return [...this.currentTasks.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  /** 사용자 결정을 기다리는 승인들 (물어본 순서) */
  get approvals(): PendingApproval[] {
    return [...this.pendingApprovals.values()].sort((a, b) => a.askedAt.localeCompare(b.askedAt));
  }

  /**
   * 로컬 보고 API가 받은 보고를 진행 중인 Task와 연결한다.
   * ask면 decision promise를 돌려준다 — 라우트는 이걸 await해서 응답을 보류한다.
   */
  handleLocalReport(
    taskId: string,
    report: LocalReport,
  ): { ok: false } | { ok: true; decision?: Promise<AskDecision> } {
    const queue = this.queues.get(taskId);
    if (!queue) return { ok: false };
    if (report.type === 'ask') {
      let respond!: (decision: AskDecision) => void;
      const decision = new Promise<AskDecision>((resolve) => {
        respond = resolve;
      });
      queue.push({ report, respondDecision: respond });
      return { ok: true, decision };
    }
    queue.push({ report });
    return { ok: true };
  }

  /** 사용자의 승인/거부 결정 (worker-ui에서 온다). 그 Task의 대기가 없으면 false. */
  decide(taskId: string, decision: AskDecision): boolean {
    const resolve = this.approvalResolvers.get(taskId);
    if (!resolve) return false;
    resolve(decision);
    return true;
  }

  private setPhase(taskId: string, phase: WorkerPhase): void {
    const current = this.currentTasks.get(taskId);
    if (current) this.currentTasks.set(taskId, { ...current, phase });
  }

  /** 사용자 결정이 올 때까지 기다린다. 그동안 이 Task는 waiting으로 표시된다. */
  private waitForApproval(taskId: string, question: string): Promise<AskDecision> {
    return new Promise<AskDecision>((resolve) => {
      this.pendingApprovals.set(taskId, {
        taskId,
        question,
        askedAt: new Date().toISOString(),
      });
      this.approvalResolvers.set(taskId, resolve);
    }).finally(() => {
      this.pendingApprovals.delete(taskId);
      this.approvalResolvers.delete(taskId);
    });
  }

  /** Task 하나를 처리한다. claim할 게 없었으면 false. */
  async processOne(): Promise<boolean> {
    const {
      client,
      gate,
      adapters,
      defaultAgent,
      activity,
      workerId,
      labels,
      leaseSeconds,
      reportBaseUrl,
      log,
    } = this.deps;

    const { task, payload } = await client.claim(workerId, labels, leaseSeconds);
    if (!task) return false;
    // 해석·분류는 서버가 이미 끝냈다. 여기서는 시작 여부만 판정한다.
    const instruction = payload ?? '';
    this.currentTasks.set(task.id, {
      taskId: task.id,
      label: task.label,
      phase: 'gate',
      startedAt: new Date().toISOString(),
    });
    activity.push('claimed', task.id, task.label);
    log.info({ taskId: task.id, label: task.label }, 'task claimed');

    try {
      const decision = await gate.evaluate(task, instruction);

      if (decision.verdict === 'deny') {
        const reason = decision.reason ?? 'start gate denied';
        await client.report(task.id, { type: 'rejected', reason });
        activity.push('gate:deny', task.id, reason);
        return true;
      }

      // ask — 에이전트를 띄우기 전에 사람의 승인을 받는다.
      // 에이전트가 스스로 물어보길 기대하지 않고 여기서 강제하므로,
      // 어떤 에이전트를 쓰든 동작이 같다.
      if (decision.verdict === 'ask') {
        const question = decision.question ?? '이 작업을 시작할까요?';
        this.setPhase(task.id, 'awaiting_approval');
        activity.push('gate:ask', task.id, decision.reason);
        await client.report(task.id, { type: 'waiting', question });

        if ((await this.waitForApproval(task.id, question)) === 'deny') {
          await client.report(task.id, {
            type: 'rejected',
            reason: '사용자가 시작을 승인하지 않았다',
          });
          activity.push('gate:denied_by_user', task.id);
          return true;
        }
        activity.push('gate:approved', task.id);
      } else {
        activity.push('gate:allow', task.id, decision.reason);
      }

      // Task에 지정된 에이전트를 쓰되, 없거나 레지스트리에 모르는 이름이면 기본 에이전트로.
      const agentName = task.agent && adapters[task.agent] ? task.agent : defaultAgent;
      const adapter = adapters[agentName];
      if (!adapter) throw new Error(`unknown default agent: ${defaultAgent}`);
      if (task.agent && task.agent !== agentName) {
        activity.push('agent:fallback', task.id, `${task.agent} 없음 → ${agentName}`);
      }

      // claimed → running, 또는 승인을 거친 경우 waiting → running
      await client.report(task.id, { type: 'started' });
      this.setPhase(task.id, 'agent_running');
      activity.push('agent:started', task.id, agentName);

      const queue = new ReportQueue();
      this.queues.set(task.id, queue);
      // ask가 결정을 기다리며 start()를 붙잡을 수 있으므로 start 완료를 기다리지 않는다.
      void Promise.resolve(
        adapter.start({
          task,
          instruction,
          reportUrl: `${reportBaseUrl}/report/${task.id}`,
        }),
      ).catch((err) => {
        queue.push({ report: { type: 'failed', reason: `adapter: ${String(err)}` } });
      });

      while (true) {
        // 에이전트의 보고를 기다린다. lease가 끝나도록 소식이 없으면
        // Control Plane 쪽 sweep이 stalled로 옮기므로 여기서는 포기하고 다음으로 넘어간다.
        const item = await queue.next(leaseSeconds * 1000);
        if (!item) {
          activity.push('agent:no_report', task.id, 'lease 내 보고 없음 → sweep에 맡김');
          log.error({ taskId: task.id }, 'no report before lease end; leaving task to sweep');
          break;
        }
        const report = item.report;

        if (report.type === 'completed') {
          this.setPhase(task.id, 'reporting');
          await client.report(task.id, { type: 'completed', summary: report.summary });
          activity.push('completed', task.id, report.summary);
          break;
        }
        if (report.type === 'failed') {
          this.setPhase(task.id, 'reporting');
          await client.report(task.id, { type: 'failed', reason: report.reason });
          activity.push('failed', task.id, report.reason);
          break;
        }

        // 실행 중 에이전트가 물어본 경우 → waiting으로 올리고 사용자 결정을 기다린다.
        // 주의: 승인 대기 중에도 lease는 흐른다. 오래 방치되면 stalled로 넘어갈 수 있다
        // (lease 연장 heartbeat은 이후 단계).
        this.setPhase(task.id, 'awaiting_approval');
        activity.push('ask', task.id, report.question);
        await client.report(task.id, { type: 'waiting', question: report.question });
        const userDecision = await this.waitForApproval(task.id, report.question);
        item.respondDecision?.(userDecision);

        if (userDecision === 'approve') {
          await client.report(task.id, { type: 'resumed' });
          activity.push('approved', task.id);
          this.setPhase(task.id, 'agent_running');
          continue; // 에이전트의 최종 보고를 계속 기다린다
        }
        await client.report(task.id, { type: 'failed', reason: '사용자가 승인을 거부했다' });
        activity.push('denied', task.id);
        break;
      }
      log.info({ taskId: task.id }, 'task finished');
      return true;
    } finally {
      this.queues.delete(task.id);
      this.pendingApprovals.delete(task.id);
      this.approvalResolvers.delete(task.id);
      this.currentTasks.delete(task.id);
    }
  }
}
