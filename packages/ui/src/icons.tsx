// Inline SVG icons. All 14px default, currentColor. Ported verbatim from the
// prototype.

import type { ReactNode, CSSProperties } from 'react';

interface IconBaseProps {
  d: string | ReactNode;
  size?: number;
  sw?: number;
}

function Icon({ d, size = 14, sw = 1.6 }: IconBaseProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {typeof d === 'string' ? <path d={d} /> : d}
    </svg>
  );
}

export type IconProps = { size?: number };

export const Icons = {
  Bash: ({ size = 14 }: IconProps) => (
    <Icon size={size} d={<><path d="M2 3.5 5 7 2 10.5" /><path d="M7 11h5" /></>} />
  ),
  Read: ({ size = 14 }: IconProps) => (
    <Icon size={size} d={<><path d="M2.5 2.5h6l3 3v6h-9z" /><path d="M8.5 2.5v3h3" /></>} />
  ),
  Edit: ({ size = 14 }: IconProps) => (
    <Icon size={size} d="M2.5 11.5 9 5l-1.5-1.5L1 10v1.5h1.5zM8 4l1.5 1.5M10 3l1.5 1.5" />
  ),
  Write: ({ size = 14 }: IconProps) => (
    <Icon size={size} d={<><path d="M2.5 2.5h6l3 3v6h-9z" /><path d="M8.5 2.5v3h3" /><path d="M5 8.5h4M5 10.5h3" /></>} />
  ),
  Grep: ({ size = 14 }: IconProps) => (
    <Icon size={size} d={<><circle cx="6" cy="6" r="3.2" /><path d="M8.4 8.4 11 11" /></>} />
  ),
  Chevron: ({ size = 14, dir = 'down' }: IconProps & { dir?: 'right' | 'down' | 'up' | 'left' }) => {
    const rot = ({ right: 0, down: 90, up: -90, left: 180 } as const)[dir] ?? 0;
    return (
      <span style={{ display: 'inline-flex', transform: `rotate(${rot}deg)`, transition: 'transform .12s' }}>
        <Icon size={size} d="M5.5 3 9 7 5.5 11" />
      </span>
    );
  },
  Search: ({ size = 14 }: IconProps) => (
    <Icon size={size} d={<><circle cx="6" cy="6" r="3.5" /><path d="M8.5 8.5 11.5 11.5" /></>} />
  ),
  Clock: ({ size = 14 }: IconProps) => (
    <Icon size={size} d={<><circle cx="7" cy="7" r="5" /><path d="M7 4v3l2 1.5" /></>} />
  ),
  Coin: ({ size = 14 }: IconProps) => (
    <Icon size={size} d={<><circle cx="7" cy="7" r="5" /><path d="M5.5 5.5h2.5a1.2 1.2 0 010 2.4H5.5M5.5 8.5h3" /></>} />
  ),
  Folder: ({ size = 14 }: IconProps) => (
    <Icon size={size} d="M2 4a1 1 0 011-1h2.5L7 4.5h4a1 1 0 011 1V11a1 1 0 01-1 1H3a1 1 0 01-1-1z" />
  ),
  Hash: ({ size = 14 }: IconProps) => (
    <Icon size={size} d="M4.5 2v10M9.5 2v10M2 5.5h10M2 9.5h10" />
  ),
  Dot: ({ size = 8, color = 'currentColor' }: { size?: number; color?: string }) => (
    <span style={{ width: size, height: size, borderRadius: '50%', background: color, display: 'inline-block' } as CSSProperties} />
  ),
  Filter: ({ size = 14 }: IconProps) => (
    <Icon size={size} d="M2 3h10l-3.5 4v4l-3 1V7L2 3z" />
  ),
  Cmd: ({ size = 14 }: IconProps) => (
    <Icon size={size} sw={1.4} d="M4.5 4.5h5v5h-5zM4.5 4.5a1.5 1.5 0 11-1.5 1.5h1.5zM9.5 4.5a1.5 1.5 0 101.5 1.5H9.5M4.5 9.5a1.5 1.5 0 11-1.5-1.5h1.5zM9.5 9.5a1.5 1.5 0 101.5-1.5H9.5" />
  ),
};

export type IconName = keyof typeof Icons;
