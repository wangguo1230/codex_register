import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            // 开发时把 /api(含 SSE /api/stream) 代理到后端
            "/api": {target: "http://localhost:3100", changeOrigin: true},
        },
    },
    build: {outDir: "dist"},
});
