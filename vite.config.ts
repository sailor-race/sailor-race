import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

// https://vite.dev/config/
export default defineConfig({
  // مسارات نسبية حتى يعمل الموقع على GitHub Pages تحت أي اسم مستودع
  // (username.github.io/REPO/) بدون الحاجة لتعديل الإعداد عند تغيير الاسم.
  base: './',
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] })
  ],
})
