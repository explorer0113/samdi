import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// worker의 reportPort와 반드시 일치해야 한다 (samdi.worker.yaml의 worker.reportPort).
const workerPort = process.env.SAMDI_REPORT_PORT ?? '4700';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.UI_PORT ?? 5173),
    // 포트가 막혔으면 조용히 다른 포트로 옮기지 말고 실패한다 —
    // 안내한 주소와 실제 주소가 달라지는 게 더 나쁘다.
    strictPort: true,
    // 브라우저는 worker의 로컬 API만 본다 — 키는 worker에만 있다.
    proxy: {
      '/ui': `http://127.0.0.1:${workerPort}`,
    },
  },
});
