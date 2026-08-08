export interface ActivityEntry {
  at: string;
  type: string;
  taskId?: string;
  detail?: string;
}

/** UI 표시용 인메모리 활동 로그. 감사 로그(Control Plane)와 달리 휘발성이다. */
export class ActivityLog {
  private entries: ActivityEntry[] = [];

  constructor(private readonly capacity = 200) {}

  push(type: string, taskId?: string, detail?: string): void {
    this.entries.push({ at: new Date().toISOString(), type, taskId, detail });
    if (this.entries.length > this.capacity) {
      this.entries = this.entries.slice(-this.capacity);
    }
  }

  /** 최신순 */
  list(): ActivityEntry[] {
    return [...this.entries].reverse();
  }
}
