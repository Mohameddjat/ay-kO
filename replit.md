# GEARSHIFT: Assembly Race

A pseudo-3D gear racing game built with React + Vite + TypeScript, using Firebase for multiplayer state.

## Stack
- React 19 + TypeScript + Vite 6
- Tailwind CSS v4 (via `@tailwindcss/vite`)
- Express dev server wrapping Vite middleware (`server.ts`)
- Firebase (Anonymous Auth + Firestore) — config in `firebase-applet-config.json`
- Optional: Gemini API via `GEMINI_API_KEY` env var

## Replit Setup
- Workflow `Server` runs `npm run dev` on port 5000 (webview)
- `server.ts` listens on `0.0.0.0:5000`
- Vite middleware uses `allowedHosts: true` so the Replit iframe proxy works
- `.local`, `.cache`, `.git`, `node_modules`, `dist` are excluded from Vite file watching to prevent reload spam

## Deployment
- Target: `autoscale`
- Build: `npm run build`
- Run: `npm run preview -- --host 0.0.0.0 --port 5000`

## Notes
- `socket.io`/`socket.io-client` are listed in dependencies but not actually used; multiplayer is Firestore-only.
- `src/index.css` imports Google Fonts before `@import "tailwindcss"` (required by CSS spec — `@import` must precede other statements).
