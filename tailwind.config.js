/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  // The receipt is raw print CSS with fixed millimetre widths for an 80mm
  // thermal printer (see styles.css) — Tailwind's preflight reset must never
  // touch it, so it is excluded from purge scanning and left as plain CSS.
  theme: {
    extend: {
      colors: {
        // Pastel red on white. Kept deliberately soft (a warm coral-red rather
        // than a saturated fire-engine red) since it fills nav, buttons, and
        // headings across the whole app — a fully saturated red at that scale
        // reads as constant alarm. Error/danger states use amber instead of
        // this palette's own darker shades so "primary action" and "destructive"
        // stay visually distinct.
        brand: {
          50: "#fdf4f3",
          100: "#fbe6e4",
          200: "#f6cdc8",
          300: "#eeaaa2",
          400: "#e17f74",
          500: "#d05f52",
          600: "#b8483b",
          700: "#983a30",
          800: "#7c3129",
          900: "#672c26",
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
