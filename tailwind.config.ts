import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Backgrounds — light, airy
        canvas: '#FFFFFF',
        surface: '#FFFFFF',
        elevated: '#F9FAFC',
        input: '#F3F4F6',

        // Borders — soft cool grey
        line: {
          DEFAULT: '#E3E8EE',
          strong: '#DDE3F0',
          soft: '#F3F4F6',
        },

        // Ink (text) — navy primary, cooling shades
        ink: {
          DEFAULT: '#0A2540',
          muted: '#424553',
          dim: '#6B7280',
          faint: '#9CA3AF',
        },

        // Accents — saturated enough to read on white surfaces
        accent: {
          pink: '#EC4899',
          'pink-strong': '#BE185D',
          'pink-bg': '#FCE7F3',

          purple: '#8B5CF6',
          'purple-strong': '#6D28D9',
          'purple-bg': '#EDE9FE',

          blue: '#2D5BFF',
          'blue-strong': '#1E40AF',
          'blue-bg': '#EFF6FF',

          green: '#10B981',
          'green-bg': '#D1FAE5',

          yellow: '#F59E0B',
          'yellow-bg': '#FEF3C7',

          red: '#EF4444',
          'red-bg': '#FEE2E2',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      backgroundImage: {
        'pink-gradient':
          'linear-gradient(135deg, #2D5BFF 0%, #8B5CF6 50%, #EC4899 100%)',
        'page-glow':
          'radial-gradient(ellipse 80% 50% at 30% 0%, rgba(236,72,153,0.10), transparent 60%), radial-gradient(ellipse 60% 50% at 90% 30%, rgba(45,91,255,0.06), transparent 60%)',
      },
    },
  },
  plugins: [],
};

export default config;
