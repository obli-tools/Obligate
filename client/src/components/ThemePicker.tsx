import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../utils/cn';

type AppTheme = 'modern' | 'neon' | 'obli-operator' | 'obli-daylight' | 'obli-dim';

interface ThemePickerProps {
  value: string;
  onChange: (theme: string) => void;
}

function ObliOperatorPreviewSvg() {
  return (
    <svg viewBox="0 0 280 170" xmlns="http://www.w3.org/2000/svg" className="w-full rounded-md">
      {/* Page bg #0b0d1a */}
      <rect width="280" height="170" fill="#0b0d1a" rx="6" />
      {/* Sidebar #0f1220 */}
      <rect x="0" y="0" width="60" height="170" fill="#0f1220" rx="6" />
      {/* Topbar #0f1220 */}
      <rect x="60" y="0" width="220" height="22" fill="#0f1220" />
      {/* App pills (5) */}
      {[0, 1, 2, 3, 4].map((i) => {
        const accents = ['#2bc4bd', '#f5a623', '#1edd8a', '#e03a3a', '#2d4ec9'];
        const x = 70 + i * 28;
        const isActive = i === 3;
        return (
          <g key={i}>
            <rect x={x} y="7" width="24" height="9" rx="4" fill={isActive ? '#e03a3a' : 'transparent'} opacity={isActive ? 0.18 : 1} />
            <circle cx={x + 4} cy="11.5" r="1.6" fill={accents[i]} />
          </g>
        );
      })}
      {/* Sidebar logo dot — red accent */}
      <rect x="10" y="10" width="14" height="14" rx="3" fill="#cda247" />
      <rect x="28" y="13" width="22" height="4" rx="1.5" fill="#e8ecf5" opacity="0.95" />
      {/* Sidebar primary action button */}
      <rect x="6" y="32" width="48" height="14" rx="4" fill="#cda247" />
      <rect x="14" y="37" width="32" height="4" rx="1.5" fill="#fff" opacity="0.95" />
      {/* Sidebar nav items */}
      {[52, 68, 84, 100].map((y, i) => (
        <g key={y}>
          <rect x="4" y={y} width="52" height="13" rx="3" fill={i === 0 ? 'rgba(224,58,58,0.12)' : 'transparent'} />
          <rect x="10" y={y + 4} width="6" height="6" rx="1.5" fill={i === 0 ? '#ff6868' : '#4b5273'} />
          <rect x="20" y={y + 5} width={i === 0 ? 26 : 22} height="3.5" rx="1.5" fill={i === 0 ? '#ff6868' : '#8c93b6'} />
        </g>
      ))}
      {/* Hero KPI strip — 5 cards (no borders, shadow-only) */}
      {[0, 1, 2, 3, 4].map((i) => {
        const x = 68 + i * 41;
        const widths = [55, 36, 36, 36, 36];
        const w = widths[i];
        const isFeatured = i === 0;
        return (
          <g key={`kpi-${i}`}>
            <rect x={x} y="32" width={w} height="36" rx="5" fill="#131728" />
            <rect x={x + 4} y="38" width="14" height="3" rx="1" fill="#8c93b6" opacity="0.7" />
            {/* JetBrains-mono-style numerics */}
            <rect x={x + 4} y="46" width={isFeatured ? 18 : 14} height={isFeatured ? 9 : 7} rx="1" fill="#e8ecf5" />
            {isFeatured && (
              <path d={`M ${x + 4} 64 L ${x + 12} 60 L ${x + 20} 62 L ${x + 28} 58 L ${x + 36} 60 L ${x + 44} 56 L ${x + 51} 59`} stroke="#cda247" strokeWidth="1.2" fill="none" />
            )}
            {!isFeatured && (
              <circle cx={x + w - 6} cy="42" r="1.8" fill={['#1edd8a', '#107050', '#f5a623', '#4f7bff'][i - 1]} />
            )}
          </g>
        );
      })}
      {/* Two-column row: chart (left, 2fr) + donut (right, 1fr) */}
      <rect x="68" y="74" width="135" height="48" rx="5" fill="#131728" />
      <path d="M 76 110 L 86 96 L 96 102 L 106 88 L 116 95 L 126 84 L 136 92 L 146 80 L 156 88 L 166 76 L 176 84 L 186 78 L 196 86" stroke="#cda247" strokeWidth="1.4" fill="none" />
      <path d="M 76 110 L 86 96 L 96 102 L 106 88 L 116 95 L 126 84 L 136 92 L 146 80 L 156 88 L 166 76 L 176 84 L 186 78 L 196 86 L 196 118 L 76 118 Z" fill="#cda247" opacity="0.12" />
      <rect x="207" y="74" width="65" height="48" rx="5" fill="#131728" />
      <circle cx="225" cy="98" r="13" fill="none" stroke="#1d2238" strokeWidth="3" />
      <circle cx="225" cy="98" r="13" fill="none" stroke="#cda247" strokeWidth="3" strokeDasharray="50 81" transform="rotate(-90 225 98)" />
      {[105, 111].map((y, i) => (
        <g key={y}>
          <rect x="244" y={y - 3} width="3" height="3" rx="0.5" fill={['#cda247', '#1edd8a'][i]} />
          <rect x="250" y={y - 2} width="20" height="2" rx="1" fill="#8c93b6" />
        </g>
      ))}
      {/* Bottom status row — 4 small cards */}
      {[0, 1, 2, 3].map((i) => {
        const x = 68 + i * 51;
        return (
          <g key={`s-${i}`}>
            <rect x={x} y="128" width="46" height="32" rx="4" fill="#131728" />
            <rect x={x + 4} y="134" width="6" height="6" rx="1.5" fill="#cda247" opacity="0.9" />
            <rect x={x + 13} y="135" width="22" height="3" rx="1" fill="#e8ecf5" opacity="0.9" />
            <rect x={x + 13} y="141" width="14" height="2.5" rx="1" fill="#8c93b6" />
            <rect x={x + 4} y="150" width="38" height="6" rx="1.5" fill="#1d2238" />
          </g>
        );
      })}
    </svg>
  );
}

function ObliDaylightPreviewSvg() {
  // Light companion: soft white/gray surfaces, indigo accent, per-app dots
  // tuned for a light background. Same layout language as Obli Operator.
  return (
    <svg viewBox="0 0 280 170" xmlns="http://www.w3.org/2000/svg" className="w-full rounded-md">
      {/* Page bg */}
      <rect width="280" height="170" fill="#e5e9f0" rx="6" />
      {/* Sidebar */}
      <rect x="0" y="0" width="60" height="170" fill="#eceff4" rx="6" />
      <rect x="60" y="0" width="1" height="170" fill="#d4dce7" />
      {/* Topbar */}
      <rect x="60" y="0" width="220" height="22" fill="#eceff4" />
      <rect x="60" y="22" width="220" height="1" fill="#d4dce7" />
      {/* App pills (5) */}
      {[0, 1, 2, 3, 4].map((i) => {
        const accents = ['#0d9488', '#d97706', '#16a34a', '#dc2626', '#2563eb'];
        const x = 70 + i * 28;
        const isActive = i === 3;
        return (
          <g key={i}>
            <rect x={x} y="7" width="24" height="9" rx="4" fill={isActive ? '#dc2626' : 'transparent'} opacity={isActive ? 0.12 : 1} />
            <circle cx={x + 4} cy="11.5" r="1.6" fill={accents[i]} />
          </g>
        );
      })}
      {/* Sidebar logo dot — indigo accent */}
      <rect x="10" y="10" width="14" height="14" rx="3" fill="#c2912e" />
      <rect x="28" y="13" width="22" height="4" rx="1.5" fill="#2e3440" opacity="0.85" />
      {/* Sidebar primary action button */}
      <rect x="6" y="32" width="48" height="14" rx="4" fill="#c2912e" />
      <rect x="14" y="37" width="32" height="4" rx="1.5" fill="#fff" opacity="0.95" />
      {/* Sidebar nav items */}
      {[52, 68, 84, 100].map((y, i) => (
        <g key={y}>
          <rect x="4" y={y} width="52" height="13" rx="3" fill={i === 0 ? 'rgba(194,145,46,0.12)' : 'transparent'} />
          <rect x="10" y={y + 4} width="6" height="6" rx="1.5" fill={i === 0 ? '#c2912e' : '#94a3b8'} />
          <rect x="20" y={y + 5} width={i === 0 ? 26 : 22} height="3.5" rx="1.5" fill={i === 0 ? '#c2912e' : '#94a3b8'} />
        </g>
      ))}
      {/* Hero KPI strip — 5 cards */}
      {[0, 1, 2, 3, 4].map((i) => {
        const x = 68 + i * 41;
        const widths = [55, 36, 36, 36, 36];
        const w = widths[i];
        const isFeatured = i === 0;
        return (
          <g key={`kpi-${i}`}>
            <rect x={x} y="32" width={w} height="36" rx="5" fill="#eceff4" />
            <rect x={x + 4} y="38" width="14" height="3" rx="1" fill="#94a3b8" />
            <rect x={x + 4} y="46" width={isFeatured ? 18 : 14} height={isFeatured ? 9 : 7} rx="1" fill="#2e3440" />
            {isFeatured && (
              <path d={`M ${x + 4} 64 L ${x + 12} 60 L ${x + 20} 62 L ${x + 28} 58 L ${x + 36} 60 L ${x + 44} 56 L ${x + 51} 59`} stroke="#c2912e" strokeWidth="1.2" fill="none" />
            )}
            {!isFeatured && (
              <circle cx={x + w - 6} cy="42" r="1.8" fill={['#16a34a', '#0d9488', '#d97706', '#2563eb'][i - 1]} />
            )}
          </g>
        );
      })}
      {/* Two-column: line chart + donut */}
      <rect x="68" y="74" width="135" height="48" rx="5" fill="#eceff4" />
      <path d="M 76 110 L 86 96 L 96 102 L 106 88 L 116 95 L 126 84 L 136 92 L 146 80 L 156 88 L 166 76 L 176 84 L 186 78 L 196 86" stroke="#c2912e" strokeWidth="1.4" fill="none" />
      <path d="M 76 110 L 86 96 L 96 102 L 106 88 L 116 95 L 126 84 L 136 92 L 146 80 L 156 88 L 166 76 L 176 84 L 186 78 L 196 86 L 196 118 L 76 118 Z" fill="#c2912e" opacity="0.10" />
      <rect x="207" y="74" width="65" height="48" rx="5" fill="#eceff4" />
      <circle cx="225" cy="98" r="13" fill="none" stroke="#d8dee9" strokeWidth="3" />
      <circle cx="225" cy="98" r="13" fill="none" stroke="#c2912e" strokeWidth="3" strokeDasharray="50 81" transform="rotate(-90 225 98)" />
      {[105, 111].map((y, i) => (
        <g key={y}>
          <rect x="244" y={y - 3} width="3" height="3" rx="0.5" fill={['#c2912e', '#16a34a'][i]} />
          <rect x="250" y={y - 2} width="20" height="2" rx="1" fill="#94a3b8" />
        </g>
      ))}
      {/* Bottom status row */}
      {[0, 1, 2, 3].map((i) => {
        const x = 68 + i * 51;
        return (
          <g key={`s-${i}`}>
            <rect x={x} y="128" width="46" height="32" rx="4" fill="#eceff4" />
            <rect x={x + 4} y="134" width="6" height="6" rx="1.5" fill="#c2912e" opacity="0.9" />
            <rect x={x + 13} y="135" width="22" height="3" rx="1" fill="#2e3440" opacity="0.9" />
            <rect x={x + 13} y="141" width="14" height="2.5" rx="1" fill="#94a3b8" />
            <rect x={x + 4} y="150" width="38" height="6" rx="1.5" fill="#d8dee9" />
          </g>
        );
      })}
    </svg>
  );
}

function ObliDimPreviewSvg() {
  // Dark companion of Obli Daylight: Nord "Polar Night" neutrals, same layout
  // language. The accent is Obligate's own gold, identical to Obli Operator:
  // Dim changes neutrals only.
  const bg      = '#2e3440';   // page
  const chrome  = '#282d37';   // topbar + sidebar (one step darker than page)
  const card    = '#3b4252';   // cards / surfaces
  const raised  = '#434c5e';   // inputs / pill containers / hover
  const active  = '#4a5468';   // selected nav item
  const text    = '#eceff4';
  const text2   = '#d8dee9';
  const muted   = '#a3abbc';
  const up      = '#6ccb8f';
  const warn    = '#ebcb8b';
  const down    = '#ff6b6b';
  const info    = '#88a6e0';
  const offline = '#8a93a6';
  const accent  = '#cda247';   // Operator gold
  const accentText = '#0f172a'; // Operator --c-accent-text (dark text on gold)
  return (
    <svg viewBox="0 0 280 170" xmlns="http://www.w3.org/2000/svg" className="w-full rounded-md">
      {/* Page bg */}
      <rect width="280" height="170" fill={bg} rx="6" />
      {/* Sidebar */}
      <rect x="0" y="0" width="60" height="170" fill={chrome} rx="6" />
      {/* Topbar */}
      <rect x="60" y="0" width="220" height="22" fill={chrome} />
      {/* App pills (5) — container pill, no active state (Obligate is the gateway) */}
      <rect x="66" y="5" width="140" height="13" rx="4" fill={raised} />
      {[0, 1, 2, 3, 4].map((i) => {
        const accents = ['#2bc4bd', '#f5a623', '#1edd8a', '#e03a3a', '#2d4ec9'];
        const x = 70 + i * 28;
        return (
          <g key={i}>
            <circle cx={x + 4} cy="11.5" r="1.6" fill={accents[i]} />
            <rect x={x + 8} y="10" width="12" height="3" rx="1" fill={text2} opacity="0.7" />
          </g>
        );
      })}
      {/* Sidebar logo dot — gold accent */}
      <rect x="10" y="10" width="14" height="14" rx="3" fill={accent} />
      <rect x="28" y="13" width="22" height="4" rx="1.5" fill={text} opacity="0.95" />
      {/* Sidebar primary action button */}
      <rect x="6" y="32" width="48" height="14" rx="4" fill={accent} />
      <rect x="14" y="37" width="32" height="4" rx="1.5" fill={accentText} opacity="0.85" />
      {/* Sidebar nav items */}
      {[52, 68, 84, 100].map((y, i) => (
        <g key={y}>
          <rect x="4" y={y} width="52" height="13" rx="3" fill={i === 0 ? active : 'transparent'} />
          <rect x="10" y={y + 4} width="6" height="6" rx="1.5" fill={i === 0 ? accent : muted} />
          <rect x="20" y={y + 5} width={i === 0 ? 26 : 22} height="3.5" rx="1.5" fill={i === 0 ? text : text2} opacity={i === 0 ? 1 : 0.8} />
        </g>
      ))}
      {/* Hero KPI strip — 5 cards */}
      {[0, 1, 2, 3, 4].map((i) => {
        const x = 68 + i * 41;
        const widths = [55, 36, 36, 36, 36];
        const w = widths[i];
        const isFeatured = i === 0;
        return (
          <g key={`kpi-${i}`}>
            <rect x={x} y="32" width={w} height="36" rx="5" fill={card} />
            <rect x={x + 4} y="38" width="14" height="3" rx="1" fill={muted} />
            <rect x={x + 4} y="46" width={isFeatured ? 18 : 14} height={isFeatured ? 9 : 7} rx="1" fill={text} />
            {isFeatured && (
              <path d={`M ${x + 4} 64 L ${x + 12} 60 L ${x + 20} 62 L ${x + 28} 58 L ${x + 36} 60 L ${x + 44} 56 L ${x + 51} 59`} stroke={accent} strokeWidth="1.2" fill="none" />
            )}
            {!isFeatured && (
              <circle cx={x + w - 6} cy="42" r="1.8" fill={[up, offline, warn, info][i - 1]} />
            )}
          </g>
        );
      })}
      {/* Two-column: line chart + donut */}
      <rect x="68" y="74" width="135" height="48" rx="5" fill={card} />
      <path d="M 76 110 L 86 96 L 96 102 L 106 88 L 116 95 L 126 84 L 136 92 L 146 80 L 156 88 L 166 76 L 176 84 L 186 78 L 196 86" stroke={accent} strokeWidth="1.4" fill="none" />
      <path d="M 76 110 L 86 96 L 96 102 L 106 88 L 116 95 L 126 84 L 136 92 L 146 80 L 156 88 L 166 76 L 176 84 L 186 78 L 196 86 L 196 118 L 76 118 Z" fill={accent} opacity="0.14" />
      <rect x="207" y="74" width="65" height="48" rx="5" fill={card} />
      <circle cx="225" cy="98" r="13" fill="none" stroke={raised} strokeWidth="3" />
      <circle cx="225" cy="98" r="13" fill="none" stroke={accent} strokeWidth="3" strokeDasharray="50 81" transform="rotate(-90 225 98)" />
      {[105, 111].map((y, i) => (
        <g key={y}>
          <rect x="244" y={y - 3} width="3" height="3" rx="0.5" fill={[accent, up][i]} />
          <rect x="250" y={y - 2} width="20" height="2" rx="1" fill={muted} />
        </g>
      ))}
      {/* Bottom status row — down / up / warning / info tints */}
      {[0, 1, 2, 3].map((i) => {
        const x = 68 + i * 51;
        return (
          <g key={`s-${i}`}>
            <rect x={x} y="128" width="46" height="32" rx="4" fill={card} />
            <rect x={x + 4} y="134" width="6" height="6" rx="1.5" fill={[down, up, warn, info][i]} opacity="0.9" />
            <rect x={x + 13} y="135" width="22" height="3" rx="1" fill={text} opacity="0.9" />
            <rect x={x + 13} y="141" width="14" height="2.5" rx="1" fill={muted} />
            <rect x={x + 4} y="150" width="38" height="6" rx="1.5" fill={raised} />
          </g>
        );
      })}
    </svg>
  );
}

function ModernPreviewSvg() {
  return (
    <svg viewBox="0 0 280 170" xmlns="http://www.w3.org/2000/svg" className="w-full rounded-md">
      <rect width="280" height="170" fill="#0d1117" rx="6" />
      <rect x="0" y="0" width="60" height="170" fill="#161b22" rx="6" />
      <rect x="60" y="0" width="1" height="170" fill="#30363d" />
      <rect x="10" y="12" width="16" height="16" rx="3" fill="#58a6ff" opacity="0.9" />
      <rect x="31" y="15" width="22" height="5" rx="2" fill="#8b949e" />
      {[40, 62, 84, 106].map((y, i) => (
        <g key={y}>
          <rect x="7" y={y} width="46" height="16" rx="3" fill={i === 0 ? '#1c2333' : 'transparent'} />
          <rect x="13" y={y + 4} width="8" height="8" rx="2" fill={i === 0 ? '#58a6ff' : '#6e7681'} />
          <rect x="25" y={y + 6} width={i === 0 ? 22 : 18} height="4" rx="2" fill={i === 0 ? '#e6edf3' : '#6e7681'} />
        </g>
      ))}
      <rect x="61" y="0" width="219" height="28" fill="#161b22" />
      <rect x="61" y="28" width="219" height="1" fill="#30363d" />
      {[0, 1, 2].map((i) => {
        const colors = ['#3b82f6', '#f85149', '#3b82f6'];
        const x = 70 + i * 69;
        return (
          <g key={i}>
            <rect x={x} y="68" width="62" height="50" rx="4" fill="#161b22" stroke="#30363d" strokeWidth="0.5" />
            <rect x={x} y="68" width="2.5" height="50" rx="2" fill={colors[i]} />
            <rect x={x + 7} y="76" width="6" height="6" rx="3" fill={colors[i]} />
            <rect x={x + 17} y="77" width={35} height="4" rx="2" fill="#e6edf3" />
            <rect x={x + 17} y="84" width="25" height="3" rx="2" fill="#6e7681" />
          </g>
        );
      })}
      <rect x="70" y="126" width="200" height="36" rx="4" fill="#161b22" stroke="#30363d" strokeWidth="0.5" />
      <rect x="78" y="143" width="90" height="3" rx="2" fill="#1c2333" />
      <rect x="78" y="143" width="55" height="3" rx="2" fill="#58a6ff" opacity="0.85" />
      <rect x="175" y="143" width="88" height="3" rx="2" fill="#1c2333" />
      <rect x="175" y="143" width="40" height="3" rx="2" fill="#a371f7" opacity="0.85" />
    </svg>
  );
}

function NeonPreviewSvg() {
  return (
    <svg viewBox="0 0 280 170" xmlns="http://www.w3.org/2000/svg" className="w-full rounded-md">
      <defs>
        <filter id="glow-cyan" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2.5" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id="glow-blue" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id="glow-red" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <rect width="280" height="170" fill="#070a0f" rx="6" />
      <rect x="0" y="0" width="60" height="170" fill="#0d1117" rx="6" />
      <rect x="60" y="0" width="1" height="170" fill="#1c2a3f" />
      <rect x="10" y="12" width="16" height="16" rx="3" fill="#00c8ff" opacity="0.85" filter="url(#glow-cyan)" />
      <rect x="31" y="15" width="22" height="5" rx="2" fill="#7899b8" />
      {[40, 62, 84, 106].map((y, i) => (
        <g key={y}>
          <rect x="7" y={y} width="46" height="16" rx="3" fill={i === 0 ? '#1a1f2e' : 'transparent'} />
          <rect x="13" y={y + 4} width="8" height="8" rx="2" fill={i === 0 ? '#00c8ff' : '#4a6a88'} filter={i === 0 ? 'url(#glow-cyan)' : undefined} />
          <rect x="25" y={y + 6} width={i === 0 ? 22 : 18} height="4" rx="2" fill={i === 0 ? '#e0f0ff' : '#4a6a88'} />
        </g>
      ))}
      <rect x="61" y="0" width="219" height="28" fill="#0d1117" />
      <rect x="61" y="28" width="219" height="1" fill="#1c2a3f" />
      {[0, 1, 2].map((i) => {
        const colors = ['#00a0ff', '#ff3860', '#00a0ff'];
        const filters = ['url(#glow-blue)', 'url(#glow-red)', 'url(#glow-blue)'];
        const x = 70 + i * 69;
        return (
          <g key={i}>
            <rect x={x} y="68" width="62" height="50" rx="4" fill="#0d1117" stroke="#1c2a3f" strokeWidth="0.5" />
            <rect x={x} y="68" width="2.5" height="50" rx="2" fill={colors[i]} filter={filters[i]} />
            <rect x={x + 7} y="76" width="6" height="6" rx="3" fill={colors[i]} filter={filters[i]} />
            <rect x={x + 17} y="77" width={35} height="4" rx="2" fill="#e0f0ff" />
            <rect x={x + 17} y="84" width="25" height="3" rx="2" fill="#4a6a88" />
          </g>
        );
      })}
      <rect x="70" y="126" width="200" height="36" rx="4" fill="#0d1117" stroke="#1c2a3f" strokeWidth="0.5" />
      <rect x="78" y="143" width="90" height="3" rx="2" fill="#111827" />
      <rect x="78" y="143" width="55" height="3" rx="2" fill="#00c8ff" opacity="0.9" filter="url(#glow-cyan)" />
      <rect x="175" y="143" width="88" height="3" rx="2" fill="#111827" />
      <rect x="175" y="143" width="40" height="3" rx="2" fill="#b06aff" opacity="0.9" />
    </svg>
  );
}

const THEMES: { id: AppTheme; labelKey: string; Preview: () => JSX.Element }[] = [
  { id: 'obli-operator', labelKey: 'account.obliOperator', Preview: ObliOperatorPreviewSvg },
  { id: 'obli-daylight', labelKey: 'account.obliDaylight', Preview: ObliDaylightPreviewSvg },
  { id: 'obli-dim',      labelKey: 'account.obliDim',      Preview: ObliDimPreviewSvg },
  { id: 'modern',        labelKey: 'account.modernUi',     Preview: ModernPreviewSvg },
  { id: 'neon',          labelKey: 'account.neonUi',       Preview: NeonPreviewSvg },
];

export function ThemePicker({ value, onChange }: ThemePickerProps) {
  const { t } = useTranslation();

  return (
    // 3 columns on xl: the three Obli themes (Operator, Daylight, Dim) share
    // the first row, the two legacy themes the second.
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 gap-4">
      {THEMES.map(({ id, labelKey, Preview }) => {
        const selected = value === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            className={cn(
              'group relative rounded-xl border-2 p-2 text-left transition-all',
              selected
                ? 'border-accent shadow-[0_0_0_1px_rgb(var(--c-accent)/0.3)]'
                : 'border-border hover:border-accent/40 hover:bg-bg-hover',
            )}
          >
            <div className={cn(
              'overflow-hidden rounded-lg ring-0 transition-all',
              selected ? 'ring-2 ring-accent/30' : 'group-hover:ring-1 group-hover:ring-accent/20',
            )}>
              <Preview />
            </div>
            <div className="mt-2.5 flex items-center justify-between px-1 pb-0.5">
              <span className={cn('text-sm font-semibold', selected ? 'text-accent' : 'text-text-secondary')}>
                {t(labelKey)}
              </span>
              {selected && (
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent">
                  <Check size={11} className="text-bg-primary" strokeWidth={3} />
                </span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
