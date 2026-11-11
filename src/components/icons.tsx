import type { SVGProps } from "react";

/**
 * Hand-drawn 20px icon set (1.5px stroke, geometric) so the product has a
 * consistent technical vocabulary rather than emoji or mixed icon libraries.
 */
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const IconGauge = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.2 14.8a8 8 0 1 1 13.6 0" />
    <path d="M10 11.5 13 8.5" />
    <circle cx="10" cy="12.4" r="1.1" />
  </Icon>
);

export const IconHistory = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 10a6.5 6.5 0 1 0 2-4.7" />
    <path d="M3.2 3.6v3.2h3.2" />
    <path d="M10 6.5V10l2.4 1.6" />
  </Icon>
);

export const IconMethod = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 3.5h8.5L16 7v9.5H4z" />
    <path d="M12 3.5V7h4" />
    <path d="M7 10.5h6M7 13.5h4" />
  </Icon>
);

export const IconShield = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 2.8 16 5v5c0 3.6-2.4 6.4-6 7.4-3.6-1-6-3.8-6-7.4V5z" />
    <path d="m7.4 9.9 1.8 1.8 3.4-3.7" />
  </Icon>
);

export const IconArrowRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 10h11" />
    <path d="m11 6 4 4-4 4" />
  </Icon>
);

export const IconChevronDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="m5.5 8 4.5 4.5L14.5 8" />
  </Icon>
);

export const IconChevronRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="m8 5.5 4.5 4.5L8 14.5" />
  </Icon>
);

export const IconMenu = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 6h13M3.5 10h13M3.5 14h13" />
  </Icon>
);

export const IconClose = (p: IconProps) => (
  <Icon {...p}>
    <path d="m5.5 5.5 9 9M14.5 5.5l-9 9" />
  </Icon>
);

export const IconScan = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 7V4.5A1.5 1.5 0 0 1 4.5 3H7M13 3h2.5A1.5 1.5 0 0 1 17 4.5V7M17 13v2.5a1.5 1.5 0 0 1-1.5 1.5H13M7 17H4.5A1.5 1.5 0 0 1 3 15.5V13" />
    <path d="M3 10h14" />
  </Icon>
);

export const IconAlert = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 3.2 17.4 16H2.6z" />
    <path d="M10 8v3.4M10 13.6v.1" />
  </Icon>
);

export const IconCheck = (p: IconProps) => (
  <Icon {...p}>
    <path d="m4.5 10.5 3.5 3.5 7.5-8" />
  </Icon>
);

export const IconMinus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 10h10" />
  </Icon>
);

export const IconExternal = (p: IconProps) => (
  <Icon {...p}>
    <path d="M11 4h5v5" />
    <path d="M16 4 9 11" />
    <path d="M15.5 12v3.5a.5.5 0 0 1-.5.5H4.5a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5H8" />
  </Icon>
);

export const IconLock = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4.5" y="8.5" width="11" height="8" rx="1.5" />
    <path d="M7 8.5V6.6a3 3 0 0 1 6 0v1.9" />
  </Icon>
);

export const IconCode = (p: IconProps) => (
  <Icon {...p}>
    <path d="m7 6.5-3.5 3.5L7 13.5M13 6.5l3.5 3.5L13 13.5M11.3 4.5l-2.6 11" />
  </Icon>
);

export const IconLayers = (p: IconProps) => (
  <Icon {...p}>
    <path d="m10 3 7 3.5-7 3.5-7-3.5z" />
    <path d="m3 10 7 3.5 7-3.5" />
    <path d="m3 13.5 7 3.5 7-3.5" />
  </Icon>
);

export const IconCookie = (p: IconProps) => (
  <Icon {...p}>
    <path d="M16.5 10.6A6.5 6.5 0 1 1 9.4 3.5a3 3 0 0 0 3.9 3.4 3 3 0 0 0 3.2 3.7Z" />
    <path d="M7.5 9.5h.1M9.5 13h.1M12.5 10.8h.1" />
  </Icon>
);

export const IconRoute = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="5" cy="15" r="2" />
    <circle cx="15" cy="5" r="2" />
    <path d="M15 7v3.5A2.5 2.5 0 0 1 12.5 13H7" />
  </Icon>
);

export const IconSignOut = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12.5 6V4.5a.5.5 0 0 0-.5-.5H4.5a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5H12a.5.5 0 0 0 .5-.5V14" />
    <path d="M9 10h8" />
    <path d="m14 7 3 3-3 3" />
  </Icon>
);

export const IconTrash = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 5.5h13" />
    <path d="M8 5.5V3.8h4v1.7" />
    <path d="M5 5.5 5.7 16a.5.5 0 0 0 .5.5h7.6a.5.5 0 0 0 .5-.5L15 5.5" />
  </Icon>
);

export const IconEye = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 10S5 4.8 10 4.8 17.5 10 17.5 10 15 15.2 10 15.2 2.5 10 2.5 10Z" />
    <circle cx="10" cy="10" r="2.2" />
  </Icon>
);

export const IconEyeOff = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.2 3.2l13.6 13.6" />
    <path d="M7.4 5.7A7.8 7.8 0 0 1 10 5.2c5 0 7.5 5.2 7.5 5.2a13 13 0 0 1-2.2 2.8" />
    <path d="M12.3 14.5a8.4 8.4 0 0 1-2.3.3c-5 0-7.5-5.2-7.5-5.2a13 13 0 0 1 2.6-3.2" />
    <path d="M8.6 8.6a2 2 0 0 0 2.8 2.8" />
  </Icon>
);

export const IconFilter = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 5h14l-5.5 6.2v4.6L8.5 17v-5.8z" />
  </Icon>
);

export const IconClock = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="10" cy="10" r="6.8" />
    <path d="M10 6.2V10l2.6 1.7" />
  </Icon>
);

export const IconTerminal = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.8" y="4" width="14.4" height="12" rx="1.5" />
    <path d="m6.5 8.5 2 1.9-2 1.9M10.5 12.6h3" />
  </Icon>
);
