import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Control Plane의 주소. 관리 UI는 서버 API를 직접 부른다 —
// Worker UI가 Worker를 거쳐 가는 것과 다른 점이고, 그래서 관리 키가 따로 있다.
const controlPlanePort = process.env.PORT ?? '3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.ADMIN_UI_PORT ?? 5174),
    // 안내한 주소와 실제 주소가 어긋나는 게 더 나쁘다.
    strictPort: true,
    proxy: {
      '/admin': `http://127.0.0.1:${controlPlanePort}`,
      '/tasks': `http://127.0.0.1:${controlPlanePort}`,
      '/threads': `http://127.0.0.1:${controlPlanePort}`,
      '/health': `http://127.0.0.1:${controlPlanePort}`,
    },
  },
});
