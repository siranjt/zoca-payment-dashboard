/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        zoca: {
          ink:    "#1F3864",
          accent: "#2F5496",
          pass:   "#1B7E3C",
          fail:   "#9C1B22",
          warn:   "#B45F06",
          gap:    "#595959",
          info:   "#E7EEF7",
          banner: "#FFF8E1",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
