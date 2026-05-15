/// <reference types="vite/client" />

// Quill ships its CSS without TypeScript declarations; we lazy-import it
// inside NotesModal and Vite handles the actual stylesheet injection.
declare module "quill/dist/quill.snow.css";
