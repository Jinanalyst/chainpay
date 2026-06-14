/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#070a13',
          900: '#0b0f1c',
          800: '#121829',
          700: '#1c2440',
        },
        brand: {
          50:  '#eef6ff',
          100: '#d8ebff',
          200: '#b3d6ff',
          300: '#7eb6ff',
          400: '#4a8cff',
          500: '#2563eb',
          600: '#1d4ed8',
          700: '#1e40af',
        },
        accent: {
          300: '#5eead4',
          400: '#2dd4bf',
          500: '#14b8a6',
          600: '#0d9488',
          700: '#0f766e',
        },
        cream:       '#fbf6ee',
        'warm-ink':  '#2a2520',
        'warm-peach':'#ffd7b5',
        'warm-blush':'#ffd4d1',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        glow: '0 0 60px -10px rgba(74,140,255,0.45)',
      },
      backgroundImage: {
        'grid-fade':
          'radial-gradient(ellipse at top, rgba(74,140,255,0.18), transparent 60%), radial-gradient(ellipse at bottom, rgba(34,211,164,0.12), transparent 60%)',
      },
      animation: {
        'pulse-slow': 'pulse 6s ease-in-out infinite',
        'float': 'float 8s ease-in-out infinite',
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-10px)' },
        },
      },
    },
  },
  plugins: [],
}
