/**
 * 에이전트에게 붙여주는 도구 계층.
 *
 * MVP에서는 로컬 보고 API(HTTP)만 쓰므로 이 패키지는 자리만 잡아둔다.
 * 이후 단계에서 MCP 서버로 보고/승인 요청 도구를 노출한다:
 *  - report_complete / report_failed → Worker 로컬 보고 API 중계
 *  - ask_approval → waiting 상태 전환 요청
 */
export const TOOL_SDK_PLACEHOLDER = true;
