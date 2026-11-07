/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/frontend/**/*.{vue,js,ts,jsx,tsx,html}",
    "./static/**/*.html"
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef2ff',
          100: '#e0e7ff',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8'
        }
      }
    },
  },
  plugins: [],
}
