import type { Task } from '@samdi/protocol';

/**
 * demo-cli — end-to-end 데모/조작용.
 *
 *   inject <텍스트...>   demo 채널로 이벤트 주입 (외부 웹훅 흉내)
 *   list [상태]          Task 목록
 *   show <taskId>        Task 상세 + 본문 + 감사 이벤트
 *   retry <taskId>       stalled Task 재시도 승인 (수동 게이트)
 *   abandon <taskId>     stalled Task 포기 → failed
 */
const base = process.env.SAMDI_CONTROL_PLANE_URL ?? 'http://127.0.0.1:3000';
const channelKey = process.env.SAMDI_CHANNEL_KEY ?? 'demo-channel-key';
const workerKey = process.env.SAMDI_WORKER_KEY ?? 'demo-worker-key';

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-worker-key': workerKey,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  return res.json();
}

function printTasks(tasks: Task[]): void {
  if (tasks.length === 0) {
    console.log('(no tasks)');
    return;
  }
  for (const t of tasks) {
    console.log(`${t.id}  ${t.status.padEnd(11)}  ${t.label.padEnd(10)}  ${t.updatedAt}`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case 'inject': {
    const payload = rest.join(' ');
    if (!payload) {
      console.error('usage: demo-cli inject <텍스트...>');
      process.exit(1);
    }
    const out = (await api('/channels/demo/events', {
      method: 'POST',
      headers: { 'x-channel-key': channelKey },
      body: JSON.stringify({ payload }),
    })) as { taskId: string };
    console.log(`task created: ${out.taskId}`);
    break;
  }
  case 'list': {
    const status = rest[0] ? `?status=${rest[0]}` : '';
    const out = (await api(`/tasks${status}`)) as { tasks: Task[] };
    printTasks(out.tasks);
    break;
  }
  case 'show': {
    const out = await api(`/tasks/${rest[0]}`);
    console.log(JSON.stringify(out, null, 2));
    break;
  }
  case 'retry':
  case 'abandon': {
    const out = (await api(`/tasks/${rest[0]}/retry`, {
      method: 'POST',
      body: JSON.stringify({ action: cmd }),
    })) as { task: Task };
    console.log(`task ${out.task.id} → ${out.task.status}`);
    break;
  }
  default:
    console.log('usage: demo-cli <inject|list|show|retry|abandon> ...');
    process.exit(cmd ? 1 : 0);
}
