/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '"Inter"',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          '"Hiragino Sans GB"',
          'system-ui',
          'sans-serif',
        ],
        script: ['"Dancing Script"', '"Snell Roundhand"', 'cursive'],
      },
      colors: {
        ink: {
          900: '#23263a',
          700: '#3d415c',
          500: '#6b7094',
          300: '#9aa0c0',
        },
        aika: {
          50: '#f3f2ff',
          100: '#e9e7ff',
          200: '#d6d2ff',
          300: '#b8b1ff',
          400: '#958bff',
          500: '#7a6cf5',
          600: '#6857e8',
          700: '#5848cf',
        },
        sakura: {
          100: '#ffe4f0',
          300: '#ffb3d5',
          400: '#ff86bd',
        },
      },
      boxShadow: {
        soft: '0 10px 40px -12px rgba(99, 102, 180, 0.18)',
        card: '0 6px 24px -8px rgba(86, 90, 140, 0.16)',
        glow: '0 0 0 4px rgba(122, 108, 245, 0.12)',
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.5rem',
        '4xl': '2rem',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in': {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-6px)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.35s ease both',
        'slide-in': 'slide-in 0.28s ease both',
        float: 'float 5s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
