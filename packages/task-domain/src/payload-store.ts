/**
 * 본문(자연어 페이로드) 저장소.
 * Task 상태 DB와 분리해두고, MVP는 SQLite 별도 테이블 구현을 쓴다.
 * 이후 파일/오브젝트 스토리지 구현으로 교체 가능하다.
 */
export interface PayloadStore {
  put(payload: string): Promise<string>;
  get(ref: string): Promise<string | null>;
}

/** 테스트/데모용 인메모리 구현 */
export class InMemoryPayloadStore implements PayloadStore {
  private readonly items = new Map<string, string>();
  private seq = 0;

  async put(payload: string): Promise<string> {
    const ref = `mem-${++this.seq}`;
    this.items.set(ref, payload);
    return ref;
  }

  async get(ref: string): Promise<string | null> {
    return this.items.get(ref) ?? null;
  }
}
