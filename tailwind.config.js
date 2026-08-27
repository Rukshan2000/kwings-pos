/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  // The receipt is raw print CSS with fixed millimetre widths for an 80mm
  // thermal printer (see styles.css) — Tailwind's preflight reset must never
  // touch it, so it is excluded from purge scanning and left as plain CSS.
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f2f7f3",
          100: "#e0ede2",
          200: "#c2dbc7",
          300: "#96c09f",
          400: "#679d74",
          500: "#457f54",
          600: "#356543",
          700: "#2c5137",
          800: "#26422f",
          900: "#213829",
        },
      },
      fontFamily: {
        sans: ["Inter", "Segoe UI", "Roboto", "Helvetica", "Arial", "sans-serif"],
      },
      boxShadow: {
        card: "0 1px 2px rgba(16, 24, 20, 0.04), 0 8px 24px -8px rgba(16, 24, 20, 0.08)",
      },
    },
  },
  plugins: [],
}
